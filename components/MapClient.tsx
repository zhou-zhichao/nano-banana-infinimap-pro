"use client";

import "leaflet/dist/leaflet.css";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams as useSearchParamsHook } from "next/navigation";
import TimelineBar from "./TimelineBar";
import BatchGenerateModal, { type BatchGenerateOptions } from "./BatchGenerateModal";
import BatchStatusPanel from "./BatchStatusPanel";
import BatchReviewModal, { type BatchReviewModalItem } from "./BatchReviewModal";
import { startBatchRun, type BatchRunHandle, type StartBatchRunInput } from "@/lib/batch/executor";
import type { BatchRunState, TileBounds, TileCoord } from "@/lib/batch/types";
import type { ModelVariant } from "@/lib/modelVariant";
import { ReviewQueue, type ReviewDecision, type ReviewQueueState } from "@/lib/batch/reviewQueue";

const TileControls = dynamic(() => import("./TileControls"), { ssr: false });
const MAX_Z = Number(process.env.NEXT_PUBLIC_ZMAX ?? 8);
const DEFAULT_INITIAL_ZOOM = 3;

type Props = {
  mapId: string;
  mapWidth: number;
  mapHeight: number;
};

type TilePoint = { x: number; y: number; screenX: number; screenY: number };
type TimelineNodeItem = { index: number; id: string; createdAt: string };
type BatchReviewQueueItem = BatchReviewModalItem & {
  attempt: number;
  prompt: string;
};

