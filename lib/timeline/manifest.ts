import crypto from "node:crypto";
import fs from "node:fs/promises";
import { withFileLock } from "@/lib/adapters/lock.file";
import {
  mapTimelineDir,
  mapTimelineManifestPath,
  mapTimelineNodeDir,
  mapTimelineNodeMetaDir,
  mapTimelineNodeTilesDir,
  mapTimelineNodesDir,
} from "@/lib/tilemaps/paths";
import { TimelineManifest, TimelineNode } from "./types";

export const DEFAULT_TIMELINE_NODE_COUNT = 10;
export const MIN_TIMELINE_NODES = 1;

function nowIso() {
  return new Date().toISOString();
}

function createNode(): TimelineNode {
  return {
    id: `node-${crypto.randomUUID()}`,
    createdAt: nowIso(),
  };
}

function isValidManifest(input: unknown): input is TimelineManifest {
  if (!input || typeof input !== "object") return false;
  const value = input as TimelineManifest;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.nodes) || value.nodes.length < MIN_TIMELINE_NODES) return false;
  return value.nodes.every((node) => node && typeof node.id === "string" && typeof node.createdAt === "string");
}

function createDefaultManifest(): TimelineManifest {
  const ts = nowIso();
  return {
    version: 1,
    createdAt: ts,
    updatedAt: ts,
    nodes: Array.from({ length: DEFAULT_TIMELINE_NODE_COUNT }, () => createNode()),
  };
}

async function ensureTimelineRoot(mapId: string) {
  await fs.mkdir(mapTimelineDir(mapId), { recursive: true }).catch(() => {});
  await fs.mkdir(mapTimelineNodesDir(mapId), { recursive: true }).catch(() => {});
}

async function readManifestFile(mapId: string): Promise<TimelineManifest | null> {
  try {
    const raw = await fs.readFile(mapTimelineManifestPath(mapId), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeManifestFile(mapId: string, manifest: TimelineManifest) {
  await fs.writeFile(mapTimelineManifestPath(mapId), JSON.stringify(manifest, null, 2));
}

async function ensureNodeDirectories(mapId: string, nodeId: string) {
  await fs.mkdir(mapTimelineNodeMetaDir(mapId, nodeId), { recursive: true }).catch(() => {});
  await fs.mkdir(mapTimelineNodeTilesDir(mapId, nodeId), { recursive: true }).catch(() => {});
}

async function removeNodeDirectories(mapId: string, nodeId: string) {
  await fs.rm(mapTimelineNodeDir(mapId, nodeId), { recursive: true, force: true }).catch(() => {});
}

async function ensureManifestUnlocked(mapId: string): Promise<TimelineManifest> {
  await ensureTimelineRoot(mapId);

  const existing = await readManifestFile(mapId);
  if (existing) {
    for (const node of existing.nodes) {
      await ensureNodeDirectories(mapId, node.id);
    }
    return existing;
  }

  const created = createDefaultManifest();
  await writeManifestFile(mapId, created);
  for (const node of created.nodes) {
    await ensureNodeDirectories(mapId, node.id);
  }
  return created;
}

export async function getTimelineManifest(mapId: string): Promise<TimelineManifest> {
  const existing = await readManifestFile(mapId);
  if (existing) {
    for (const node of existing.nodes) {
      await ensureNodeDirectories(mapId, node.id);
    }
    return existing;
  }
  return withFileLock(mapId, "timeline_manifest", async () => ensureManifestUnlocked(mapId));
}

export async function getTimelineNodes(mapId: string) {
  const manifest = await getTimelineManifest(mapId);
  return manifest.nodes;
}

export function clampTimelineIndex(requested: number, manifest: TimelineManifest) {
  if (!Number.isFinite(requested)) return 1;
  const normalized = Math.floor(requested);
  if (normalized < 1) return 1;
  if (normalized > manifest.nodes.length) return manifest.nodes.length;
  return normalized;
}

export async function insertTimelineNodeAfter(mapId: string, afterIndex: number) {
  return withFileLock(mapId, "timeline_manifest", async () => {
    const manifest = await ensureManifestUnlocked(mapId);
    if (!Number.isInteger(afterIndex) || afterIndex < 1 || afterIndex > manifest.nodes.length) {
      throw new Error("Invalid afterIndex");
    }

    const node = createNode();
    manifest.nodes.splice(afterIndex, 0, node);
    manifest.updatedAt = nowIso();
    await writeManifestFile(mapId, manifest);
    await ensureNodeDirectories(mapId, node.id);

    return {
      manifest,
      insertedIndex: afterIndex + 1,
      node,
    };
  });
}

export async function deleteTimelineNodeAt(mapId: string, index: number) {
  return withFileLock(mapId, "timeline_manifest", async () => {
    const manifest = await ensureManifestUnlocked(mapId);
    if (!Number.isInteger(index) || index < 1 || index > manifest.nodes.length) {
      throw new Error("Invalid index");
    }
    if (manifest.nodes.length <= MIN_TIMELINE_NODES) {
      throw new Error("At least one timeline node must remain");
    }

    const [removed] = manifest.nodes.splice(index - 1, 1);
    manifest.updatedAt = nowIso();
    await writeManifestFile(mapId, manifest);
    if (removed) {
      await removeNodeDirectories(mapId, removed.id);
    }

    return {
      manifest,
      removed,
    };
  });
}
