import type { TileBounds } from "./types";

export type RegionLock = {
  runId: string;
  mapId: string;
  timelineIndex: number;
  z: number;
  bounds: TileBounds;
  lockedAt: number;
  lastHeartbeat: number;
};

const STALE_TIMEOUT_MS = 90_000;

const GLOBAL_KEY = "__batchRegionLocks" as const;

function getLocks(): Map<string, RegionLock> {
  const globalRegistry = globalThis as Record<string, unknown>;
  const existing = globalRegistry[GLOBAL_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, RegionLock>;
  }
  const created = new Map<string, RegionLock>();
  globalRegistry[GLOBAL_KEY] = created;
  return created;
}

function boundsOverlap(a: TileBounds, b: TileBounds): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

function evictStaleLocks(): void {
  const locks = getLocks();
  const now = Date.now();
  for (const [runId, lock] of locks) {
    if (now - lock.lastHeartbeat > STALE_TIMEOUT_MS) {
      locks.delete(runId);
    }
  }
}

export function acquireRegionLock(
  lock: RegionLock,
): { ok: true } | { ok: false; conflict: RegionLock } {
  evictStaleLocks();
  const locks = getLocks();

  for (const existing of locks.values()) {
    if (
      existing.mapId === lock.mapId &&
      existing.timelineIndex === lock.timelineIndex &&
      boundsOverlap(existing.bounds, lock.bounds)
    ) {
      return { ok: false, conflict: existing };
    }
  }

  locks.set(lock.runId, lock);
  return { ok: true };
}

export function renewRegionLock(runId: string): boolean {
  const locks = getLocks();
  const lock = locks.get(runId);
  if (!lock) return false;
  lock.lastHeartbeat = Date.now();
  return true;
}

export function releaseRegionLock(runId: string): boolean {
  const locks = getLocks();
  return locks.delete(runId);
}

export function getActiveLocksForMap(mapId: string): RegionLock[] {
  evictStaleLocks();
  const locks = getLocks();
  const result: RegionLock[] = [];
  for (const lock of locks.values()) {
    if (lock.mapId === mapId) {
      result.push(lock);
    }
  }
  return result;
}
