import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import fs from "fs/promises";
import path from "path";
import { TILE, parentOf } from "@/lib/coords";
import { blake2sHex } from "@/lib/hashing";
import { generateParentTileAtNode } from "@/lib/parentTiles";
import { estimateGridDriftFromExistingTiles, translateImage } from "@/lib/drift";
import { resolveTimelineContextFromRequest } from "@/lib/timeline/context";
import {
  resolveEffectiveTileBuffer,
  writeTimelineTileReady,
} from "@/lib/timeline/storage";

const TILE_SIZE = TILE;

const requestSchema = z.object({
  previewUrl: z.string(),
  applyToAllNew: z.boolean().optional(),
  newTilePositions: z.array(z.object({
    x: z.number(),
    y: z.number(),
  })).optional(),
  selectedPositions: z.array(z.object({
    x: z.number(),
    y: z.number(),
  })).optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
});

async function extractTiles(compositeBuffer: Buffer): Promise<Buffer[][]> {
  const tiles: Buffer[][] = [];
  for (let y = 0; y < 3; y += 1) {
    const row: Buffer[] = [];
    for (let x = 0; x < 3; x += 1) {
      const tile = await sharp(compositeBuffer)
        .extract({
          left: x * TILE_SIZE,
          top: y * TILE_SIZE,
          width: TILE_SIZE,
          height: TILE_SIZE,
        })
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
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - center;
      const dy = y - center;
      const d = Math.sqrt(dx * dx + dy * dy);
      let a: number;
      if (d <= radius * 0.5) a = 255;
      else if (d >= radius) a = 0;
      else a = Math.round(255 * (1 - (d - radius * 0.5) / (radius * 0.5)));
      const i = (y * width + x) * channels;
      buf[i] = 255;
      buf[i + 1] = 255;
      buf[i + 2] = 255;
      buf[i + 3] = a;
    }
  }
  return sharp(buf, { raw: { width, height, channels: channels as 4 } }).png().toBuffer();
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ z: string; x: string; y: string }> },
) {
  try {
    const params = await context.params;
    const z = parseInt(params.z, 10);
    const centerX = parseInt(params.x, 10);
    const centerY = parseInt(params.y, 10);
    const timeline = await resolveTimelineContextFromRequest(req);

    const body = await req.json();
    const { previewUrl, applyToAllNew, newTilePositions, selectedPositions, offsetX, offsetY } = requestSchema.parse(body);
    const selectedSet = selectedPositions && selectedPositions.length > 0
      ? new Set(selectedPositions.map((p) => `${p.x},${p.y}`))
      : null;

    const previewMatch = previewUrl.match(/\/api\/preview\/(preview-[\d-]+)/);
    if (!previewMatch) {
      return NextResponse.json({ error: "Invalid preview URL" }, { status: 400 });
    }

    const previewId = previewMatch[1];
    const previewPath = path.join(process.cwd(), ".temp", `${previewId}.webp`);

    let compositeBuffer: Buffer;
    try {
      compositeBuffer = await fs.readFile(previewPath);
    } catch {
      return NextResponse.json({ error: "Preview not found" }, { status: 404 });
    }

    const gridSize = TILE_SIZE * 3;
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

    if (typeof offsetX === "number" && typeof offsetY === "number" && Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
      const tx = Math.round(offsetX);
      const ty = Math.round(offsetY);
      compositeBuffer = await translateImage(compositeBuffer, gridSize, gridSize, tx, ty);
      driftCorrection = {
        source: "manual",
        tx,
        ty,
        candidateCount: 0,
        confidence: 1,
      };
    } else {
      let hasSelectedExisting = false;
      outer: for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const tileX = centerX + dx;
          const tileY = centerY + dy;
          const key = `${tileX},${tileY}`;
          if (selectedSet && !selectedSet.has(key)) continue;
          const existsBuf = await resolveEffectiveTileBuffer(timeline, z, tileX, tileY);
          if (existsBuf) {
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
            tileSize: TILE_SIZE,
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

    const genTiles = await extractTiles(compositeBuffer);
    const mask3x3 = await createCircularGradientMask(TILE_SIZE * 3);

    const updatedPositions: { x: number; y: number }[] = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const tileX = centerX + dx;
        const tileY = centerY + dy;
        const genTile = genTiles[dy + 1][dx + 1];

        const existsBuf = await resolveEffectiveTileBuffer(timeline, z, tileX, tileY);
        const exists = !!existsBuf;

        if (selectedSet && !selectedSet.has(`${tileX},${tileY}`)) {
          continue;
        }
        if (
          !selectedSet &&
          !exists &&
          !(applyToAllNew && newTilePositions && newTilePositions.length > 0) &&
          !(dx === 0 && dy === 0)
        ) {
          continue;
        }

        let finalTile: Buffer = genTile;
        if (exists && existsBuf) {
          const tileMask = await sharp(mask3x3)
            .extract({ left: (dx + 1) * TILE_SIZE, top: (dy + 1) * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE })
            .png()
            .toBuffer();
          const maskedGen = await sharp(genTile).composite([{ input: tileMask, blend: "dest-in" }]).webp().toBuffer();
          finalTile = await sharp(existsBuf)
            .resize(TILE_SIZE, TILE_SIZE, { fit: "fill" })
            .composite([{ input: maskedGen, blend: "over" }])
            .webp()
            .toBuffer();
        }

        const hash = blake2sHex(finalTile);
        await writeTimelineTileReady(timeline.node.id, z, tileX, tileY, finalTile, { hash });
        updatedPositions.push({ x: tileX, y: tileY });
      }
    }

    let levelZ = z;
    let currentLevel = new Set(updatedPositions.map((p) => `${p.x},${p.y}`));
    while (levelZ > 0 && currentLevel.size > 0) {
      const parents = new Map<string, { x: number; y: number }>();
      for (const key of currentLevel) {
        const [cx, cy] = key.split(",").map(Number);
        const p = parentOf(levelZ, cx, cy);
        parents.set(`${p.x},${p.y}`, { x: p.x, y: p.y });
      }

      for (const p of parents.values()) {
        await generateParentTileAtNode(timeline, levelZ - 1, p.x, p.y);
      }

      currentLevel = new Set(Array.from(parents.keys()));
      levelZ -= 1;
    }

    await fs.unlink(previewPath).catch(() => {});

    return NextResponse.json({
      success: true,
      message: "Tiles updated successfully",
      driftCorrection,
      timelineIndex: timeline.index,
    });
  } catch (error) {
    console.error("Confirm edit error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to confirm edit" },
      { status: 500 },
    );
  }
}

