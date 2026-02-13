import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/adapters/db.file";
import { withFileLock } from "@/lib/adapters/lock.file";
import { TIMELINE_DIR } from "@/lib/paths";
import { readTileFile } from "@/lib/storage";
import { TimelineContext, TimelineManifest, TimelineTileMeta, TimelineTileStatus } from "./types";

function nowIso() {
  return new Date().toISOString();
}

function tileKey(z: number, x: number, y: number) {
  return `${z}_${x}_${y}`;
}

function nodeRoot(nodeId: string) {
  return path.join(TIMELINE_DIR, "nodes", nodeId);
}

function nodeMetaDir(nodeId: string) {
  return path.join(nodeRoot(nodeId), "meta");
}

function nodeTileDir(nodeId: string) {
  return path.join(nodeRoot(nodeId), "tiles");
}

function tileLockName(nodeId: string, z: number, x: number, y: number) {
  return `timeline_${nodeId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${z}_${x}_${y}`;
}

export function timelineNodeMetaPath(nodeId: string, z: number, x: number, y: number) {
  return path.join(nodeMetaDir(nodeId), `${tileKey(z, x, y)}.json`);
}

export function timelineNodeTilePath(nodeId: string, z: number, x: number, y: number) {
  return path.join(nodeTileDir(nodeId), `${tileKey(z, x, y)}.webp`);
}

async function ensureNodeDirs(nodeId: string) {
  await fs.mkdir(nodeMetaDir(nodeId), { recursive: true }).catch(() => {});
  await fs.mkdir(nodeTileDir(nodeId), { recursive: true }).catch(() => {});
}

export async function readTimelineNodeMeta(
  nodeId: string,
  z: number,
  x: number,
  y: number,
): Promise<TimelineTileMeta | null> {
  try {
    const raw = await fs.readFile(timelineNodeMetaPath(nodeId, z, x, y), "utf-8");
    return JSON.parse(raw) as TimelineTileMeta;
  } catch {
    return null;
  }
}

async function writeTimelineNodeMeta(nodeId: string, meta: TimelineTileMeta) {
  await ensureNodeDirs(nodeId);
  await fs.writeFile(
    timelineNodeMetaPath(nodeId, meta.z, meta.x, meta.y),
    JSON.stringify(meta),
  );
}

export async function readTimelineNodeTile(
  nodeId: string,
  z: number,
  x: number,
  y: number,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(timelineNodeTilePath(nodeId, z, x, y));
  } catch {
    return null;
  }
}

export async function markTimelineTilePending(
  nodeId: string,
  z: number,
  x: number,
  y: number,
) {
  await withFileLock(tileLockName(nodeId, z, x, y), async () => {
    const current = await readTimelineNodeMeta(nodeId, z, x, y);
    const ts = nowIso();
    await writeTimelineNodeMeta(nodeId, {
      z,
      x,
      y,
      status: "PENDING",
      hash: current?.hash,
      seed: current?.seed,
      contentVer: current?.contentVer ?? 0,
      tombstone: false,
      createdAt: current?.createdAt ?? ts,
      updatedAt: ts,
    });
  });
}

export async function writeTimelineTileReady(
  nodeId: string,
  z: number,
  x: number,
  y: number,
  buf: Buffer,
  options?: {
    hash?: string;
    seed?: string;
  },
) {
  await withFileLock(tileLockName(nodeId, z, x, y), async () => {
    const current = await readTimelineNodeMeta(nodeId, z, x, y);
    await ensureNodeDirs(nodeId);
    await fs.writeFile(timelineNodeTilePath(nodeId, z, x, y), buf);

    const ts = nowIso();
    await writeTimelineNodeMeta(nodeId, {
      z,
      x,
      y,
      status: "READY",
      hash: options?.hash ?? current?.hash,
      seed: options?.seed ?? current?.seed,
      contentVer: (current?.contentVer ?? 0) + 1,
      tombstone: false,
      createdAt: current?.createdAt ?? ts,
      updatedAt: ts,
    });
  });
}

