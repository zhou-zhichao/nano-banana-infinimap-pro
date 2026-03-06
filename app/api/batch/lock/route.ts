import { NextResponse } from "next/server";
import {
  acquireRegionLock,
  renewRegionLock,
  releaseRegionLock,
  type RegionLock,
} from "@/lib/batch/registry";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { runId, mapId, timelineIndex, z, bounds } = body as {
    runId?: unknown;
    mapId?: unknown;
    timelineIndex?: unknown;
    z?: unknown;
    bounds?: unknown;
  };

  if (typeof runId !== "string" || !runId) {
    return NextResponse.json({ error: "Missing runId" }, { status: 400 });
  }
  if (typeof mapId !== "string" || !mapId) {
    return NextResponse.json({ error: "Missing mapId" }, { status: 400 });
  }
  if (typeof timelineIndex !== "number" || !Number.isFinite(timelineIndex)) {
    return NextResponse.json({ error: "Missing timelineIndex" }, { status: 400 });
  }
  if (typeof z !== "number" || !Number.isFinite(z)) {
    return NextResponse.json({ error: "Missing z" }, { status: 400 });
  }
  if (
    !bounds ||
    typeof bounds !== "object" ||
    typeof (bounds as { minX?: unknown }).minX !== "number" ||
    typeof (bounds as { minY?: unknown }).minY !== "number" ||
    typeof (bounds as { maxX?: unknown }).maxX !== "number" ||
    typeof (bounds as { maxY?: unknown }).maxY !== "number"
  ) {
    return NextResponse.json({ error: "Missing or invalid bounds" }, { status: 400 });
  }

  const now = Date.now();
  const lock: RegionLock = {
    runId,
    mapId,
    timelineIndex,
    z,
    bounds: bounds as RegionLock["bounds"],
    lockedAt: now,
    lastHeartbeat: now,
  };

  const result = acquireRegionLock(lock);
  if (!result.ok) {
    return NextResponse.json(
      {
        error: "Region is already locked by another batch run",
        conflict: {
          runId: result.conflict.runId,
          bounds: result.conflict.bounds,
          lockedAt: result.conflict.lockedAt,
        },
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.runId !== "string" || !body.runId) {
    return NextResponse.json({ error: "Missing runId" }, { status: 400 });
  }

  const renewed = renewRegionLock(body.runId);
  if (!renewed) {
    return NextResponse.json({ error: "Lock not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.runId !== "string" || !body.runId) {
    return NextResponse.json({ error: "Missing runId" }, { status: 400 });
  }

  const released = releaseRegionLock(body.runId);
  if (!released) {
    return NextResponse.json({ error: "Lock not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
