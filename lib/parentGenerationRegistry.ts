import {
  createIdleParentGenerationStatus,
  type ParentGenerationTarget,
  type ParentGenerationProgressUpdate,
  type ParentGenerationStatus,
} from "./parentGenerationProgress";

const GLOBAL_KEY = "__parentGenerationStatusRegistry" as const;

function getRegistry(): Map<string, ParentGenerationStatus> {
  const globalRegistry = globalThis as Record<string, unknown>;
  const existing = globalRegistry[GLOBAL_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, ParentGenerationStatus>;
  }
  const created = new Map<string, ParentGenerationStatus>();
  globalRegistry[GLOBAL_KEY] = created;
  return created;
}

function registryKey(target: ParentGenerationTarget) {
  return `${target.mapId}:${target.timelineNodeId}`;
}

function setStatusForTarget(target: ParentGenerationTarget, status: ParentGenerationStatus) {
  getRegistry().set(registryKey(target), status);
  return status;
}

function attachTarget(status: ParentGenerationStatus, target: ParentGenerationTarget): ParentGenerationStatus {
  return {
    ...status,
    mapId: target.mapId,
    timelineIndex: target.timelineIndex,
    timelineNodeId: target.timelineNodeId,
  };
}

export function getParentGenerationStatus(target: ParentGenerationTarget): ParentGenerationStatus {
  const existing = getRegistry().get(registryKey(target));
  return existing ? attachTarget(existing, target) : createIdleParentGenerationStatus(target);
}

export function beginParentGeneration(target: ParentGenerationTarget): { started: boolean; status: ParentGenerationStatus } {
  const current = getParentGenerationStatus(target);
  if (current.state === "RUNNING") {
    return { started: false, status: current };
  }

  return {
    started: true,
    status: setStatusForTarget(target, {
      ...createIdleParentGenerationStatus(target),
      state: "RUNNING",
      startedAt: new Date().toISOString(),
      message: `Parent regeneration queued for "${target.mapId}" (timeline ${target.timelineIndex})`,
    }),
  };
}

export function updateParentGenerationProgress(
  target: ParentGenerationTarget,
  update: ParentGenerationProgressUpdate,
): ParentGenerationStatus {
  const current = getParentGenerationStatus(target);
  return setStatusForTarget(target, {
    ...current,
    state: "RUNNING",
    totalTiles: update.totalTiles,
    processedTiles: update.processedTiles,
    generatedTiles: update.generatedTiles,
    skippedTiles: update.skippedTiles,
    currentZ: update.currentZ,
    completedAt: null,
    error: null,
    message: `Regenerating parent tiles for "${target.mapId}" (timeline ${target.timelineIndex})`,
  });
}

export function completeParentGeneration(target: ParentGenerationTarget): ParentGenerationStatus {
  const current = getParentGenerationStatus(target);
  return setStatusForTarget(target, {
    ...current,
    state: "COMPLETED",
    processedTiles: Math.max(current.processedTiles, current.totalTiles),
    currentZ: null,
    completedAt: new Date().toISOString(),
    error: null,
    message: `Parent regeneration complete for "${target.mapId}" (timeline ${target.timelineIndex})`,
  });
}

export function failParentGeneration(target: ParentGenerationTarget, error: unknown): ParentGenerationStatus {
  const current = getParentGenerationStatus(target);
  const message = error instanceof Error ? error.message : "Unknown error";
  return setStatusForTarget(target, {
    ...current,
    state: "FAILED",
    currentZ: null,
    completedAt: new Date().toISOString(),
    error: message,
    message: null,
  });
}
