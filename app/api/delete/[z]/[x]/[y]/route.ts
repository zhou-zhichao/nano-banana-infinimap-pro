import { NextRequest, NextResponse } from "next/server";
import { ZMAX, parentOf } from "@/lib/coords";
import { shouldGenerateRealtimeParentTiles } from "@/lib/parentGenerationPolicy";
import { generateParentTileAtNode } from "@/lib/parentTiles";
import { isTileInBounds } from "@/lib/tilemaps/bounds";
import { MapContextError, resolveMapContext } from "@/lib/tilemaps/context";
import { parseTimelineIndexFromRequest, resolveTimelineContext } from "@/lib/timeline/context";
import { markTimelineTileTombstone } from "@/lib/timeline/storage";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
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

  if (z !== ZMAX) {
    return NextResponse.json({ error: "Only max zoom tiles can be deleted" }, { status: 400 });
  }
  if (!isTileInBounds(map, z, x, y)) {
    return NextResponse.json({ error: "Tile is outside map bounds" }, { status: 400 });
  }

  try {
    const timeline = await resolveTimelineContext(mapId, timelineIndex);
    await markTimelineTileTombstone(mapId, timeline.node.id, z, x, y);

    if (shouldGenerateRealtimeParentTiles(mapId, "delete")) {
      let cz = z;
      let cx = x;
      let cy = y;
      while (cz > 0) {
        const parent = parentOf(cz, cx, cy);
        await generateParentTileAtNode(timeline, parent.z, parent.x, parent.y);
        cz = parent.z;
        cx = parent.x;
        cy = parent.y;
      }
    }

    return NextResponse.json({ ok: true, message: "Tile deleted", timelineIndex: timeline.index });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to delete tile", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
