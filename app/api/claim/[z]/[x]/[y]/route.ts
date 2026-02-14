import { NextRequest, NextResponse } from "next/server";
import { z as zod } from "zod";
import { fileQueue } from "@/lib/adapters/queue.file";
import { ZMAX } from "@/lib/coords";
import { DEFAULT_MODEL_VARIANT, MODEL_VARIANTS } from "@/lib/modelVariant";
import { PythonImageServiceError } from "@/lib/pythonImageService";
import { isTileInBounds } from "@/lib/tilemaps/bounds";
import { MapContextError, resolveMapContext } from "@/lib/tilemaps/context";
import { parseTimelineIndexFromRequest, resolveTimelineContext } from "@/lib/timeline/context";
import { markTimelineTilePending, resolveEffectiveTileMeta } from "@/lib/timeline/storage";

const Body = zod.object({
  prompt: zod.string().min(1, "Prompt is required").max(500),
  modelVariant: zod.enum(MODEL_VARIANTS).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
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
  if (z !== ZMAX) return NextResponse.json({ error: "Only max zoom can be claimed" }, { status: 400 });
  if (!isTileInBounds(map, z, x, y)) return NextResponse.json({ error: "Tile is outside map bounds" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid input" }, { status: 400 });
  }
  const { prompt, modelVariant = DEFAULT_MODEL_VARIANT } = parsed.data;

  try {
    const timeline = await resolveTimelineContext(mapId, timelineIndex);
    const existing = await resolveEffectiveTileMeta(timeline, z, x, y);
    if (existing.status === "PENDING") {
      return NextResponse.json({
        ok: true,
        status: "ALREADY_PENDING",
        message: "Tile generation already in progress",
        timelineIndex: timeline.index,
      });
    }

    await markTimelineTilePending(mapId, timeline.node.id, z, x, y);
    await fileQueue.enqueue(`gen-${timeline.node.id}-${z}-${x}-${y}`, {
      mapId,
      z,
      x,
      y,
      prompt,
      modelVariant,
      timelineNodeId: timeline.node.id,
    });
    return NextResponse.json({ ok: true, status: "ENQUEUED", timelineIndex: timeline.index });
  } catch (error) {
    const headers: Record<string, string> = {};
    if (error instanceof PythonImageServiceError && error.statusCode) {
      if (error.retryAfterSeconds && error.retryAfterSeconds > 0) {
        headers["Retry-After"] = String(error.retryAfterSeconds);
      }
      return NextResponse.json(
        { error: error.message || "Generation rate-limited" },
        { status: error.statusCode, headers },
      );
    }
    return NextResponse.json(
      { error: "Failed to start generation", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
