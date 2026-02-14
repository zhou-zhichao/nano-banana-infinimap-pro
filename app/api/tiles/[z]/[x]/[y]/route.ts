import { NextRequest, NextResponse } from "next/server";
import { blake2sHex } from "@/lib/hashing";
import { isTileInBounds } from "@/lib/tilemaps/bounds";
import { MapContextError, resolveMapContext } from "@/lib/tilemaps/context";
import { parseTimelineIndexFromRequest, resolveTimelineContext } from "@/lib/timeline/context";
import { resolveEffectiveTileBuffer } from "@/lib/timeline/storage";
import { getTransparentTileBuffer } from "@/lib/transparentTile";

export async function GET(req: NextRequest, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
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

  const { z: zStr, x: xStr, y: yStr } = await params;
  const z = Number(zStr);
  const x = Number(xStr);
  const y = Number(yStr);

  let body: Buffer | null = null;
  if (isTileInBounds(map, z, x, y)) {
    const timeline = await resolveTimelineContext(mapId, timelineIndex);
    body = await resolveEffectiveTileBuffer(timeline, z, x, y);
  }
  if (!body) {
    body = await getTransparentTileBuffer();
  }

  const etag = `"${blake2sHex(body).slice(0, 16)}"`;
  return new NextResponse(body as any, {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: etag,
    },
  });
}
