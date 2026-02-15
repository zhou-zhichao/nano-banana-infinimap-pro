import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { z } from "zod";
import { parentOf, TILE } from "@/lib/coords";
import { estimateGridDriftFromExistingTiles, translateImage } from "@/lib/drift";
import { blake2sHex } from "@/lib/hashing";
import { shouldGenerateRealtimeParentTiles } from "@/lib/parentGenerationPolicy";
import { generateParentTileAtNode } from "@/lib/parentTiles";
import { isTileInBounds } from "@/lib/tilemaps/bounds";
import { MapContextError, resolveMapContext } from "@/lib/tilemaps/context";
import { parseTimelineIndexFromRequest, resolveTimelineContext } from "@/lib/timeline/context";
import { resolveEffectiveTileBuffer, writeTimelineTileReady } from "@/lib/timeline/storage";

const requestSchema = z.object({
  previewUrl: z.string(),
  previewMode: z.enum(["raw", "blended"]).optional(),
  applyToAllNew: z.boolean().optional(),
  newTilePositions: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  selectedPositions: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
});

type PreviewMeta = {
  mapId: string;
  z: number;
  x: number;
  y: number;
  timelineNodeId: string;
  timelineIndex: number;
  createdAt: string;
};

async function extractTiles(compositeBuffer: Buffer): Promise<Buffer[][]> {
  const tiles: Buffer[][] = [];
  for (let yy = 0; yy < 3; yy++) {
    const row: Buffer[] = [];
    for (let xx = 0; xx < 3; xx++) {
      const tile = await sharp(compositeBuffer)
        .extract({ left: xx * TILE, top: yy * TILE, width: TILE, height: TILE })
        .webp()
        .toBuffer();
      row.push(tile);
    }
    tiles.push(row);
  }
  return tiles;
}

async function createCircularGradientMask(size: number): Promise<Buffer> {
  const center = size / 2;
  const radius = size / 2;
  const width = size;
  const height = size;
  const channels = 4;
  const buf = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - center;
      const dy = y - center;
      const d = Math.sqrt(dx * dx + dy * dy);
      let alpha = 0;
      if (d <= radius * 0.5) alpha = 255;
      else if (d < radius) alpha = Math.round(255 * (1 - (d - radius * 0.5) / (radius * 0.5)));
      const index = (y * width + x) * channels;
      buf[index] = 255;
      buf[index + 1] = 255;
      buf[index + 2] = 255;
      buf[index + 3] = alpha;
    }
  }
  return sharp(buf, { raw: { width, height, channels: channels as 4 } }).png().toBuffer();
}

function previewIdFromUrl(previewUrl: string) {
  const match = previewUrl.match(/\/api\/preview\/([a-zA-Z0-9-]+)/);
  return match?.[1] ?? null;
}

