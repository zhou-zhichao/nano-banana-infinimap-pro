import { NextRequest, NextResponse } from "next/server";
import { z as zod } from "zod";
import { ZMAX } from "@/lib/coords";
import { fileQueue } from "@/lib/adapters/queue.file";
import { DEFAULT_MODEL_VARIANT, MODEL_VARIANTS } from "@/lib/modelVariant";
import { resolveTimelineContextFromRequest } from "@/lib/timeline/context";
import { markTimelineTilePending, resolveEffectiveTileMeta } from "@/lib/timeline/storage";

const Body = zod.object({
  prompt: zod.string().min(1, "Prompt is required").max(500),
  modelVariant: zod.enum(MODEL_VARIANTS).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z: zStr, x: xStr, y: yStr } = await params;
  const z = Number(zStr);
  const x = Number(xStr);
  const y = Number(yStr);
  const timeline = await resolveTimelineContextFromRequest(req);

  if (z !== ZMAX) {
    return NextResponse.json({ error: "Only max zoom can be claimed" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return NextResponse.json({ error: firstError?.message || "Invalid input" }, { status: 400 });
  }
  const { prompt, modelVariant = DEFAULT_MODEL_VARIANT } = parsed.data;

  const existing = await resolveEffectiveTileMeta(timeline, z, x, y);
  if (existing.status === "PENDING") {
    return NextResponse.json({
      ok: true,
      status: "ALREADY_PENDING",
      message: "Tile generation already in progress",
      timelineIndex: timeline.index,
    });
  }

  try {
    await markTimelineTilePending(timeline.node.id, z, x, y);
    await fileQueue.enqueue(`gen-${timeline.node.id}-${z}-${x}-${y}`, {
      z,
      x,
      y,
      prompt,
      modelVariant,
      timelineNodeId: timeline.node.id,
    });
    return NextResponse.json({ ok: true, status: "ENQUEUED", timelineIndex: timeline.index });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to start generation",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

