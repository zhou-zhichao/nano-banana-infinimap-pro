import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { childrenOf, TILE, ZMAX } from "./coords";
import { db } from "./adapters/db.file";
import { blake2sHex, hashTilePayload } from "./hashing";
import { readTileFile, writeTileFile } from "./storage";
import { tileGridSizeAtZoom } from "./tilemaps/bounds";
import { MOON_HEIGHT, MOON_WIDTH } from "./tilemaps/constants";
import { TILEMAPS_PRESET_MOON_TILES_DIR } from "./tilemaps/paths";
import { getTilemapManifest } from "./tilemaps/service";
import { getTransparentTileBuffer } from "./transparentTile";
import type { ParentGenerationProgressUpdate } from "./parentGenerationProgress";
import { TimelineContext } from "./timeline/types";
import {
  markTimelineTileTombstone,
  readTimelineNodeMeta,
  resolveEffectiveTileBuffer,
  resolveEffectiveTileMeta,
  writeTimelineTileReady,
} from "./timeline/storage";

async function composeParentTile(childBuffers: (Buffer | null)[]) {
  const transparentTile = await getTransparentTileBuffer(TILE);
  const tiles = await Promise.all(
    childBuffers.map(async (buf) => {
      const input = buf ?? transparentTile;
      return sharp(input).resize(TILE, TILE, { fit: "fill" }).toBuffer();
    }),
  );

  try {
    const fullComposite = await sharp({
      create: {
        width: TILE * 2,
        height: TILE * 2,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite([
        { input: tiles[0], left: 0, top: 0 },
        { input: tiles[1], left: TILE, top: 0 },
        { input: tiles[2], left: 0, top: TILE },
        { input: tiles[3], left: TILE, top: TILE },
      ])
      .png()
      .toBuffer();

    return await sharp(fullComposite)
      .resize(TILE, TILE, { kernel: "lanczos3" })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return transparentTile;
  }
}

async function readBaselineChildBuffers(mapId: string, z: number, x: number, y: number) {
  const children = childrenOf(z, x, y);
  return Promise.all(children.map((child) => readTileFile(mapId, child.z, child.x, child.y)));
}

async function readTimelineChildBuffers(context: TimelineContext, z: number, x: number, y: number) {
  const children = childrenOf(z, x, y);
  return Promise.all(children.map((child) => resolveEffectiveTileBuffer(context, child.z, child.x, child.y)));
}

function hasAnyChildBuffers(childBuffers: (Buffer | null)[]) {
  return childBuffers.some((buffer) => buffer !== null);
}

function countTotalParentTilesForMap(width: number, height: number) {
  let totalTiles = 0;
  for (let z = ZMAX - 1; z >= 0; z--) {
    const divisor = 2 ** (ZMAX - z);
    totalTiles += Math.ceil(width / divisor) * Math.ceil(height / divisor);
  }
  return totalTiles;
}

export async function generateParentTile(
  mapId: string,
  z: number,
  x: number,
  y: number,
  childBuffers?: (Buffer | null)[],
): Promise<Buffer | null> {
  const resolvedChildBuffers = childBuffers ?? (await readBaselineChildBuffers(mapId, z, x, y));
  if (!hasAnyChildBuffers(resolvedChildBuffers)) return null;

  const parentTile = await composeParentTile(resolvedChildBuffers);
  await writeTileFile(mapId, z, x, y, parentTile);

  const bytesHash = blake2sHex(parentTile).slice(0, 16);
  const existing = await db.getTile(mapId, z, x, y);
  const contentVer = (existing?.contentVer ?? 0) + 1;
  const hash = hashTilePayload({
    algorithmVersion: 1,
    contentVer,
    bytesHash,
    seed: "parent",
  });

  await db.upsertTile(mapId, {
    z,
    x,
    y,
    status: "READY",
    hash,
    contentVer,
    seed: "parent",
  });

  return parentTile;
}

export async function generateParentTileAtNode(
  context: TimelineContext,
  z: number,
  x: number,
  y: number,
  childBuffers?: (Buffer | null)[],
): Promise<Buffer | null> {
  const resolvedChildBuffers = childBuffers ?? (await readTimelineChildBuffers(context, z, x, y));
  if (!hasAnyChildBuffers(resolvedChildBuffers)) {
    await markTimelineTileTombstone(context.mapId, context.node.id, z, x, y);
    return null;
  }

  const parentTile = await composeParentTile(resolvedChildBuffers);
  const bytesHash = blake2sHex(parentTile).slice(0, 16);
  const current = await readTimelineNodeMeta(context.mapId, context.node.id, z, x, y);
  const contentVer = (current?.contentVer ?? 0) + 1;
  const hash = hashTilePayload({
    algorithmVersion: 1,
    contentVer,
    bytesHash,
    seed: "parent",
  });

  await writeTimelineTileReady(context.mapId, context.node.id, z, x, y, parentTile, {
    hash,
    seed: "parent",
  });
  return parentTile;
}

type GenerateAllParentTilesOptions = {
  onProgress?: (progress: ParentGenerationProgressUpdate) => void;
};

export async function generateAllParentTiles(mapId: string, options: GenerateAllParentTilesOptions = {}) {
  const map = await getTilemapManifest(mapId);
  if (!map) throw new Error(`Tilemap "${mapId}" not found`);

  const totalTiles = countTotalParentTilesForMap(map.width, map.height);
  let processedTiles = 0;
  let generatedTiles = 0;
  let skippedTiles = 0;
  options.onProgress?.({
    totalTiles,
    processedTiles,
    generatedTiles,
    skippedTiles,
    currentZ: ZMAX - 1,
  });

  for (let z = ZMAX - 1; z >= 0; z--) {
    const { width, height } = tileGridSizeAtZoom(map, z);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const childBuffers = await readBaselineChildBuffers(mapId, z, x, y);
        if (hasAnyChildBuffers(childBuffers)) {
          await generateParentTile(mapId, z, x, y, childBuffers);
          generatedTiles += 1;
        } else {
          skippedTiles += 1;
        }
        processedTiles += 1;
        options.onProgress?.({
          totalTiles,
          processedTiles,
          generatedTiles,
          skippedTiles,
          currentZ: z,
        });
      }
    }
  }
}

export async function generateAllParentTilesAtNode(
  context: TimelineContext,
  options: GenerateAllParentTilesOptions = {},
) {
  const map = await getTilemapManifest(context.mapId);
  if (!map) throw new Error(`Tilemap "${context.mapId}" not found`);

  const totalTiles = countTotalParentTilesForMap(map.width, map.height);
  let processedTiles = 0;
  let generatedTiles = 0;
  let skippedTiles = 0;
  options.onProgress?.({
    totalTiles,
    processedTiles,
    generatedTiles,
    skippedTiles,
    currentZ: ZMAX - 1,
  });

  for (let z = ZMAX - 1; z >= 0; z--) {
    const { width, height } = tileGridSizeAtZoom(map, z);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const childBuffers = await readTimelineChildBuffers(context, z, x, y);
        const effectiveParentMeta = await resolveEffectiveTileMeta(context, z, x, y);
        const shouldRegenerate =
          hasAnyChildBuffers(childBuffers) ||
          effectiveParentMeta.status !== "EMPTY" ||
          effectiveParentMeta.sourceIndex !== null;

        if (shouldRegenerate) {
          const parentTile = await generateParentTileAtNode(context, z, x, y, childBuffers);
          if (parentTile) {
            generatedTiles += 1;
          } else {
            skippedTiles += 1;
          }
        } else {
          skippedTiles += 1;
        }

        processedTiles += 1;
        options.onProgress?.({
          totalTiles,
          processedTiles,
          generatedTiles,
          skippedTiles,
          currentZ: z,
        });
      }
    }
  }
}

function presetTilePath(z: number, x: number, y: number) {
  return path.join(TILEMAPS_PRESET_MOON_TILES_DIR, `${z}_${x}_${y}.webp`);
}

async function readPresetTileFile(z: number, x: number, y: number) {
  try {
    return await fs.readFile(presetTilePath(z, x, y));
  } catch {
    return null;
  }
}

export async function generateMoonPresetParentTiles() {
  await fs.mkdir(TILEMAPS_PRESET_MOON_TILES_DIR, { recursive: true });

  for (let z = ZMAX - 1; z >= 0; z--) {
    const divisor = 2 ** (ZMAX - z);
    const width = Math.ceil(MOON_WIDTH / divisor);
    const height = Math.ceil(MOON_HEIGHT / divisor);

    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const children = childrenOf(z, x, y);
        const childBuffers = await Promise.all(
          children.map((child) => readPresetTileFile(child.z, child.x, child.y)),
        );
        if (!childBuffers.some((buffer) => buffer !== null)) continue;

        const parentTile = await composeParentTile(childBuffers);
        await fs.writeFile(presetTilePath(z, x, y), parentTile);
      }
    }
  }
}
