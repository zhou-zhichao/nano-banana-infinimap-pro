import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { TILE, ZMAX, childrenOf } from "./coords";
import { readTileFile, writeTileFile } from "./storage";
import { db } from "./adapters/db.file";
import { blake2sHex, hashTilePayload } from "./hashing";
import { TimelineContext } from "./timeline/types";
import {
  markTimelineTileTombstone,
  resolveEffectiveTileBuffer,
  writeTimelineTileReady,
} from "./timeline/storage";

const DEFAULT_PATH = process.env.DEFAULT_TILE_PATH ?? "./public/default-tile.webp";

async function composeParentTile(childBuffers: (Buffer | null)[]) {
  const defaultTile = await fs.readFile(path.resolve(DEFAULT_PATH));
  const tiles = childBuffers.map((buf) => buf ?? defaultTile);

  const topRow = await sharp(tiles[0])
    .resize(TILE, TILE, { fit: "fill" })
    .extend({ right: TILE })
    .composite([{
      input: await sharp(tiles[1]).resize(TILE, TILE, { fit: "fill" }).toBuffer(),
      left: TILE,
      top: 0,
    }])
    .toBuffer();

  const bottomRow = await sharp(tiles[2])
    .resize(TILE, TILE, { fit: "fill" })
    .extend({ right: TILE })
    .composite([{
      input: await sharp(tiles[3]).resize(TILE, TILE, { fit: "fill" }).toBuffer(),
      left: TILE,
      top: 0,
    }])
    .toBuffer();

  const fullComposite = await sharp(topRow)
    .extend({ bottom: TILE })
    .composite([{
      input: bottomRow,
      left: 0,
      top: TILE,
    }])
    .toBuffer();

  return sharp(fullComposite)
    .resize(TILE, TILE, { kernel: "lanczos3" })
    .webp({ quality: 85 })
    .toBuffer();
}

export async function generateParentTile(z: number, x: number, y: number): Promise<Buffer | null> {
  const children = childrenOf(z, x, y);
  const childBuffers = await Promise.all(
    children.map((child) => readTileFile(child.z, child.x, child.y)),
  );

  const hasChildren = childBuffers.some((b) => b !== null);
  if (!hasChildren) {
    return null;
  }

  const parentTile = await composeParentTile(childBuffers);
  await writeTileFile(z, x, y, parentTile);

  const bytesHash = blake2sHex(parentTile).slice(0, 16);
  const existing = await db.getTile(z, x, y);
  const contentVer = (existing?.contentVer ?? 0) + 1;
  const hash = hashTilePayload({
    algorithmVersion: 1,
    contentVer,
    bytesHash,
    seed: "parent",
  });

  await db.upsertTile({
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
): Promise<Buffer | null> {
  const children = childrenOf(z, x, y);
  const childBuffers = await Promise.all(
    children.map((child) => resolveEffectiveTileBuffer(context, child.z, child.x, child.y)),
  );

  const hasChildren = childBuffers.some((b) => b !== null);
  if (!hasChildren) {
    await markTimelineTileTombstone(context.node.id, z, x, y);
    return null;
  }

  const parentTile = await composeParentTile(childBuffers);
  const bytesHash = blake2sHex(parentTile).slice(0, 16);
  const hash = hashTilePayload({
    algorithmVersion: 1,
    contentVer: 1,
    bytesHash,
    seed: "parent",
  });
  await writeTimelineTileReady(context.node.id, z, x, y, parentTile, {
    hash,
    seed: "parent",
  });
  return parentTile;
}

export async function generateAllParentTiles() {
  console.log("Regenerating all parent tiles from max-zoom children");

  // Start at one below max zoom and work down to 0.
  for (let z = ZMAX - 1; z >= 0; z -= 1) {
    console.log(`Processing zoom level ${z}`);

    const tilesPerSide = 1 << z;
    let regenerated = 0;

    for (let x = 0; x < tilesPerSide; x += 1) {
      for (let y = 0; y < tilesPerSide; y += 1) {
        const children = childrenOf(z, x, y);
        const hasChildren = await Promise.all(
          children.map((child) => readTileFile(child.z, child.x, child.y)),
        ).then((buffers) => buffers.some((b) => b !== null));

        if (hasChildren) {
          await generateParentTile(z, x, y);
          regenerated += 1;
        }
      }
    }

    console.log(`Regenerated ${regenerated} parent tiles at zoom ${z}`);
  }
}

