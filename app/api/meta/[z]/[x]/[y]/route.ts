import { NextResponse } from "next/server";
import { resolveTimelineContextFromRequest } from "@/lib/timeline/context";
import { resolveEffectiveTileMeta } from "@/lib/timeline/storage";

export async function GET(req: Request, { params }:{params:Promise<{z:string,x:string,y:string}>}) {
  const { z: zStr, x: xStr, y: yStr } = await params;
  const z = Number(zStr), x = Number(xStr), y = Number(yStr);
  const timeline = await resolveTimelineContextFromRequest(req);
  const meta = await resolveEffectiveTileMeta(timeline, z, x, y);
  return NextResponse.json({
    status: meta.status,
    hash: meta.hash,
    updatedAt: meta.updatedAt,
    timelineIndex: timeline.index,
  });
}
