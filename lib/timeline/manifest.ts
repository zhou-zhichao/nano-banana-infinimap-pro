import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "@/lib/adapters/lock.file";
import { TIMELINE_DIR } from "@/lib/paths";
import { TimelineManifest, TimelineNode } from "./types";

export const DEFAULT_TIMELINE_NODE_COUNT = 10;
export const MIN_TIMELINE_NODES = 1;

const MANIFEST_PATH = path.join(TIMELINE_DIR, "manifest.json");

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
  return value.nodes.every((n) => n && typeof n.id === "string" && typeof n.createdAt === "string");
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

async function ensureTimelineRoot() {
  await fs.mkdir(TIMELINE_DIR, { recursive: true }).catch(() => {});
}

async function readManifestFile(): Promise<TimelineManifest | null> {
  try {
    const raw = await fs.readFile(MANIFEST_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isValidManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeManifestFile(manifest: TimelineManifest) {
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

async function ensureNodeDirectories(nodeId: string) {
  const nodeRoot = path.join(TIMELINE_DIR, "nodes", nodeId);
  await fs.mkdir(path.join(nodeRoot, "tiles"), { recursive: true }).catch(() => {});
  await fs.mkdir(path.join(nodeRoot, "meta"), { recursive: true }).catch(() => {});
}

async function removeNodeDirectories(nodeId: string) {
  const nodeRoot = path.join(TIMELINE_DIR, "nodes", nodeId);
  await fs.rm(nodeRoot, { recursive: true, force: true }).catch(() => {});
}

async function ensureManifestUnlocked(): Promise<TimelineManifest> {
  await ensureTimelineRoot();
  const existing = await readManifestFile();
  if (existing) {
    for (const node of existing.nodes) {
      await ensureNodeDirectories(node.id);
    }
    return existing;
  }

  const created = createDefaultManifest();
  await writeManifestFile(created);
  for (const node of created.nodes) {
    await ensureNodeDirectories(node.id);
  }
  return created;
}

export async function getTimelineManifest(): Promise<TimelineManifest> {
  const existing = await readManifestFile();
  if (existing) {
    for (const node of existing.nodes) {
      await ensureNodeDirectories(node.id);
    }
    return existing;
  }

  return withFileLock("timeline_manifest", async () => ensureManifestUnlocked());
}

export async function getTimelineNodes() {
  const manifest = await getTimelineManifest();
  return manifest.nodes;
}

export function clampTimelineIndex(requested: number, manifest: TimelineManifest) {
  if (!Number.isFinite(requested)) return 1;
  const normalized = Math.floor(requested);
  if (normalized < 1) return 1;
  if (normalized > manifest.nodes.length) return manifest.nodes.length;
  return normalized;
}

export async function insertTimelineNodeAfter(afterIndex: number) {
  return withFileLock("timeline_manifest", async () => {
    const manifest = await ensureManifestUnlocked();
    if (!Number.isInteger(afterIndex) || afterIndex < 1 || afterIndex > manifest.nodes.length) {
      throw new Error("Invalid afterIndex");
    }
    const node = createNode();
    manifest.nodes.splice(afterIndex, 0, node);
    manifest.updatedAt = nowIso();
    await writeManifestFile(manifest);
    await ensureNodeDirectories(node.id);

    return {
      manifest,
      insertedIndex: afterIndex + 1,
      node,
    };
  });
}

export async function deleteTimelineNodeAt(index: number) {
  return withFileLock("timeline_manifest", async () => {
    const manifest = await ensureManifestUnlocked();
    if (!Number.isInteger(index) || index < 1 || index > manifest.nodes.length) {
      throw new Error("Invalid index");
    }
    if (manifest.nodes.length <= MIN_TIMELINE_NODES) {
      throw new Error("At least one timeline node must remain");
    }

    const [removed] = manifest.nodes.splice(index - 1, 1);
    manifest.updatedAt = nowIso();
    await writeManifestFile(manifest);
    if (removed) {
      await removeNodeDirectories(removed.id);
    }

    return {
      manifest,
      removed,
    };
  });
}
