import { NextRequest, NextResponse } from "next/server";
import { ZMAX, parentOf } from "@/lib/coords";
import { generateParentTileAtNode } from "@/lib/parentTiles";
import { resolveTimelineContextFromRequest } from "@/lib/timeline/context";
import { markTimelineTileTombstone } from "@/lib/timeline/storage";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ z: string; x: string; y: string }> },
) {
  const { z: zStr, x: xStr, y: yStr } = await params;
  const z = Number(zStr);
  const x = Number(xStr);
  const y = Number(yStr);
  const timeline = await resolveTimelineContextFromRequest(req);

  if (z !== ZMAX) {
    return NextResponse.json({ error: "Only max zoom tiles can be deleted" }, { status: 400 });
  }

  try {
    await markTimelineTileTombstone(timeline.node.id, z, x, y);

    let cz = z;
    let cx = x;
    let cy = y;
    while (cz > 0) {
      const p = parentOf(cz, cx, cy);
      await generateParentTileAtNode(timeline, p.z, p.x, p.y);
      cz = p.z;
      cx = p.x;
      cy = p.y;
    }

    return NextResponse.json({ ok: true, message: "Tile deleted", timelineIndex: timeline.index });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to delete tile",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

