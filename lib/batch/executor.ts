import { DEFAULT_MODEL_VARIANT, type ModelVariant } from "../modelVariant";
import { anchorsOverlap3x3, buildAnchorPlan, collectAnchorLeafTiles, dedupeTileCoords } from "./plan";
import type {
  AnchorTask,
  AnchorTaskStatus,
  BatchRunState,
  GenerateProgress,
  ParentProgress,
  ParentRefreshJob,
  TileCoord,
  WaveResult,
} from "./types";

type FetchLike = typeof fetch;

type ExecuteAnchorHookContext = {
  attempt: number;
  signal: AbortSignal;
};

type RefreshParentHookRequest = {
  childZ: number;
  childTiles: TileCoord[];
  signal: AbortSignal;
};

type SchedulingMode = "wave_barrier" | "rolling_fill";

export type StartBatchRunInput = {
  mapId: string;
  timelineIndex: number;
  z: number;
  originX: number;
  originY: number;
  mapWidth: number;
  mapHeight: number;
  layers: number;
  prompt: string;
  modelVariant?: ModelVariant;
  maxParallel?: number;
  maxGenerateRetries?: number;
  parentJobRetries?: number;
  parentWorkerConcurrency?: number;
  parentDebounceMs?: number;
  parentWaveBatchSize?: number;
  parentLeafBatchSize?: number;
  parentCascadeDepth?: number;
  schedulingMode?: SchedulingMode;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  onState?: (state: BatchRunState) => void;
  executeAnchor?: (anchor: AnchorTask, ctx: ExecuteAnchorHookContext) => Promise<void>;
  refreshParentLevel?: (
    job: ParentRefreshJob,
    request: RefreshParentHookRequest,
  ) => Promise<{ parentTiles: TileCoord[] }>;
};

export type BatchRunHandle = {
  done: Promise<BatchRunState>;
  cancel: () => void;
  getState: () => BatchRunState;
};

class HttpError extends Error {
  status: number;
  retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type AnchorExecutionResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      retryAfterMs: number | null;
    };

