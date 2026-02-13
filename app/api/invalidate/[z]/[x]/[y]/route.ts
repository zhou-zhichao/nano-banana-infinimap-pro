import { NextRequest, NextResponse } from "next/server";
import { z as zod } from "zod";
import { DEFAULT_MODEL_VARIANT, MODEL_VARIANTS } from "@/lib/modelVariant";
import { fileQueue } from "@/lib/adapters/queue.file";
import { resolveTimelineContextFromRequest } from "@/lib/timeline/context";
import { markTimelineTilePending, resolveEffectiveTileMeta } from "@/lib/timeline/storage";
import { ZMAX } from "@/lib/coords";

const requestSchema = zod.object({
  prompt: zod.string().min(1, "Prompt is required"),
  modelVariant: zod.enum(MODEL_VARIANTS).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ z: string; x: string; y: string }> }) {
  const { z: zStr, x: xStr, y: yStr } = await params;
  const z = Number(zStr);
  const x = Number(xStr);
  const y = Number(yStr);
  const timeline = await resolveTimelineContextFromRequest(req);

  if (z !== ZMAX) {
    return NextResponse.json({ error: "Only max zoom tiles can be invalidated" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return NextResponse.json({ error: firstError?.message || "Invalid input" }, { status: 400 });
  }
  const { prompt, modelVariant = DEFAULT_MODEL_VARIANT } = parsed.data;

  const effective = await resolveEffectiveTileMeta(timeline, z, x, y);
  if (effective.status === "EMPTY") {
    return NextResponse.json({ error: "Tile not found" }, { status: 404 });
  }
  if (effective.status === "PENDING") {
    return NextResponse.json({
      ok: true,
      status: "ALREADY_PENDING",
      timelineIndex: timeline.index,
    });
  }

  await markTimelineTilePending(timeline.node.id, z, x, y);
  await fileQueue.enqueue(`regen-${timeline.node.id}-${z}-${x}-${y}`, {
    z,
    x,
    y,
    prompt,
    modelVariant,
    timelineNodeId: timeline.node.id,
  });

  return NextResponse.json({ ok: true, timelineIndex: timeline.index });
}