function withMapTimeline(path: string, mapId: string, timelineIndex: number) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}mapId=${encodeURIComponent(mapId)}&t=${encodeURIComponent(String(timelineIndex))}`;
}

function parsePositiveInt(input: string | null, fallback: number) {
  if (!input) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseFiniteNumberParam(params: URLSearchParams, key: string) {
  const raw = params.get(key);
  if (raw == null || raw.trim() === "") return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseInitialView() {
  const params = new URLSearchParams(window.location.search);
  const parsedZoom = parseFiniteNumberParam(params, "z");
  const zoom =
    parsedZoom == null ? DEFAULT_INITIAL_ZOOM : Math.max(0, Math.min(MAX_Z, Math.round(parsedZoom)));

  const parsedLat = parseFiniteNumberParam(params, "lat");
  const parsedLng = parseFiniteNumberParam(params, "lng");
  const hasCenter = parsedLat != null && parsedLng != null;

  return {
    zoom,
    lat: hasCenter ? parsedLat : null,
    lng: hasCenter ? parsedLng : null,
    hasZoomParam: parsedZoom != null,
  };
}

function leafKey(x: number, y: number) {
  return `${x},${y}`;
}

function parseLeafKey(key: string): TileCoord | null {
  const [xRaw, yRaw] = key.split(",");
  const x = Number(xRaw);
  const y = Number(yRaw);
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  return { x, y };
}

function createAbortError(message = "Batch run aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

async function readErrorMessageFromResponse(response: Response, fallback: string) {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; detail?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail.trim();
  } catch {
    // fallback to raw response text
  }
  return text.trim() || fallback;
}

async function waitForDecisionWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw createAbortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export default function MapClient({ mapId, mapWidth, mapHeight }: Props) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const tileLayerRef = useRef<any>(null);
  const mapSessionRef = useRef(0);
  const searchParams = useSearchParamsHook();

  const [hoveredTile, setHoveredTile] = useState<TilePoint | null>(null);
  const hoveredTileRef = useRef<TilePoint | null>(null);
  const [selectedTile, setSelectedTile] = useState<TilePoint | null>(null);
  const selectedTileRef = useRef<TilePoint | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const suppressOpenUntil = useRef<number>(0);

  const [tileExists, setTileExists] = useState<Record<string, boolean>>({});
  const tileExistsRef = useRef<Record<string, boolean>>({});
  const updateTimeoutRef = useRef<any>(undefined);

  const [timelineNodes, setTimelineNodes] = useState<TimelineNodeItem[]>([]);
  const [minTimelineNodes, setMinTimelineNodes] = useState(1);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [activeTimelineIndex, setActiveTimelineIndex] = useState(() => parsePositiveInt(searchParams?.get("t") ?? null, 1));
  const activeTimelineRef = useRef(activeTimelineIndex);
  const [batchModalOpen, setBatchModalOpen] = useState(false);
  const [batchOrigin, setBatchOrigin] = useState<{ x: number; y: number } | null>(null);
  const [batchState, setBatchState] = useState<BatchRunState | null>(null);
  const batchHandleRef = useRef<BatchRunHandle | null>(null);
  const batchRunTokenRef = useRef<string | null>(null);
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewActiveItem, setReviewActiveItem] = useState<BatchReviewQueueItem | null>(null);
  const [reviewPendingItems, setReviewPendingItems] = useState<BatchReviewQueueItem[]>([]);
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewQueueRef = useRef<ReviewQueue<BatchReviewQueueItem> | null>(null);
  const cleanupPreviewIdsRef = useRef<Set<string>>(new Set());
  const runTimelineRef = useRef<number | null>(null);

  const timelineKey = useCallback((timelineIndex: number, x: number, y: number) => `${timelineIndex}:${x},${y}`, []);

  useEffect(() => {
    selectedTileRef.current = selectedTile;
  }, [selectedTile]);

  useEffect(() => {
    hoveredTileRef.current = hoveredTile;
  }, [hoveredTile]);

  useEffect(() => {
    tileExistsRef.current = tileExists;
  }, [tileExists]);

  useEffect(() => {
    activeTimelineRef.current = activeTimelineIndex;
  }, [activeTimelineIndex]);

  useEffect(() => {
    return () => {
      batchHandleRef.current?.cancel();
      batchHandleRef.current = null;
      batchRunTokenRef.current = null;
      reviewQueueRef.current?.cancelAll("Batch review cancelled");
      reviewQueueRef.current = null;
      cleanupPreviewIdsRef.current.clear();
    };
  }, []);

  const isMaxZoomTileInBounds = useCallback(
    (x: number, y: number) => x >= 0 && y >= 0 && x < mapWidth && y < mapHeight,
    [mapHeight, mapWidth],
  );

  const writeUrlState = useCallback(
    (mapInstance: any | null, timelineIndex = activeTimelineRef.current) => {
      if (typeof window === "undefined") return;
      const params = new URLSearchParams(window.location.search);
      params.set("mapId", mapId);
      params.set("t", String(timelineIndex));
      if (mapInstance) {
        const center = mapInstance.getCenter();
        const zoom = mapInstance.getZoom();
        params.set("z", String(zoom));
        params.set("lat", center.lat.toFixed(6));
        params.set("lng", center.lng.toFixed(6));
      }
      window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`);
    },
    [mapId],
  );

  const applyTimelineSelection = useCallback(
    (nextTimelineIndex: number) => {
      activeTimelineRef.current = nextTimelineIndex;
      setActiveTimelineIndex(nextTimelineIndex);
      setTileExists({});
      tileExistsRef.current = {};
      setHoveredTile(null);
      hoveredTileRef.current = null;
      setSelectedTile(null);
      selectedTileRef.current = null;
      writeUrlState(mapRef.current, nextTimelineIndex);
    },
    [writeUrlState],
  );

  const updateURL = useCallback(
    (mapInstance: any, sessionId: number, timelineIndex = activeTimelineRef.current) => {
      if (sessionId !== mapSessionRef.current || typeof window === "undefined") {
        return;
      }
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
      updateTimeoutRef.current = window.setTimeout(() => {
        if (sessionId !== mapSessionRef.current || mapRef.current !== mapInstance) return;
        writeUrlState(mapInstance, timelineIndex);
      }, 250);
    },
    [writeUrlState],
  );

  const checkTileExists = useCallback(
    async (x: number, y: number, timelineIndex = activeTimelineRef.current) => {
      if (!isMaxZoomTileInBounds(x, y)) return false;
      try {
        const response = await fetch(withMapTimeline(`/api/meta/${MAX_Z}/${x}/${y}`, mapId, timelineIndex));
        const data = await response.json();
        const exists = typeof data?.hasCurrentOverride === "boolean" ? data.hasCurrentOverride : data.status === "READY";
        if (timelineIndex === activeTimelineRef.current) {
          setTileExists((prev) => ({ ...prev, [timelineKey(timelineIndex, x, y)]: exists }));
        }
        return exists;
      } catch {
        return false;
      }
    },
    [isMaxZoomTileInBounds, mapId, timelineKey],
  );

  const refreshVisibleTiles = useCallback(
    async (timelineIndex = activeTimelineRef.current) => {
      if (!mapRef.current) return;
      const sessionId = mapSessionRef.current;
      const tileLayer = tileLayerRef.current;
      const ts = Date.now();
      const nextUrl = withMapTimeline(`/api/tiles/{z}/{x}/{y}?v=${ts}`, mapId, timelineIndex);
      if (sessionId !== mapSessionRef.current) return;
      tileLayer?.setUrl?.(nextUrl);
    },
    [mapId],
  );

  const refreshRenderedTilesForLeafCoords = useCallback(
    (leafTiles: TileCoord[], timelineIndex = activeTimelineRef.current) => {
      const mapInstance = mapRef.current;
      const tileLayer: any = tileLayerRef.current;
      if (!mapInstance || !tileLayer || leafTiles.length === 0) return;

      const currentZoom = Math.max(0, Math.min(MAX_Z, Math.round(mapInstance.getZoom())));
      const divisor = 2 ** Math.max(0, MAX_Z - currentZoom);
      const targetTileKeys = new Set<string>();
      for (const tile of leafTiles) {
        const tx = Math.floor(tile.x / divisor);
        const ty = Math.floor(tile.y / divisor);
        targetTileKeys.add(`${currentZoom}:${tx}:${ty}`);
      }
      if (targetTileKeys.size === 0) return;

      const ts = Date.now();
      const nextTemplateUrl = withMapTimeline(`/api/tiles/{z}/{x}/{y}?v=${ts}`, mapId, timelineIndex);
      tileLayer?.setUrl?.(nextTemplateUrl, true);

      const loadedTiles: Array<{ coords?: { x: number; y: number; z: number }; el?: HTMLImageElement }> = Object.values(
        tileLayer?._tiles ?? {},
      ) as Array<{ coords?: { x: number; y: number; z: number }; el?: HTMLImageElement }>;
      for (const loaded of loadedTiles) {
        const coords = loaded.coords;
        const el = loaded.el;
        if (!coords || !el) continue;
        if (!targetTileKeys.has(`${coords.z}:${coords.x}:${coords.y}`)) continue;
        el.src = withMapTimeline(`/api/tiles/${coords.z}/${coords.x}/${coords.y}?v=${ts}`, mapId, timelineIndex);
      }
    },
    [mapId],
  );

  const fitMapToLeafBounds = useCallback((tileBounds: TileBounds | null) => {
    if (!tileBounds || !mapRef.current) return;
    const mapInstance = mapRef.current;
    const southWest = mapInstance.unproject([tileBounds.minX * 256, (tileBounds.maxY + 1) * 256] as any, MAX_Z);
    const northEast = mapInstance.unproject([(tileBounds.maxX + 1) * 256, tileBounds.minY * 256] as any, MAX_Z);
    mapInstance.fitBounds(
      [
        [southWest.lat, southWest.lng],
        [northEast.lat, northEast.lng],
      ],
      { padding: [24, 24] },
    );
  }, []);

  const syncReviewQueueState = useCallback((queueState: ReviewQueueState<BatchReviewQueueItem>) => {
    setReviewActiveItem(queueState.active?.payload ?? null);
    setReviewPendingItems(queueState.pending.map((item) => item.payload));
  }, []);

  const clearReviewUiState = useCallback(() => {
    setReviewActiveItem(null);
    setReviewPendingItems([]);
    setReviewBusy(false);
  }, []);

  const deletePreviewById = useCallback(
    async (previewId: string, timelineIndex: number, signal?: AbortSignal) => {
      const response = await fetch(withMapTimeline(`/api/preview/${previewId}`, mapId, timelineIndex), {
        method: "DELETE",
        signal,
      }).catch(() => null);
      if (!response) return;
      if (!response.ok && response.status !== 404) {
        const message = await readErrorMessageFromResponse(response, "Failed to delete preview");
        console.warn(`Failed to delete preview ${previewId}: ${message}`);
      }
    },
    [mapId],
  );

  const cleanupPreviewIds = useCallback(
    async (previewIds: Set<string>, timelineIndex: number) => {
      const ids = Array.from(previewIds);
      previewIds.clear();
      if (ids.length === 0) return;
      await Promise.allSettled(ids.map((previewId) => deletePreviewById(previewId, timelineIndex)));
    },
    [deletePreviewById],
  );

  const cancelBatchRun = useCallback(() => {
    reviewQueueRef.current?.cancelAll("Batch review cancelled");
    batchHandleRef.current?.cancel();
    batchRunTokenRef.current = null;
    const timelineIndex = runTimelineRef.current;
    if (timelineIndex != null && cleanupPreviewIdsRef.current.size > 0) {
      const pending = new Set(cleanupPreviewIdsRef.current);
      cleanupPreviewIdsRef.current.clear();
      void cleanupPreviewIds(pending, timelineIndex);
    }
  }, [cleanupPreviewIds]);

  const resolveReviewDecision = useCallback(
    async (decision: ReviewDecision) => {
      if (reviewBusy) return;
      const queue = reviewQueueRef.current;
      if (!queue) return;
      setReviewBusy(true);
      queue.resolveActive(decision);
      setReviewBusy(false);
    },
    [reviewBusy],
  );

  const startBatchGenerate = useCallback(
    async (options: BatchGenerateOptions) => {
      const origin = batchOrigin ?? selectedTileRef.current;
      if (!origin) {
        throw new Error("No anchor tile selected");
      }

      reviewQueueRef.current?.cancelAll("Batch review cancelled");
      batchHandleRef.current?.cancel();
      batchRunTokenRef.current = null;
      clearReviewUiState();
      const runTimeline = activeTimelineRef.current;
      const runToken = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      batchRunTokenRef.current = runToken;
      runTimelineRef.current = runTimeline;
      let observedWaveCount = 0;
      const touchedLeafKeys = new Set<string>();
      const runCleanupPreviewIds = new Set<string>();
      cleanupPreviewIdsRef.current = runCleanupPreviewIds;
      setReviewEnabled(options.requireReview);

      const reviewQueue = options.requireReview
        ? new ReviewQueue<BatchReviewQueueItem>({
            onChange: (queueState) => {
              if (reviewQueueRef.current !== reviewQueue) return;
              syncReviewQueueState(queueState);
            },
          })
        : null;

      reviewQueueRef.current = reviewQueue;
      if (!reviewQueue) {
        clearReviewUiState();
      }

      const executeAnchor: StartBatchRunInput["executeAnchor"] =
        reviewQueue != null
          ? async (anchor, ctx) => {
              let nextVariant: ModelVariant = options.modelVariant;
              while (true) {
                if (ctx.signal.aborted) throw createAbortError();

                const editResponse = await fetch(
                  withMapTimeline(`/api/edit-tile/${MAX_Z}/${anchor.x}/${anchor.y}`, mapId, runTimeline),
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ prompt: options.prompt, modelVariant: nextVariant }),
                    signal: ctx.signal,
                  },
                );
                if (!editResponse.ok) {
                  const message = await readErrorMessageFromResponse(editResponse, "Failed to edit tile");
                  throw new Error(message);
                }
                const editJson = (await editResponse.json().catch(() => ({}))) as { previewId?: unknown };
                const previewId = typeof editJson.previewId === "string" ? editJson.previewId : null;
                if (!previewId) {
                  throw new Error("Invalid /api/edit-tile response: missing previewId");
                }
                runCleanupPreviewIds.add(previewId);

                let decision: ReviewDecision;
                try {
                  decision = await waitForDecisionWithAbort(
                    reviewQueue.enqueue({
                      anchorId: anchor.id,
                      x: anchor.x,
                      y: anchor.y,
                      z: MAX_Z,
                      previewId,
                      timelineIndex: runTimeline,
                      modelVariant: nextVariant,
                      attempt: ctx.attempt,
                      prompt: options.prompt,
                    }),
                    ctx.signal,
                  );
                } catch (error) {
                  await deletePreviewById(previewId, runTimeline, ctx.signal).catch(() => null);
                  runCleanupPreviewIds.delete(previewId);
                  throw error;
                }

                if (decision === "REJECT") {
                  await deletePreviewById(previewId, runTimeline, ctx.signal).catch(() => null);
                  runCleanupPreviewIds.delete(previewId);
                  nextVariant = "nano_banana_pro";
                  continue;
                }

                const confirmResponse = await fetch(
                  withMapTimeline(`/api/confirm-edit/${MAX_Z}/${anchor.x}/${anchor.y}`, mapId, runTimeline),
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      previewUrl: withMapTimeline(`/api/preview/${previewId}`, mapId, runTimeline),
                      previewMode: "blended",
                      skipParentRefresh: true,
                    }),
                    signal: ctx.signal,
                  },
                );
                if (!confirmResponse.ok) {
                  const message = await readErrorMessageFromResponse(confirmResponse, "Failed to confirm edit");
                  await deletePreviewById(previewId, runTimeline, ctx.signal).catch(() => null);
                  runCleanupPreviewIds.delete(previewId);
                  throw new Error(message);
                }

                runCleanupPreviewIds.delete(previewId);
                return;
              }
            }
          : undefined;

      const handle = startBatchRun({
        mapId,
        timelineIndex: runTimeline,
        z: MAX_Z,
        originX: origin.x,
        originY: origin.y,
        mapWidth,
        mapHeight,
        layers: options.layers,
        maxParallel: options.maxParallel,
        schedulingMode: options.requireReview ? "rolling_fill" : "wave_barrier",
        prompt: options.prompt,
        modelVariant: options.modelVariant,
        executeAnchor,
        onState: (nextState) => {
          if (batchRunTokenRef.current !== runToken) return;
          setBatchState(nextState);
          if (nextState.waves.length > observedWaveCount) {
            const updatedLeafKeys = new Set<string>();
            for (let i = observedWaveCount; i < nextState.waves.length; i++) {
              const wave = nextState.waves[i];
              for (const anchorId of wave.successIds) {
                const anchor = nextState.anchors[anchorId];
                if (!anchor) continue;
                for (let dy = -1; dy <= 1; dy++) {
                  for (let dx = -1; dx <= 1; dx++) {
                    const tileX = anchor.x + dx;
                    const tileY = anchor.y + dy;
                    if (!isMaxZoomTileInBounds(tileX, tileY)) continue;
                    const key = leafKey(tileX, tileY);
                    updatedLeafKeys.add(key);
                    touchedLeafKeys.add(key);
                  }
                }
              }
            }
            observedWaveCount = nextState.waves.length;

            if (updatedLeafKeys.size > 0) {
              const updatedLeaves = Array.from(updatedLeafKeys)
                .map(parseLeafKey)
                .filter((tile): tile is TileCoord => tile !== null);
              refreshRenderedTilesForLeafCoords(updatedLeaves, runTimeline);
            }
          }
        },
      });

      batchHandleRef.current = handle;
      const initialState = handle.getState();
      setBatchState(initialState);
      fitMapToLeafBounds(initialState.coverageBounds);
      setBatchModalOpen(false);

      void handle.done
        .then((finalState) => {
          if (batchRunTokenRef.current !== runToken) return;
          if (batchHandleRef.current !== handle) return;
          setBatchState(finalState);
          const touchedLeaves = Array.from(touchedLeafKeys)
            .map(parseLeafKey)
            .filter((tile): tile is TileCoord => tile !== null);
          if (touchedLeaves.length > 0) {
            refreshRenderedTilesForLeafCoords(touchedLeaves, runTimeline);
          } else {
            void refreshVisibleTiles(runTimeline);
          }
        })
        .catch(() => {})
        .finally(async () => {
          if (batchRunTokenRef.current === runToken) {
            batchRunTokenRef.current = null;
          }
          if (reviewQueueRef.current === reviewQueue) {
            reviewQueueRef.current?.cancelAll("Batch run finished");
            reviewQueueRef.current = null;
          }
          await cleanupPreviewIds(runCleanupPreviewIds, runTimeline);
          if (batchHandleRef.current === handle) {
            clearReviewUiState();
            setReviewEnabled(false);
            runTimelineRef.current = null;
            cleanupPreviewIdsRef.current.clear();
          }
          if (batchHandleRef.current === handle) {
            batchHandleRef.current = null;
          }
        });
    },
    [
      batchOrigin,
      cleanupPreviewIds,
      clearReviewUiState,
      deletePreviewById,
      fitMapToLeafBounds,
      isMaxZoomTileInBounds,
      mapHeight,
      mapId,
      mapWidth,
      refreshRenderedTilesForLeafCoords,
      refreshVisibleTiles,
      syncReviewQueueState,
    ],
  );

  const handleDelete = useCallback(
    async (x: number, y: number) => {
      const timelineIndex = activeTimelineRef.current;
      const response = await fetch(withMapTimeline(`/api/delete/${MAX_Z}/${x}/${y}`, mapId, timelineIndex), { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Failed to delete tile");
      }
      setTileExists((prev) => ({ ...prev, [timelineKey(timelineIndex, x, y)]: false }));
      refreshRenderedTilesForLeafCoords([{ x, y }], timelineIndex);
    },
    [mapId, refreshRenderedTilesForLeafCoords, timelineKey],
  );

  const reloadTimeline = useCallback(
    async (fallbackIndex = activeTimelineRef.current) => {
      const response = await fetch(withMapTimeline("/api/timeline", mapId, fallbackIndex));
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load timeline");
      }
      const nodes = Array.isArray(data.nodes) ? (data.nodes as TimelineNodeItem[]) : [];
      const minNodes = typeof data.minNodes === "number" ? data.minNodes : 1;
      setTimelineNodes(nodes);
      setMinTimelineNodes(minNodes);
      const maxIndex = Math.max(1, nodes.length);
      const clamped = Math.min(Math.max(fallbackIndex, 1), maxIndex);
      return { nodes, minNodes, clamped };
    },
    [mapId],
  );

  const handleAddTimelineNode = useCallback(async () => {
    const afterIndex = activeTimelineRef.current;
    setTimelineLoading(true);
    try {
      const response = await fetch(withMapTimeline("/api/timeline", mapId, afterIndex), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ afterIndex }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to add node");
      }

      const nodes = Array.isArray(data.nodes) ? (data.nodes as TimelineNodeItem[]) : [];
      const minNodes = typeof data.minNodes === "number" ? data.minNodes : 1;
      setTimelineNodes(nodes);
      setMinTimelineNodes(minNodes);
      const nextIndex = parsePositiveInt(String(data.insertedIndex ?? afterIndex + 1), afterIndex + 1);
      const clamped = Math.min(nextIndex, Math.max(1, nodes.length));
      applyTimelineSelection(clamped);
      await refreshVisibleTiles(clamped);
    } catch (error) {
      console.error(error);
    } finally {
      setTimelineLoading(false);
    }
  }, [applyTimelineSelection, mapId, refreshVisibleTiles]);

  const handleDeleteTimelineNode = useCallback(async () => {
    const index = activeTimelineRef.current;
    setTimelineLoading(true);
    try {
      const response = await fetch(withMapTimeline("/api/timeline", mapId, index), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete node");
      }

      const nodes = Array.isArray(data.nodes) ? (data.nodes as TimelineNodeItem[]) : [];
      const minNodes = typeof data.minNodes === "number" ? data.minNodes : 1;
      setTimelineNodes(nodes);
      setMinTimelineNodes(minNodes);
      const fallback = parsePositiveInt(String(data.activeIndex ?? index), Math.max(1, Math.min(index, nodes.length)));
      const nextIndex = Math.min(fallback, Math.max(1, nodes.length));
      applyTimelineSelection(nextIndex);
      await refreshVisibleTiles(nextIndex);
    } catch (error) {
      console.error(error);
    } finally {
      setTimelineLoading(false);
    }
  }, [applyTimelineSelection, mapId, refreshVisibleTiles]);

  useEffect(() => {
    let cancelled = false;
    setTimelineLoading(true);
    void reloadTimeline(activeTimelineRef.current)
      .then(({ clamped }) => {
        if (cancelled) return;
        applyTimelineSelection(clamped);
      })
      .catch((error) => {
        console.error(error);
      })
      .finally(() => {
        if (!cancelled) setTimelineLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyTimelineSelection, reloadTimeline]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!selectedTileRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.closest("[data-dialog-root]") ||
          target.closest("[data-radix-popper-content-wrapper]") ||
          target.closest('[role="dialog"]'))
      ) {
        return;
      }
      if (menuRef.current && menuRef.current.contains(event.target as Node)) return;
      setSelectedTile(null);
      selectedTileRef.current = null;
      suppressOpenUntil.current = performance.now() + 250;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;

    let cancelled = false;
    const sessionId = mapSessionRef.current + 1;
    mapSessionRef.current = sessionId;

    void import("leaflet").then((L) => {
      if (cancelled || sessionId !== mapSessionRef.current || !mapElementRef.current) return;

      const initialView = parseInitialView();

      const mapInstance: any = L.map(mapElementRef.current, {
        crs: L.CRS.Simple,
        minZoom: 0,
        maxZoom: MAX_Z,
        zoom: initialView.zoom,
      });
      mapElementRef.current.style.background = "#000";
      mapInstance.getContainer().style.background = "#000";
      mapRef.current = mapInstance;

      const worldWidth = mapWidth * 256;
      const worldHeight = mapHeight * 256;
      const southWest = mapInstance.unproject([0, worldHeight] as any, MAX_Z);
      const northEast = mapInstance.unproject([worldWidth, 0] as any, MAX_Z);
      const bounds = new L.LatLngBounds(southWest, northEast);
      mapInstance.setMaxBounds(bounds);

      if (initialView.lat != null && initialView.lng != null) {
        mapInstance.setView([initialView.lat, initialView.lng], initialView.zoom);
      } else {
        mapInstance.setView(bounds.getCenter(), initialView.zoom);
      }

      const url = withMapTimeline(`/api/tiles/{z}/{x}/{y}?v=${Date.now()}`, mapId, activeTimelineRef.current);
      const tileLayer = L.tileLayer(url, {
        tileSize: 256,
        minZoom: 0,
        maxZoom: MAX_Z,
        noWrap: true,
        updateWhenIdle: false,
        updateWhenZooming: false,
        keepBuffer: 0,
      });
      tileLayer.addTo(mapInstance);
      tileLayerRef.current = tileLayer;

      mapInstance.on("moveend", () => updateURL(mapInstance, sessionId));
      mapInstance.on("zoomend", () => updateURL(mapInstance, sessionId));

      const updateSelectedPosition = () => {
        const current = selectedTileRef.current;
        if (!current) return;
        const tileCenterWorld = L.point((current.x + 0.5) * 256, (current.y + 0.5) * 256);
        const tileCenterLatLng = mapInstance.unproject(tileCenterWorld, mapInstance.getZoom());
        const tileCenterScreen = mapInstance.latLngToContainerPoint(tileCenterLatLng);
        setSelectedTile((prev) => (prev ? { ...prev, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y } : prev));
      };
      mapInstance.on("move", updateSelectedPosition);
      mapInstance.on("zoomend", updateSelectedPosition);

      mapInstance.on("mousemove", (event: any) => {
        if (mapInstance.getZoom() !== mapInstance.getMaxZoom()) {
          setHoveredTile(null);
          mapInstance.getContainer().style.cursor = "";
          return;
        }

        const projected = mapInstance.project(event.latlng, mapInstance.getZoom());
        const x = Math.floor(projected.x / 256);
        const y = Math.floor(projected.y / 256);
        if (!isMaxZoomTileInBounds(x, y)) {
          setHoveredTile(null);
          mapInstance.getContainer().style.cursor = "";
          return;
        }

        const currentHovered = hoveredTileRef.current;
        if (!currentHovered || currentHovered.x !== x || currentHovered.y !== y) {
          const tileCenterWorld = L.point((x + 0.5) * 256, (y + 0.5) * 256);
          const tileCenterLatLng = mapInstance.unproject(tileCenterWorld, mapInstance.getZoom());
          const tileCenterScreen = mapInstance.latLngToContainerPoint(tileCenterLatLng);
          setHoveredTile({ x, y, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y });
          mapInstance.getContainer().style.cursor = "pointer";
          const t = activeTimelineRef.current;
          const key = timelineKey(t, x, y);
          if (!(key in tileExistsRef.current)) void checkTileExists(x, y, t);
        }
      });

      mapInstance.on("mouseleave", () => {
        setHoveredTile(null);
        mapInstance.getContainer().style.cursor = "";
      });

      mapInstance.on("zoomstart", () => {
        setHoveredTile(null);
        setSelectedTile(null);
      });

      mapInstance.on("click", (event: any) => {
        if (mapInstance.getZoom() !== mapInstance.getMaxZoom()) return;
        if (performance.now() < suppressOpenUntil.current) return;

        const projected = mapInstance.project(event.latlng, mapInstance.getZoom());
        const x = Math.floor(projected.x / 256);
        const y = Math.floor(projected.y / 256);
        if (!isMaxZoomTileInBounds(x, y)) return;

        if (selectedTileRef.current) {
          setSelectedTile(null);
          selectedTileRef.current = null;
          return;
        }

        const tileCenterWorld = L.point((x + 0.5) * 256, (y + 0.5) * 256);
        const tileCenterLatLng = mapInstance.unproject(tileCenterWorld, mapInstance.getZoom());
        const tileCenterScreen = mapInstance.latLngToContainerPoint(tileCenterLatLng);
        setSelectedTile({ x, y, screenX: tileCenterScreen.x, screenY: tileCenterScreen.y });
        const t = activeTimelineRef.current;
        const key = timelineKey(t, x, y);
        if (!(key in tileExistsRef.current)) void checkTileExists(x, y, t);
      });

      if (!initialView.hasZoomParam) writeUrlState(mapInstance, activeTimelineRef.current);
    });

    return () => {
      cancelled = true;
      mapSessionRef.current += 1;
      if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
      tileLayerRef.current = null;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      hoveredTileRef.current = null;
      selectedTileRef.current = null;
    };
  }, [checkTileExists, isMaxZoomTileInBounds, mapHeight, mapId, mapWidth, timelineKey, updateURL, writeUrlState]);

  const batchRunning = batchState?.status === "RUNNING" || batchState?.status === "COMPLETING";
  const reviewStatus = {
    enabled: reviewEnabled,
    active: reviewActiveItem ? 1 : 0,
    queued: reviewPendingItems.length,
  };

  return (
    <div className="w-full h-full relative">
      <div className="p-3 z-10 absolute top-2 left-2 bg-white/90 rounded-xl shadow-lg flex flex-col gap-2">
        <div className="text-sm text-gray-600">
          {mapRef.current && mapRef.current.getZoom() === MAX_Z ? "Hover to highlight, click to open menu" : "Zoom to max level"}
        </div>
        <div className="text-xs text-gray-400">
          map={mapId} size={mapWidth}x{mapHeight}
        </div>
        <div className="text-xs text-gray-400">Timeline: {activeTimelineIndex}</div>
      </div>

      {hoveredTile && !selectedTile && mapRef.current && mapRef.current.getZoom() === MAX_Z && (
        <div
          className="absolute"
          style={{
            left: hoveredTile.screenX - 128,
            top: hoveredTile.screenY - 128,
            width: 256,
            height: 256,
            background: "rgba(255,255,255,0.12)",
            pointerEvents: "none",
            zIndex: 1000,
          }}
        />
      )}

      {selectedTile && mapRef.current && mapRef.current.getZoom() === MAX_Z && (
        <div
          className="absolute pointer-events-none"
          style={{ left: selectedTile.screenX, top: selectedTile.screenY, transform: "translate(-50%, -50%)", zIndex: 500 }}
        >
          <div
            ref={menuRef}
            className="pointer-events-auto bg-white rounded-lg shadow-xl p-2 border border-gray-200"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-xs text-gray-500 mb-1">
              Tile ({selectedTile.x}, {selectedTile.y})
            </div>
            <TileControls
              mapId={mapId}
              timelineIndex={activeTimelineIndex}
              x={selectedTile.x}
              y={selectedTile.y}
              z={MAX_Z}
              exists={tileExists[timelineKey(activeTimelineIndex, selectedTile.x, selectedTile.y)] || false}
              onDelete={() => handleDelete(selectedTile.x, selectedTile.y)}
              onBatchGenerate={() => {
                setBatchOrigin({ x: selectedTile.x, y: selectedTile.y });
                setBatchModalOpen(true);
              }}
              onRefreshTiles={() => {
                const t = activeTimelineRef.current;
                setTimeout(() => {
                  void refreshVisibleTiles(t);
                  setTileExists((prev) => ({ ...prev, [timelineKey(t, selectedTile.x, selectedTile.y)]: true }));
                }, 50);
              }}
            />
          </div>
        </div>
      )}

      {batchOrigin && (
        <BatchGenerateModal
          open={batchModalOpen}
          running={batchRunning}
          originX={batchOrigin.x}
          originY={batchOrigin.y}
          onClose={() => setBatchModalOpen(false)}
          onSubmit={startBatchGenerate}
        />
      )}

      <BatchReviewModal
        open={batchRunning && reviewStatus.enabled && reviewActiveItem != null}
        mapId={mapId}
        item={reviewActiveItem}
        pendingCount={reviewStatus.queued}
        busy={reviewBusy}
        onAccept={() => resolveReviewDecision("ACCEPT")}
        onReject={() => resolveReviewDecision("REJECT")}
        onCancelBatch={cancelBatchRun}
      />

      <BatchStatusPanel state={batchState} onCancel={cancelBatchRun} review={reviewStatus} />

      {timelineNodes.length > 0 && (
        <TimelineBar
          nodes={timelineNodes}
          activeIndex={activeTimelineIndex}
          minNodes={minTimelineNodes}
          loading={timelineLoading}
          onSelect={(idx) => {
            if (idx === activeTimelineRef.current) return;
            applyTimelineSelection(idx);
            void refreshVisibleTiles(idx);
          }}
          onAddAfterActive={() => {
            void handleAddTimelineNode();
          }}
          onDeleteActive={() => {
            void handleDeleteTimelineNode();
          }}
        />
      )}

      <div ref={mapElementRef} className="w-full h-full" />
    </div>
  );
}
