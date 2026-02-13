import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DEFAULT_TIMELINE_NODE_COUNT,
  MIN_TIMELINE_NODES,
  deleteTimelineNodeAt,
  getTimelineManifest,
  insertTimelineNodeAfter,
} from "@/lib/timeline/manifest";

const insertSchema = z.object({
  afterIndex: z.number().int().min(1),
});

const deleteSchema = z.object({
  index: z.number().int().min(1),
});

function serialize(manifest: Awaited<ReturnType<typeof getTimelineManifest>>) {
  return {
    minNodes: MIN_TIMELINE_NODES,
    defaultNodeCount: DEFAULT_TIMELINE_NODE_COUNT,
    count: manifest.nodes.length,
    nodes: manifest.nodes.map((node, idx) => ({
      index: idx + 1,
      id: node.id,
      createdAt: node.createdAt,
    })),
    updatedAt: manifest.updatedAt,
  };
}

export async function GET() {
  const manifest = await getTimelineManifest();
  return NextResponse.json(serialize(manifest));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = insertSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return NextResponse.json({ error: firstError?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const { manifest, insertedIndex } = await insertTimelineNodeAfter(parsed.data.afterIndex);
    return NextResponse.json({
      ok: true,
      insertedIndex,
      ...serialize(manifest),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to insert timeline node" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    return NextResponse.json({ error: firstError?.message ?? "Invalid input" }, { status: 400 });
  }

  try {
    const { manifest } = await deleteTimelineNodeAt(parsed.data.index);
    return NextResponse.json({
      ok: true,
      activeIndex: Math.min(parsed.data.index, manifest.nodes.length),
      ...serialize(manifest),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete timeline node" },
      { status: 400 },
    );
  }
}

