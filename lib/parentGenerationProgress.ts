export type ParentGenerationState = "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";

export interface ParentGenerationStatus {
  mapId: string;
  timelineIndex: number;
  timelineNodeId: string;
  state: ParentGenerationState;
  totalTiles: number;
  processedTiles: number;
  generatedTiles: number;
  skippedTiles: number;
  currentZ: number | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  message: string | null;
}

export interface ParentGenerationTarget {
  mapId: string;
  timelineIndex: number;
  timelineNodeId: string;
}

export interface ParentGenerationProgressUpdate {
  totalTiles: number;
  processedTiles: number;
  generatedTiles: number;
  skippedTiles: number;
  currentZ: number | null;
}

export function createIdleParentGenerationStatus(target: ParentGenerationTarget): ParentGenerationStatus {
  return {
    mapId: target.mapId,
    timelineIndex: target.timelineIndex,
    timelineNodeId: target.timelineNodeId,
    state: "IDLE",
    totalTiles: 0,
    processedTiles: 0,
    generatedTiles: 0,
    skippedTiles: 0,
    currentZ: null,
    startedAt: null,
    completedAt: null,
    error: null,
    message: null,
  };
}

export function getParentGenerationPercent(status: ParentGenerationStatus | null): number {
  if (!status) return 0;
  if (status.state === "COMPLETED") return 100;
  if (status.totalTiles <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((status.processedTiles / status.totalTiles) * 100)));
}
