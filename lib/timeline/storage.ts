import fs from "node:fs/promises";
import { db } from "../adapters/db.file";
import { withFileLock } from "../adapters/lock.file";
import {
  mapTimelineNodeMetaPath,
  mapTimelineNodeMetaDir,
  mapTimelineNodeTilePath,
  mapTimelineNodeTilesDir,
} from "../tilemaps/paths";
import { readTileFile } from "../storage";
import { TimelineContext, TimelineManifest, TimelineTileMeta, TimelineTileStatus } from "./types";

function nowIso() {
  return new Date().toISOString();
}

function tileLockName(nodeId: string, z: number, x: number, y: number) {
  return `timeline_${nodeId.replace(/[^a-zA-Z0-9_-]/g, "_")}_${z}_${x}_${y}`;
}

async function ensureNodeDirs(mapId: string, nodeId: string) {
  await fs.mkdir(mapTimelineNodeMetaDir(mapId, nodeId), { recursive: true }).catch(() => {});
  await fs.mkdir(mapTimelineNodeTilesDir(mapId, nodeId), { recursive: true }).catch(() => {});
}

export async function readTimelineNodeMeta(
  mapId: string,
  nodeId: string,
  z: number,
  x: number,
  y: number,
): Promise<TimelineTileMeta | null> {
  try {
    const raw = await fs.readFile(mapTimelineNodeMetaPath(mapId, nodeId, z, x, y), "utf-8");
    return JSON.parse(raw) as TimelineTileMeta;
  } catch {
    return null;
  }
}

async function writeTimelineNodeMeta(mapId: string, nodeId: string, meta: TimelineTileMeta) {
  await ensureNodeDirs(mapId, nodeId);
  await fs.writeFile(mapTimelineNodeMetaPath(mapId, nodeId, meta.z, meta.x, meta.y), JSON.stringify(meta));
}

export async function readTimelineNodeTile(
  mapId: string,
  nodeId: string,
  z: number,
  x: number,
  y: number,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(mapTimelineNodeTilePath(mapId, nodeId, z, x, y));
  } catch {
    return null;
  }
}

export async function markTimelineTilePending(
  mapId: string,
  nodeId: string,
  z: number,
  x: number,
  y: number,
) {
  await withFileLock(mapId, tileLockName(nodeId, z, x, y), async () => {
    const current = await readTimelineNodeMeta(mapId, nodeId, z, x, y);
    const ts = nowIso();
    await writeTimelineNodeMeta(mapId, nodeId, {
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
  mapId: string,
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
  await withFileLock(mapId, tileLockName(nodeId, z, x, y), async () => {
    const current = await readTimelineNodeMeta(mapId, nodeId, z, x, y);
    await ensureNodeDirs(mapId, nodeId);
    await fs.writeFile(mapTimelineNodeTilePath(mapId, nodeId, z, x, y), buf);

    const ts = nowIso();
    await writeTimelineNodeMeta(mapId, nodeId, {
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
  mapId: string,
  nodeId: string,
  z: number,
  x: number,
  y: number,
) {
  await withFileLock(mapId, tileLockName(nodeId, z, x, y), async () => {
    const current = await readTimelineNodeMeta(mapId, nodeId, z, x, y);
    await ensureNodeDirs(mapId, nodeId);
    await fs.rm(mapTimelineNodeTilePath(mapId, nodeId, z, x, y), { force: true }).catch(() => {});

    const ts = nowIso();
    await writeTimelineNodeMeta(mapId, nodeId, {
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
  mapId: string,
  manifest: TimelineManifest,
  index: number,
  z: number,
  x: number,
  y: number,
): Promise<ResolvedTimelineTileMeta | null> {
  for (let i = index; i >= 1; i -= 1) {
    const nodeId = manifest.nodes[i - 1]?.id;
    if (!nodeId) continue;
    const meta = await readTimelineNodeMeta(mapId, nodeId, z, x, y);
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
  const timelineMeta = await resolveFromTimelineMeta(context.mapId, context.manifest, context.index, z, x, y);
  if (timelineMeta) return timelineMeta;

  const baselineMeta = await db.getTile(context.mapId, z, x, y);
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
    const baselineFile = await readTileFile(context.mapId, z, x, y);
    if (!baselineFile) {
      return {
        status: "EMPTY",
        hash: "EMPTY",
        updatedAt: baselineMeta.updatedAt ?? null,
        sourceIndex: null,
      };
    }
  }

  const baselineBuf = await readTileFile(context.mapId, z, x, y);
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
    const meta = await readTimelineNodeMeta(context.mapId, nodeId, z, x, y);
    if (!meta) continue;

    if (isEmptyOverride(meta)) {
      return null;
    }
    if (meta.status === "READY") {
      const tile = await readTimelineNodeTile(context.mapId, nodeId, z, x, y);
      if (tile) return tile;
    }
    // Pending overlays do not hide previous ready content while generation runs.
  }

  return readTileFile(context.mapId, z, x, y);
}
