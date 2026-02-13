import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { TILE } from "@/lib/coords";
import { alignCompositeOverBase, translateImage } from "@/lib/drift";
import { resolveTimelineContextFromRequest } from "@/lib/timeline/context";
import { resolveEffectiveTileBuffer } from "@/lib/timeline/storage";

const TILE_SIZE = TILE;

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
  return sharp(buf, { raw: { width, height, channels: channels as 1 | 2 | 3 | 4 } }).png().toBuffer();
}

async function composite3x3(tiles: Buffer[][]): Promise<Buffer> {
  const gridSize = TILE_SIZE * 3;
  const overlays: sharp.OverlayOptions[] = [];
  for (let yy = 0; yy < 3; yy += 1) {
    for (let xx = 0; xx < 3; xx += 1) {
      overlays.push({ input: tiles[yy][xx], left: xx * TILE_SIZE, top: yy * TILE_SIZE });
    }
  }
  return sharp({
    create: {
      width: gridSize,
      height: gridSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(overlays).webp().toBuffer();
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const params = await context.params;
    const { id } = params;

    if (!/^preview-\d+-[-\d]+\.webp$/.test(`${id}.webp`)) {
      return NextResponse.json({ error: "Invalid preview ID" }, { status: 400 });
    }

    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") || "raw";
    const align = url.searchParams.get("align") !== "0";
    const txParam = url.searchParams.get("tx");
    const tyParam = url.searchParams.get("ty");
    const tx = txParam != null ? parseInt(txParam, 10) || 0 : null;
    const ty = tyParam != null ? parseInt(tyParam, 10) || 0 : null;
    const timeline = await resolveTimelineContextFromRequest(req);

    const previewPath = path.join(process.cwd(), ".temp", `${id}.webp`);
    let raw: Buffer;
    try {
      raw = await fs.readFile(previewPath);
    } catch {
      return NextResponse.json({ error: "Preview not found" }, { status: 404 });
    }

    if (mode !== "blended") {
      return new NextResponse(raw as any, {
        headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=60" },
      });
    }

    const parts = id.split("-");
    const z = parseInt(parts[1], 10);
    const cx = parseInt(parts[2], 10);
    const cy = parseInt(parts[3], 10);
    const gridSize = TILE_SIZE * 3;
    const mask = await createCircularGradientMask(gridSize);

    const baseTiles: Buffer[][] = [];
    for (let gy = 0; gy < 3; gy += 1) {
      const row: Buffer[] = [];
      for (let gx = 0; gx < 3; gx += 1) {
        const tileX = cx + gx - 1;
        const tileY = cy + gy - 1;
        const existing = await resolveEffectiveTileBuffer(timeline, z, tileX, tileY);
        if (existing) {
          row.push(await sharp(existing).resize(TILE_SIZE, TILE_SIZE, { fit: "fill" }).png().toBuffer());
        } else {
          row.push(await sharp({
            create: {
              width: TILE_SIZE,
              height: TILE_SIZE,
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 0 },
            },
          }).png().toBuffer());
        }
      }
      baseTiles.push(row);
    }
    const baseComposite = await composite3x3(baseTiles);

    let effectiveRaw = raw;
    if (tx != null && ty != null) {
      effectiveRaw = await translateImage(raw, gridSize, gridSize, tx, ty);
    } else if (align) {
      try {
        const { aligned } = await alignCompositeOverBase(baseComposite, raw, TILE_SIZE);
        effectiveRaw = aligned;
      } catch {
        effectiveRaw = raw;
      }
    }

    const output: Buffer[][] = [];
    for (let dy = 0; dy < 3; dy += 1) {
      const row: Buffer[] = [];
      for (let dx = 0; dx < 3; dx += 1) {
        const tileX = cx + dx - 1;
        const tileY = cy + dy - 1;
        const existing = await resolveEffectiveTileBuffer(timeline, z, tileX, tileY);
        const rawTile = await sharp(effectiveRaw)
          .extract({ left: dx * TILE_SIZE, top: dy * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE })
          .webp()
          .toBuffer();

        if (existing) {
          const tileMask = await sharp(mask)
            .extract({ left: dx * TILE_SIZE, top: dy * TILE_SIZE, width: TILE_SIZE, height: TILE_SIZE })
            .png()
            .toBuffer();
          const masked = await sharp(rawTile)
            .composite([{ input: tileMask, blend: "dest-in" }])
            .webp()
            .toBuffer();
          const blended = await sharp(existing)
            .resize(TILE_SIZE, TILE_SIZE, { fit: "fill" })
            .composite([{ input: masked, blend: "over" }])
            .webp()
            .toBuffer();
          row.push(blended);
        } else {
          row.push(rawTile);
        }
      }
      output.push(row);
    }

    const blendedComposite = await composite3x3(output);
    return new NextResponse(blendedComposite as any, {
      headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=60" },
    });
  } catch (error) {
    console.error("Preview fetch error:", error);
    return NextResponse.json({ error: "Failed to fetch preview" }, { status: 500 });
  }
}