export async function markTimelineTileTombstone(
  nodeId: string,
  z: number,
  x: number,
  y: number,
) {
  await withFileLock(tileLockName(nodeId, z, x, y), async () => {
    const current = await readTimelineNodeMeta(nodeId, z, x, y);
    await ensureNodeDirs(nodeId);
    await fs.rm(timelineNodeTilePath(nodeId, z, x, y), { force: true }).catch(() => {});

    const ts = nowIso();
    await writeTimelineNodeMeta(nodeId, {
      z,
      x,
      y,
      status: "EMPTY",
      tombstone: true,
      hash: undefined,
      seed: undefined,
      contentVer: (current?.contentVer ?? 0) + 1,
      createdAt: current?.createdAt ?? ts,
      updatedAt: ts,
    });
  });
}

export interface ResolvedTimelineTileMeta {
  status: TimelineTileStatus;
  hash: string;
  updatedAt: string | null;
  sourceIndex: number | null;
}

function isEmptyOverride(meta: TimelineTileMeta) {
  return meta.tombstone === true || meta.status === "EMPTY";
}

async function resolveFromTimelineMeta(
  manifest: TimelineManifest,
  index: number,
  z: number,
  x: number,
  y: number,
): Promise<ResolvedTimelineTileMeta | null> {
  for (let i = index; i >= 1; i -= 1) {
    const nodeId = manifest.nodes[i - 1]?.id;
    if (!nodeId) continue;
    const meta = await readTimelineNodeMeta(nodeId, z, x, y);
    if (!meta) continue;

    if (meta.status === "PENDING") {
      return {
        status: "PENDING",
        hash: meta.hash ?? "PENDING",
        updatedAt: meta.updatedAt ?? null,
        sourceIndex: i,
      };
    }
    if (isEmptyOverride(meta)) {
      return {
        status: "EMPTY",
        hash: "EMPTY",
        updatedAt: meta.updatedAt ?? null,
        sourceIndex: i,
      };
    }
    if (meta.status === "READY") {
      return {
        status: "READY",
        hash: meta.hash ?? "READY",
        updatedAt: meta.updatedAt ?? null,
        sourceIndex: i,
      };
    }
  }
  return null;
}

export async function resolveEffectiveTileMeta(
  context: TimelineContext,
  z: number,
  x: number,
  y: number,
): Promise<ResolvedTimelineTileMeta> {
  const timelineMeta = await resolveFromTimelineMeta(context.manifest, context.index, z, x, y);
  if (timelineMeta) return timelineMeta;

  const baselineMeta = await db.getTile(z, x, y);
  if (baselineMeta?.status === "PENDING") {
    return {
      status: "PENDING",
      hash: baselineMeta.hash ?? "PENDING",
      updatedAt: baselineMeta.updatedAt ?? null,
      sourceIndex: null,
    };
  }
  if (baselineMeta?.status === "READY") {
    return {
      status: "READY",
      hash: baselineMeta.hash ?? "READY",
      updatedAt: baselineMeta.updatedAt ?? null,
      sourceIndex: null,
    };
  }
  if (baselineMeta?.status === "EMPTY") {
    const baselineFile = await readTileFile(z, x, y);
    if (!baselineFile) {
      return {
        status: "EMPTY",
        hash: "EMPTY",
        updatedAt: baselineMeta.updatedAt ?? null,
        sourceIndex: null,
      };
    }
  }

  const baselineBuf = await readTileFile(z, x, y);
  if (baselineBuf) {
    return {
      status: "READY",
      hash: baselineMeta?.hash ?? "READY",
      updatedAt: baselineMeta?.updatedAt ?? null,
      sourceIndex: null,
    };
  }

  return {
    status: "EMPTY",
    hash: "EMPTY",
    updatedAt: baselineMeta?.updatedAt ?? null,
    sourceIndex: null,
  };
}

export async function resolveEffectiveTileBuffer(
  context: TimelineContext,
  z: number,
  x: number,
  y: number,
): Promise<Buffer | null> {
  for (let i = context.index; i >= 1; i -= 1) {
    const nodeId = context.manifest.nodes[i - 1]?.id;
    if (!nodeId) continue;
    const meta = await readTimelineNodeMeta(nodeId, z, x, y);
    if (!meta) continue;

    if (isEmptyOverride(meta)) {
      return null;
    }
    if (meta.status === "READY") {
      const tile = await readTimelineNodeTile(nodeId, z, x, y);
      if (tile) return tile;
    }
    // Pending overrides should not hide previous ready content while a job is running.
  }

  return readTileFile(z, x, y);
}