function withMapTimeline(path: string, mapId: string, timelineIndex: number) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}mapId=${encodeURIComponent(mapId)}&t=${encodeURIComponent(String(timelineIndex))}`;
}

function createAbortError() {
  const error = new Error("Batch run aborted");
  error.name = "AbortError";
  return error;
}

function ensureNotAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function toErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

function retryAfterMsFromUnknown(error: unknown): number | null {
  if (error instanceof HttpError && typeof error.retryAfterSeconds === "number" && error.retryAfterSeconds > 0) {
    return error.retryAfterSeconds * 1000;
  }
  return null;
}

async function sleep(ms: number, signal: AbortSignal) {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readResponseErrorMessage(response: Response, fallback: string) {
  const bodyText = await response.text().catch(() => "");
  if (!bodyText.trim()) return fallback;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
  } catch {
    // ignore JSON parse failures and fallback to raw text
  }
  return bodyText.trim() || fallback;
}

async function toHttpError(response: Response, fallback: string) {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : NaN;
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
  const message = await readResponseErrorMessage(response, fallback);
  return new HttpError(message, response.status, retryAfterSeconds);
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function computeGenerateProgress(anchors: Record<string, AnchorTask>, wavesCompleted: number): GenerateProgress {
  const values = Object.values(anchors);
  let pending = 0;
  let running = 0;
  let success = 0;
  let failed = 0;
  let blocked = 0;
  for (const anchor of values) {
    if (anchor.status === "PENDING") pending += 1;
    else if (anchor.status === "RUNNING") running += 1;
    else if (anchor.status === "SUCCESS") success += 1;
    else if (anchor.status === "FAILED") failed += 1;
    else if (anchor.status === "BLOCKED") blocked += 1;
  }
  return {
    total: values.length,
    pending,
    running,
    success,
    failed,
    blocked,
    wavesCompleted,
  };
}

function computeParentProgress(parentJobs: ParentRefreshJob[]): ParentProgress {
  let completedWaves = 0;
  let failedWaves = 0;
  let queueLength = 0;
  let runningJobs = 0;
  let currentLevelZ: number | null = null;

  for (const job of parentJobs) {
    if (job.status === "SUCCESS") completedWaves += 1;
    if (job.status === "FAILED") failedWaves += 1;
    if (job.status === "QUEUED") queueLength += 1;
    if (job.status === "RUNNING") {
      runningJobs += 1;
      if (typeof job.currentLevelZ === "number") {
        if (currentLevelZ == null) currentLevelZ = job.currentLevelZ;
        else currentLevelZ = Math.min(currentLevelZ, job.currentLevelZ);
      }
    }
  }

  return {
    enqueuedWaves: parentJobs.length,
    completedWaves,
    failedWaves,
    queueLength,
    runningJobs,
    currentLevelZ,
  };
}

function cloneState(state: BatchRunState): BatchRunState {
  const anchors: Record<string, AnchorTask> = {};
  for (const [id, anchor] of Object.entries(state.anchors)) {
    anchors[id] = {
      ...anchor,
      deps: [...anchor.deps],
      dependents: [...anchor.dependents],
      priority: { ...anchor.priority },
    };
  }
  const waves: WaveResult[] = state.waves.map((wave) => ({
    ...wave,
    taskIds: [...wave.taskIds],
    successIds: [...wave.successIds],
    failedIds: [...wave.failedIds],
    blockedIds: [...wave.blockedIds],
  }));
  const parentJobs: ParentRefreshJob[] = state.parentJobs.map((job) => ({
    ...job,
    leafTiles: job.leafTiles.map((tile) => ({ ...tile })),
  }));

  return {
    ...state,
    origin: { ...state.origin },
    coverageBounds: state.coverageBounds ? { ...state.coverageBounds } : null,
    anchors,
    waves,
    parentJobs,
    generate: { ...state.generate },
    parents: { ...state.parents },
  };
}

function isTerminalStatus(status: AnchorTaskStatus) {
  return status === "SUCCESS" || status === "FAILED" || status === "BLOCKED";
}

export function startBatchRun(input: StartBatchRunInput): BatchRunHandle {
  const mapId = input.mapId;
  const timelineIndex = input.timelineIndex;
  const z = input.z;
  const prompt = input.prompt.trim();
  const modelVariant = input.modelVariant ?? DEFAULT_MODEL_VARIANT;
  const maxParallel = clampInt(input.maxParallel ?? 4, 1, 16);
  const maxGenerateRetries = clampInt(input.maxGenerateRetries ?? 3, 0, 10);
  const parentJobRetries = clampInt(input.parentJobRetries ?? 2, 0, 10);
  const parentWorkerConcurrency = clampInt(input.parentWorkerConcurrency ?? 1, 1, 4);
  const parentDebounceMs = clampInt(input.parentDebounceMs ?? 1000, 0, 60_000);
  const parentWaveBatchSize = clampInt(input.parentWaveBatchSize ?? 3, 1, 64);
  const parentLeafBatchSize = clampInt(input.parentLeafBatchSize ?? 256, 1, 10_000);
  const parentCascadeDepth = clampInt(input.parentCascadeDepth ?? 2, 0, z);
  const schedulingMode: SchedulingMode = input.schedulingMode ?? "wave_barrier";

  const fetchImpl = input.fetchImpl ?? fetch;
  const abortController = new AbortController();
  const signal = abortController.signal;
  if (input.signal) {
    if (input.signal.aborted) {
      abortController.abort();
    } else {
      input.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }
  }

  const plan = buildAnchorPlan({
    originX: input.originX,
    originY: input.originY,
    layers: input.layers,
    mapWidth: input.mapWidth,
    mapHeight: input.mapHeight,
  });
  const anchors: Record<string, AnchorTask> = {};
  for (const anchor of plan.anchors) {
    anchors[anchor.id] = {
      ...anchor,
      deps: [...anchor.deps],
      dependents: [...anchor.dependents],
      priority: { ...anchor.priority },
    };
  }

  const state: BatchRunState = {
    runId: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: "RUNNING",
    startedAt: Date.now(),
    prompt,
    modelVariant,
    layers: clampInt(input.layers, 0, 256),
    maxParallel,
    origin: { x: input.originX, y: input.originY },
    currentWave: 0,
    coverageBounds: plan.coverageBounds ? { ...plan.coverageBounds } : null,
    anchors,
    waves: [],
    parentJobs: [],
    generate: computeGenerateProgress(anchors, 0),
    parents: computeParentProgress([]),
  };

  let generationFinished = false;
  let fatalError: Error | null = null;
  const onState = input.onState;
  const dirtyParentLeaves = new Set<string>();
  const allTouchedParentLeaves = new Set<string>();
  let dirtyParentMarkedAt: number | null = null;
  let dirtyParentWaveCount = 0;
  let dirtyParentLastWaveIndex = 0;
  let finalCatchupEnqueued = parentCascadeDepth >= z;

  const emit = () => {
    state.generate = computeGenerateProgress(state.anchors, state.waves.length);
    state.parents = computeParentProgress(state.parentJobs);
    onState?.(cloneState(state));
  };

  const propagateBlockedFrom = (failedId: string): string[] => {
    const blockedIds: string[] = [];
    const queue = [...(state.anchors[failedId]?.dependents ?? [])];
    while (queue.length > 0) {
      const nextId = queue.shift()!;
      const anchor = state.anchors[nextId];
      if (!anchor) continue;
      if (anchor.status !== "PENDING") continue;
      anchor.status = "BLOCKED";
      anchor.blockedBy = failedId;
      anchor.finishedAt = Date.now();
      blockedIds.push(nextId);
      queue.push(...anchor.dependents);
    }
    return blockedIds;
  };

  const selectReadyAnchorIds = (): string[] => {
    const ready: string[] = [];
    for (const id of plan.priorityOrder) {
      const anchor = state.anchors[id];
      if (!anchor || anchor.status !== "PENDING") continue;
      const depsReady = anchor.deps.every((depId) => state.anchors[depId]?.status === "SUCCESS");
      if (depsReady) ready.push(id);
    }
    return ready;
  };

  const pickWaveAnchorIds = (readyIds: string[]): string[] => {
    const selected: string[] = [];
    for (const id of readyIds) {
      if (selected.length >= maxParallel) break;
      const candidate = state.anchors[id];
      if (!candidate) continue;
      const conflicts = selected.some((selectedId) => {
        const selectedAnchor = state.anchors[selectedId];
        if (!selectedAnchor) return false;
        return anchorsOverlap3x3(candidate, selectedAnchor);
      });
      if (conflicts) continue;
      selected.push(id);
    }
    if (selected.length === 0 && readyIds.length > 0) {
      selected.push(readyIds[0]);
    }
    return selected;
  };

  const resolveBlockedAnchors = (): boolean => {
    const pendingAnchors = Object.values(state.anchors).filter((anchor) => anchor.status === "PENDING");
    if (pendingAnchors.length === 0) {
      return false;
    }
    let blockedAny = false;
    for (const anchor of pendingAnchors) {
      const blocker = anchor.deps.find((depId) => {
        const depStatus = state.anchors[depId]?.status;
        return depStatus === "FAILED" || depStatus === "BLOCKED";
      });
      if (!blocker) continue;
      anchor.status = "BLOCKED";
      anchor.blockedBy = blocker;
      anchor.finishedAt = Date.now();
      blockedAny = true;
    }
    return blockedAny;
  };

  const blockUnreachablePendingAnchors = (): void => {
    const pendingAnchors = Object.values(state.anchors).filter((anchor) => anchor.status === "PENDING");
    for (const anchor of pendingAnchors) {
      if (anchor.status !== "PENDING") continue;
      anchor.status = "BLOCKED";
      anchor.blockedBy = anchor.deps[0];
      anchor.finishedAt = Date.now();
    }
  };

  const runAnchorOverApi = async (anchor: AnchorTask): Promise<void> => {
    ensureNotAborted(signal);
    let previewId: string | null = null;
    try {
      const editResponse = await fetchImpl(withMapTimeline(`/api/edit-tile/${z}/${anchor.x}/${anchor.y}`, mapId, timelineIndex), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, modelVariant }),
        signal,
      });
      if (!editResponse.ok) {
        throw await toHttpError(editResponse, "Failed to edit tile");
      }
      const editJson = (await editResponse.json().catch(() => ({}))) as { previewId?: unknown };
      previewId = typeof editJson.previewId === "string" ? editJson.previewId : null;
      if (!previewId) {
        throw new Error("Invalid /api/edit-tile response: missing previewId");
      }

      const previewUrl = withMapTimeline(`/api/preview/${previewId}`, mapId, timelineIndex);
      const confirmResponse = await fetchImpl(
        withMapTimeline(`/api/confirm-edit/${z}/${anchor.x}/${anchor.y}`, mapId, timelineIndex),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            previewUrl,
            previewMode: "blended",
            skipParentRefresh: true,
          }),
          signal,
        },
      );
      if (!confirmResponse.ok) {
        throw await toHttpError(confirmResponse, "Failed to confirm edit");
      }
    } finally {
      if (previewId) {
        await fetchImpl(withMapTimeline(`/api/preview/${previewId}`, mapId, timelineIndex), {
          method: "DELETE",
          signal,
        }).catch(() => null);
      }
    }
  };

  const runAnchorWithRetry = async (anchor: AnchorTask): Promise<AnchorExecutionResult> => {
    const maxAttempts = maxGenerateRetries + 1;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      ensureNotAborted(signal);
      anchor.attempts = attempt;
      try {
        if (input.executeAnchor) {
          await input.executeAnchor(anchor, { attempt, signal });
        } else {
          await runAnchorOverApi(anchor);
        }
        return { ok: true };
      } catch (error) {
        if (signal.aborted) {
          throw createAbortError();
        }
        lastError = error;
        if (attempt >= maxAttempts) break;
        const retryAfterMs = retryAfterMsFromUnknown(error);
        const delayMs = retryAfterMs ?? Math.min(15_000, 500 * 2 ** (attempt - 1));
        await sleep(delayMs, signal);
      }
    }
    return {
      ok: false,
      error: toErrorMessage(lastError, "Anchor execution failed"),
      retryAfterMs: retryAfterMsFromUnknown(lastError),
    };
  };

  const toTileCoords = (keys: Set<string>) => {
    const coords: TileCoord[] = [];
    for (const key of keys) {
      const [xRaw, yRaw] = key.split(",");
      const x = Number(xRaw);
      const y = Number(yRaw);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      coords.push({ x, y });
    }
    return dedupeTileCoords(coords);
  };

  const markDirtyParentLeaves = (waveIndex: number, successIds: string[]) => {
    if (successIds.length === 0) return;
    const leaves: TileCoord[] = [];
    for (const id of successIds) {
      const anchor = state.anchors[id];
      if (!anchor) continue;
      leaves.push(...collectAnchorLeafTiles(anchor, input.mapWidth, input.mapHeight));
    }
    const dedupedLeaves = dedupeTileCoords(leaves);
    if (dedupedLeaves.length === 0) return;

    const dirtyWasEmpty = dirtyParentLeaves.size === 0;
    for (const leaf of dedupedLeaves) {
      const key = `${leaf.x},${leaf.y}`;
      allTouchedParentLeaves.add(key);
      if (parentCascadeDepth > 0) {
        dirtyParentLeaves.add(key);
      }
    }
    if (dirtyParentLeaves.size === 0) {
      dirtyParentLastWaveIndex = waveIndex;
      return;
    }
    if (dirtyWasEmpty) {
      dirtyParentMarkedAt = Date.now();
      dirtyParentWaveCount = 0;
    }
    dirtyParentWaveCount += 1;
    dirtyParentLastWaveIndex = waveIndex;
  };

  const shouldFlushDirtyParents = () => {
    if (dirtyParentLeaves.size === 0 || dirtyParentMarkedAt == null) return false;
    if (generationFinished) return true;
    if (dirtyParentWaveCount >= parentWaveBatchSize) return true;
    if (dirtyParentLeaves.size >= parentLeafBatchSize) return true;
    return Date.now() - dirtyParentMarkedAt >= parentDebounceMs;
  };

  const flushDirtyParentsToJob = () => {
    if (!shouldFlushDirtyParents()) return null;
    const dedupedLeaves = toTileCoords(dirtyParentLeaves);
    if (dedupedLeaves.length === 0) {
      dirtyParentLeaves.clear();
      dirtyParentMarkedAt = null;
      dirtyParentWaveCount = 0;
      return null;
    }

    const waveIndex = dirtyParentLastWaveIndex;
    const job: ParentRefreshJob = {
      id: `parents-${waveIndex}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      waveIndex,
      childZ: z,
      leafTiles: dedupedLeaves,
      status: "QUEUED",
      attempts: 0,
      enqueuedAt: Date.now(),
      maxLevels: parentCascadeDepth,
    };
    dirtyParentLeaves.clear();
    dirtyParentMarkedAt = null;
    dirtyParentWaveCount = 0;
    state.parentJobs.push(job);
    emit();
    return job;
  };

  const enqueueFinalCatchupJob = () => {
    if (!generationFinished) return null;
    if (finalCatchupEnqueued) return null;
    const hasRunningOrQueued = state.parentJobs.some((job) => job.status === "RUNNING" || job.status === "QUEUED");
    if (hasRunningOrQueued) return null;

    finalCatchupEnqueued = true;
    const dedupedLeaves = toTileCoords(allTouchedParentLeaves);
    allTouchedParentLeaves.clear();
    if (dedupedLeaves.length === 0) return null;

    const job: ParentRefreshJob = {
      id: `parents-final-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      waveIndex: state.currentWave,
      childZ: z,
      leafTiles: dedupedLeaves,
      status: "QUEUED",
      attempts: 0,
      enqueuedAt: Date.now(),
      maxLevels: z,
    };
    state.parentJobs.push(job);
    emit();
    return job;
  };

  const parseParentTilesFromResponse = (json: unknown): TileCoord[] => {
    const parentTilesField = (json as { parentTiles?: unknown })?.parentTiles;
    const parentTilesRaw: unknown[] = Array.isArray(parentTilesField) ? parentTilesField : [];
    const parentTiles: TileCoord[] = [];
    for (const item of parentTilesRaw) {
      const x = Number((item as { x?: unknown })?.x);
      const y = Number((item as { y?: unknown })?.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      parentTiles.push({ x, y });
    }
    return dedupeTileCoords(parentTiles);
  };

  const refreshParentLevelOverApi = async (
    childZ: number,
    childTiles: TileCoord[],
  ): Promise<{ parentTiles: TileCoord[] }> => {
    const response = await fetchImpl(withMapTimeline("/api/parents/refresh-region", mapId, timelineIndex), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childZ, childTiles }),
      signal,
    });
    if (!response.ok) {
      throw await toHttpError(response, `Failed parent refresh at child level z=${childZ}`);
    }
    const json = (await response.json().catch(() => ({}))) as unknown;
    return { parentTiles: parseParentTilesFromResponse(json) };
  };

  const runParentJob = async (job: ParentRefreshJob) => {
    let childZ = job.childZ;
    let childTiles = [...job.leafTiles];
    let levelsRemaining = clampInt(job.maxLevels ?? parentCascadeDepth, 0, childZ);

    while (childZ > 0 && childTiles.length > 0 && levelsRemaining > 0) {
      ensureNotAborted(signal);
      job.currentLevelZ = childZ - 1;
      emit();

      const result = input.refreshParentLevel
        ? await input.refreshParentLevel(job, { childZ, childTiles, signal })
        : await refreshParentLevelOverApi(childZ, childTiles);
      childTiles = dedupeTileCoords(result.parentTiles);
      childZ -= 1;
      levelsRemaining -= 1;
    }
    job.currentLevelZ = undefined;
  };

  const parentWorkerLoop = async () => {
    while (true) {
      if (fatalError) return;
      ensureNotAborted(signal);
      let queuedJob = state.parentJobs.find((job) => job.status === "QUEUED");
      if (!queuedJob) {
        flushDirtyParentsToJob();
        queuedJob = state.parentJobs.find((job) => job.status === "QUEUED");
      }
      if (!queuedJob) {
        enqueueFinalCatchupJob();
        queuedJob = state.parentJobs.find((job) => job.status === "QUEUED");
      }
      if (!queuedJob) {
        const hasRunningOrQueued = state.parentJobs.some((job) => job.status === "RUNNING" || job.status === "QUEUED");
        if (generationFinished && dirtyParentLeaves.size === 0 && !hasRunningOrQueued && finalCatchupEnqueued) {
          return;
        }
        await sleep(120, signal);
        continue;
      }

      queuedJob.status = "RUNNING";
      queuedJob.startedAt = Date.now();
      queuedJob.attempts += 1;
      queuedJob.error = undefined;
      emit();

      try {
        await runParentJob(queuedJob);
        queuedJob.status = "SUCCESS";
        queuedJob.finishedAt = Date.now();
        queuedJob.currentLevelZ = undefined;
        emit();
      } catch (error) {
        if (signal.aborted) return;
        const retryAfterMs = retryAfterMsFromUnknown(error);
        queuedJob.error = toErrorMessage(error, "Parent refresh failed");
        queuedJob.currentLevelZ = undefined;
        const maxAttempts = parentJobRetries + 1;
        if (queuedJob.attempts < maxAttempts) {
          queuedJob.status = "QUEUED";
          emit();
          const delayMs = retryAfterMs ?? Math.min(15_000, 750 * 2 ** (queuedJob.attempts - 1));
          await sleep(delayMs, signal);
          continue;
        }

        queuedJob.status = "FAILED";
        queuedJob.finishedAt = Date.now();
        fatalError = new Error(`Parent refresh failed (wave ${queuedJob.waveIndex}): ${queuedJob.error}`);
        emit();
        abortController.abort();
        return;
      }
    }
  };

  const parentWorkers = Array.from({ length: parentWorkerConcurrency }, () => parentWorkerLoop());
  type RollingAnchorOutcome =
    | {
        id: string;
        result: AnchorExecutionResult;
        finishedAt: number;
      }
    | {
        id: string;
        error: unknown;
        finishedAt: number;
      };
  const rollingInFlight = new Map<string, Promise<RollingAnchorOutcome>>();

  const runGenerationWaveBarrier = async () => {
    while (true) {
      ensureNotAborted(signal);
      if (fatalError) throw fatalError;

      const pendingAnchors = Object.values(state.anchors).filter((anchor) => anchor.status === "PENDING");
      if (pendingAnchors.length === 0) {
        break;
      }

      const blockedAny = resolveBlockedAnchors();
      if (blockedAny) {
        emit();
        continue;
      }

      const readyIds = selectReadyAnchorIds();
      if (readyIds.length === 0) {
        // Safety: any remaining pending tasks are no longer reachable.
        blockUnreachablePendingAnchors();
        emit();
        continue;
      }

      const waveIds = pickWaveAnchorIds(readyIds);
      if (waveIds.length === 0) {
        await sleep(25, signal);
        continue;
      }

      const waveIndex = state.currentWave + 1;
      state.currentWave = waveIndex;
      const waveStartedAt = Date.now();
      for (const id of waveIds) {
        const anchor = state.anchors[id];
        if (!anchor) continue;
        anchor.status = "RUNNING";
        anchor.waveIndex = waveIndex;
        anchor.startedAt = waveStartedAt;
      }
      emit();

      const outcomes = await Promise.all(
        waveIds.map(async (id) => {
          const anchor = state.anchors[id];
          if (!anchor) {
            return {
              id,
              result: {
                ok: false,
                error: "Anchor not found",
                retryAfterMs: null,
              } as AnchorExecutionResult,
            };
          }
          const result = await runAnchorWithRetry(anchor);
          return { id, result };
        }),
      );

      const waveFinishedAt = Date.now();
      const successIds: string[] = [];
      const failedIds: string[] = [];
      const blockedIds: string[] = [];
      for (const outcome of outcomes) {
        const anchor = state.anchors[outcome.id];
        if (!anchor) continue;
        anchor.finishedAt = waveFinishedAt;
        if (outcome.result.ok) {
          anchor.status = "SUCCESS";
          anchor.error = undefined;
          successIds.push(anchor.id);
          continue;
        }
        anchor.status = "FAILED";
        anchor.error = outcome.result.error;
        failedIds.push(anchor.id);
        blockedIds.push(...propagateBlockedFrom(anchor.id));
      }

      const uniqueBlocked = Array.from(new Set(blockedIds));
      state.waves.push({
        waveIndex,
        taskIds: [...waveIds],
        successIds,
        failedIds,
        blockedIds: uniqueBlocked,
        startedAt: waveStartedAt,
        finishedAt: waveFinishedAt,
      });
      emit();
      markDirtyParentLeaves(waveIndex, successIds);
    }
  };

  const runGenerationRollingFill = async () => {
    while (true) {
      ensureNotAborted(signal);
      if (fatalError) throw fatalError;

      const blockedAny = resolveBlockedAnchors();
      if (blockedAny) {
        emit();
        continue;
      }

      let scheduledAny = false;
      while (rollingInFlight.size < maxParallel) {
        const readyIds = selectReadyAnchorIds();
        if (readyIds.length === 0) break;

        let nextId: string | null = null;
        for (const id of readyIds) {
          const candidate = state.anchors[id];
          if (!candidate) continue;
          const conflictsRunning = Array.from(rollingInFlight.keys()).some((runningId) => {
            const runningAnchor = state.anchors[runningId];
            if (!runningAnchor) return false;
            return anchorsOverlap3x3(candidate, runningAnchor);
          });
          if (conflictsRunning) continue;
          nextId = id;
          break;
        }

        if (!nextId) {
          // Ready tasks exist, but all conflict with currently running anchors.
          break;
        }

        const anchor = state.anchors[nextId];
        if (!anchor) break;
        const waveIndex = state.currentWave + 1;
        state.currentWave = waveIndex;
        const startedAt = Date.now();
        anchor.status = "RUNNING";
        anchor.waveIndex = waveIndex;
        anchor.startedAt = startedAt;

        const runPromise: Promise<RollingAnchorOutcome> = runAnchorWithRetry(anchor)
          .then((result) => ({ id: nextId!, result, finishedAt: Date.now() }))
          .catch((error) => ({ id: nextId!, error, finishedAt: Date.now() }));
        rollingInFlight.set(nextId, runPromise);
        scheduledAny = true;
      }

      if (scheduledAny) {
        emit();
      }

      const hasPending = Object.values(state.anchors).some((anchor) => anchor.status === "PENDING");
      if (!hasPending && rollingInFlight.size === 0) {
        break;
      }

      if (rollingInFlight.size === 0) {
        const readyIds = selectReadyAnchorIds();
        if (readyIds.length === 0) {
          blockUnreachablePendingAnchors();
          emit();
          continue;
        }
        await sleep(25, signal);
        continue;
      }

      const completed = await Promise.race(Array.from(rollingInFlight.values()));
      rollingInFlight.delete(completed.id);

      if ("error" in completed) {
        throw completed.error;
      }

      const anchor = state.anchors[completed.id];
      if (!anchor) {
        throw new Error(`Anchor not found: ${completed.id}`);
      }

      const successIds: string[] = [];
      const failedIds: string[] = [];
      const blockedIds: string[] = [];
      anchor.finishedAt = completed.finishedAt;
      if (completed.result.ok) {
        anchor.status = "SUCCESS";
        anchor.error = undefined;
        successIds.push(anchor.id);
      } else {
        anchor.status = "FAILED";
        anchor.error = completed.result.error;
        failedIds.push(anchor.id);
        blockedIds.push(...propagateBlockedFrom(anchor.id));
      }

      const waveIndex = anchor.waveIndex ?? state.currentWave + 1;
      const waveStartedAt = anchor.startedAt ?? completed.finishedAt;
      const uniqueBlocked = Array.from(new Set(blockedIds));
      state.waves.push({
        waveIndex,
        taskIds: [anchor.id],
        successIds,
        failedIds,
        blockedIds: uniqueBlocked,
        startedAt: waveStartedAt,
        finishedAt: completed.finishedAt,
      });
      emit();
      markDirtyParentLeaves(waveIndex, successIds);
    }
  };

  const HEARTBEAT_INTERVAL_MS = 30_000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const acquireLock = async (): Promise<void> => {
    if (!state.coverageBounds) return;
    const response = await fetchImpl("/api/batch/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId: state.runId,
        mapId,
        timelineIndex,
        z,
        bounds: state.coverageBounds,
      }),
      signal,
    });
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        conflict?: { runId?: string; bounds?: unknown };
      };
      const conflictInfo = body.conflict
        ? ` (conflict: run ${body.conflict.runId})`
        : "";
      throw new Error(
        `Region lock conflict: ${body.error ?? "overlapping batch run in progress"}${conflictInfo}`,
      );
    }
    if (!response.ok) {
      const body = await readResponseErrorMessage(response, "Failed to acquire region lock");
      throw new Error(body);
    }
  };

  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      void fetchImpl("/api/batch/lock", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: state.runId }),
      }).catch(() => null);
    }, HEARTBEAT_INTERVAL_MS);
  };

  const releaseLock = async () => {
    if (heartbeatTimer != null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    await fetchImpl("/api/batch/lock", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: state.runId }),
    }).catch(() => null);
  };

  const done = (async (): Promise<BatchRunState> => {
    emit();
    try {
      await acquireLock();
      startHeartbeat();

      if (schedulingMode === "rolling_fill") {
        await runGenerationRollingFill();
      } else {
        await runGenerationWaveBarrier();
      }

      generationFinished = true;
      state.status = "COMPLETING";
      emit();
      await Promise.all(parentWorkers);

      if (fatalError) throw fatalError;
      ensureNotAborted(signal);
      state.status = "COMPLETED";
      state.finishedAt = Date.now();
      emit();
      return cloneState(state);
    } catch (error) {
      generationFinished = true;
      const fatalMessage = fatalError ? (fatalError as Error).message : null;
      if (fatalError || (!signal.aborted && error instanceof Error && error.name !== "AbortError")) {
        state.status = "FAILED";
        state.error = fatalMessage ?? toErrorMessage(error, "Batch run failed");
      } else {
        state.status = "CANCELLED";
        state.error = toErrorMessage(error, "Batch run cancelled");
      }
      state.finishedAt = Date.now();
      emit();
      abortController.abort();
      await Promise.allSettled([...rollingInFlight.values(), ...parentWorkers]);
      const cleanupLeaves = toTileCoords(allTouchedParentLeaves);
      if (cleanupLeaves.length > 0) {
        let childZ = z;
        let childTiles = cleanupLeaves;
        while (childZ > 0 && childTiles.length > 0) {
          try {
            const response = await fetchImpl(withMapTimeline("/api/parents/refresh-region", mapId, timelineIndex), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ childZ, childTiles }),
            });
            if (!response.ok) break;
            const json = (await response.json()) as unknown;
            childTiles = parseParentTilesFromResponse(json);
            childZ -= 1;
          } catch {
            break;
          }
        }
      }
      return cloneState(state);
    } finally {
      await releaseLock();
    }
  })();

  return {
    done,
    cancel: () => {
      abortController.abort();
    },
    getState: () => cloneState(state),
  };
}