async function readPreviewMeta(tempDir: string, previewId: string): Promise<PreviewMeta> {
  const raw = await fs.readFile(path.join(tempDir, `${previewId}.json`), "utf-8");
  return JSON.parse(raw) as PreviewMeta;
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ z: string; x: string; y: string }> },
) {
  let mapId = "default";
  let map: any = null;
  let timelineIndex = 1;

  try {
    const resolved = await resolveMapContext(req);
    mapId = resolved.mapId;
    map = resolved.map;
    timelineIndex = parseTimelineIndexFromRequest(req);
  } catch (error) {
    if (error instanceof MapContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to resolve map context" }, { status: 500 });
  }

  try {
    const params = await context.params;
    const z = Number(params.z);
    const centerX = Number(params.x);
    const centerY = Number(params.y);
    if (!isTileInBounds(map, z, centerX, centerY)) {
      return NextResponse.json({ error: "Tile is outside map bounds" }, { status: 400 });
    }

    const timeline = await resolveTimelineContext(mapId, timelineIndex);
    const body = await req.json();
    const { previewUrl, previewMode, applyToAllNew, newTilePositions, selectedPositions, offsetX, offsetY } =
      requestSchema.parse(body);
    const effectivePreviewMode = previewMode ?? "blended";
    const selectedSet =
      effectivePreviewMode === "blended" && selectedPositions && selectedPositions.length > 0
        ? new Set(selectedPositions.map((position) => `${position.x},${position.y}`))
        : null;

    const previewId = previewIdFromUrl(previewUrl);
    if (!previewId) {
      return NextResponse.json({ error: "Invalid preview URL" }, { status: 400 });
    }

    const tempDir = path.join(process.cwd(), ".temp");
    const previewPath = path.join(tempDir, `${previewId}.webp`);
    const previewMeta = await readPreviewMeta(tempDir, previewId);
    if (previewMeta.mapId !== mapId) {
      return NextResponse.json({ error: "Preview map mismatch" }, { status: 400 });
    }
    if (previewMeta.z !== z || previewMeta.x !== centerX || previewMeta.y !== centerY) {
      return NextResponse.json({ error: "Preview coordinate mismatch" }, { status: 400 });
    }
    if (previewMeta.timelineNodeId !== timeline.node.id) {
      return NextResponse.json({ error: "Preview timeline mismatch" }, { status: 400 });
    }

    let compositeBuffer: Buffer;
    try {
      compositeBuffer = await fs.readFile(previewPath);
    } catch {
      return NextResponse.json({ error: "Preview not found" }, { status: 404 });
    }

    const gridSize = TILE * 3;
    compositeBuffer = await sharp(compositeBuffer).png().toBuffer();

    let driftCorrection: {
      source: "manual" | "auto" | "none";
      tx: number;
      ty: number;
      candidateCount: number;
      confidence: number;
    } = {
      source: "none",
      tx: 0,
      ty: 0,
      candidateCount: 0,
      confidence: 0,
    };

    if (effectivePreviewMode === "blended") {
      if (
        typeof offsetX === "number" &&
        typeof offsetY === "number" &&
        Number.isFinite(offsetX) &&
        Number.isFinite(offsetY)
      ) {
        const tx = Math.round(offsetX);
        const ty = Math.round(offsetY);
        compositeBuffer = await translateImage(compositeBuffer, gridSize, gridSize, tx, ty);
        driftCorrection = { source: "manual", tx, ty, candidateCount: 0, confidence: 1 };
      } else {
        let hasSelectedExisting = false;
        outer: for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const tileX = centerX + dx;
            const tileY = centerY + dy;
            if (!isTileInBounds(map, z, tileX, tileY)) continue;
            const key = `${tileX},${tileY}`;
            if (selectedSet && !selectedSet.has(key)) continue;
            const existing = await resolveEffectiveTileBuffer(timeline, z, tileX, tileY);
            if (existing) {
              hasSelectedExisting = true;
              break outer;
            }
          }
        }

        if (hasSelectedExisting) {
          try {
            const estimated = await estimateGridDriftFromExistingTiles({
              rawComposite: compositeBuffer,
              z,
              centerX,
              centerY,
              selectedSet,
              tileSize: TILE,
              readTile: (tileZ, tileX, tileY) => resolveEffectiveTileBuffer(timeline, tileZ, tileX, tileY),
            });

            driftCorrection = {
              source: estimated.source,
              tx: estimated.applied ? estimated.tx : 0,
              ty: estimated.applied ? estimated.ty : 0,
              candidateCount: estimated.candidateCount,
              confidence: estimated.confidence,
            };
            if (estimated.applied) {
              compositeBuffer = await translateImage(compositeBuffer, gridSize, gridSize, estimated.tx, estimated.ty);
            }
          } catch (driftErr) {
            console.warn("Auto drift estimation failed:", driftErr);
          }
        }
      }
    }

    const generatedTiles = await extractTiles(compositeBuffer);
    const mask3x3 = effectivePreviewMode === "blended" ? await createCircularGradientMask(TILE * 3) : null;
    const updatedPositions: { x: number; y: number }[] = [];

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tileX = centerX + dx;
        const tileY = centerY + dy;
        if (!isTileInBounds(map, z, tileX, tileY)) continue;

        const key = `${tileX},${tileY}`;
        const existingBuffer = await resolveEffectiveTileBuffer(timeline, z, tileX, tileY);
        const exists = Boolean(existingBuffer);

        if (effectivePreviewMode === "blended") {
          if (selectedSet && !selectedSet.has(key)) continue;
          if (
            !selectedSet &&
            !exists &&
            !(applyToAllNew && newTilePositions && newTilePositions.length > 0) &&
            !(dx === 0 && dy === 0)
          ) {
            continue;
          }
        }

        let finalTile = generatedTiles[dy + 1][dx + 1];
        if (effectivePreviewMode === "blended" && exists && existingBuffer && mask3x3) {
          const tileMask = await sharp(mask3x3)
            .extract({ left: (dx + 1) * TILE, top: (dy + 1) * TILE, width: TILE, height: TILE })
            .png()
            .toBuffer();
          const maskedGenerated = await sharp(finalTile).composite([{ input: tileMask, blend: "dest-in" }]).webp().toBuffer();
          finalTile = await sharp(existingBuffer)
            .resize(TILE, TILE, { fit: "fill" })
            .composite([{ input: maskedGenerated, blend: "over" }])
            .webp()
            .toBuffer();
        }

        const hash = blake2sHex(finalTile);
        await writeTimelineTileReady(mapId, timeline.node.id, z, tileX, tileY, finalTile, { hash });
        updatedPositions.push({ x: tileX, y: tileY });
      }
    }

    if (shouldGenerateRealtimeParentTiles(mapId, "confirm-edit")) {
      let levelZ = z;
      let currentLevel = new Set(updatedPositions.map((position) => `${position.x},${position.y}`));
      while (levelZ > 0 && currentLevel.size > 0) {
        const parents = new Map<string, { x: number; y: number }>();
        for (const key of currentLevel) {
          const [cx, cy] = key.split(",").map(Number);
          const parent = parentOf(levelZ, cx, cy);
          if (!isTileInBounds(map, levelZ - 1, parent.x, parent.y)) continue;
          parents.set(`${parent.x},${parent.y}`, { x: parent.x, y: parent.y });
        }

        for (const parent of parents.values()) {
          await generateParentTileAtNode(timeline, levelZ - 1, parent.x, parent.y);
        }

        currentLevel = new Set(Array.from(parents.keys()));
        levelZ -= 1;
      }
    }

    await fs.unlink(previewPath).catch(() => {});
    await fs.unlink(path.join(tempDir, `${previewId}.json`)).catch(() => {});

    return NextResponse.json({
      success: true,
      message: "Tiles updated successfully",
      driftCorrection,
      timelineIndex: timeline.index,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to confirm edit" },
      { status: 500 },
    );
  }
}
