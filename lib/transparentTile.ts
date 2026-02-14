import sharp from "sharp";
import { TILE } from "./coords";

const transparentTileCache = new Map<number, Promise<Buffer>>();

export function getTransparentTileBuffer(tileSize = TILE): Promise<Buffer> {
  const normalizedSize = Number.isFinite(tileSize) ? Math.max(1, Math.floor(tileSize)) : TILE;

  const cached = transparentTileCache.get(normalizedSize);
  if (cached) return cached;

  const created = sharp({
    create: {
      width: normalizedSize,
      height: normalizedSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .webp({ quality: 85 })
    .toBuffer();

  transparentTileCache.set(normalizedSize, created);
  return created;
}
