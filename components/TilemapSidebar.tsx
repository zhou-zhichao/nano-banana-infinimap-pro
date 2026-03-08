"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getParentGenerationPercent, type ParentGenerationStatus } from "@/lib/parentGenerationProgress";
import type { TilemapManifest, TilemapTemplate } from "@/lib/tilemaps/types";
import { formatCounter, toPercent, type RateLimitStatusResponse } from "@/lib/rateLimitStatus";
import { DEFAULT_MAP_ID } from "@/lib/tilemaps/constants";

type Props = {
  tilemaps: TilemapManifest[];
  activeMapId: string;
  onSelect: (mapId: string) => void;
  onCreated: (map: TilemapManifest) => void;
  onDeleted: (mapId: string) => void;
};

const DEFAULT_BLANK_WIDTH = 64;
const DEFAULT_BLANK_HEIGHT = 64;

function parseTimelineIndex(value: string | null) {
  if (!value) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function buildParentGenerationUrl(mapId: string, timelineIndex: number) {
  return `/api/generate-parents?mapId=${encodeURIComponent(mapId)}&t=${encodeURIComponent(String(timelineIndex))}`;
}

async function readJsonPayload(response: Response, fallbackMessage: string) {
  const text = await response.text().catch(() => "");
  if (!text.trim()) return {} as Record<string, unknown>;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const trimmed = text.trim();
    if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html")) {
      throw new Error(fallbackMessage);
    }
    throw new Error(trimmed || fallbackMessage);
  }
}

export default function TilemapSidebar({ tilemaps, activeMapId, onSelect, onCreated, onDeleted }: Props) {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TilemapTemplate>("blank");
  const [width, setWidth] = useState(DEFAULT_BLANK_WIDTH);
  const [height, setHeight] = useState(DEFAULT_BLANK_HEIGHT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingMapId, setDeletingMapId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshingParents, setRefreshingParents] = useState(false);
  const [refreshParentsError, setRefreshParentsError] = useState<string | null>(null);
  const [parentGeneration, setParentGeneration] = useState<ParentGenerationStatus | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitStatusResponse | null>(null);
  const [rateLimitError, setRateLimitError] = useState<string | null>(null);

  const items = useMemo(() => tilemaps, [tilemaps]);
  const activeMap = useMemo(() => items.find((item) => item.id === activeMapId) ?? null, [activeMapId, items]);
  const activeTimelineIndex = useMemo(() => parseTimelineIndex(searchParams.get("t")), [searchParams]);
  const parentGenerationPercent = useMemo(() => getParentGenerationPercent(parentGeneration), [parentGeneration]);
  const parentGenerationRunning = parentGeneration?.state === "RUNNING";
  const modelEntries = useMemo(
    () =>
      rateLimit
        ? [
            { key: "nano_banana_flash_preview" as const, data: rateLimit.models.nano_banana_flash_preview },
            { key: "nano_banana" as const, data: rateLimit.models.nano_banana },
            { key: "nano_banana_pro" as const, data: rateLimit.models.nano_banana_pro },
          ]
        : [],
    [rateLimit],
  );

  useEffect(() => {
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const fallbackPollMs = 5_000;

    const poll = async () => {
      try {
        const response = await fetch("/api/rate-limit-status", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Failed to load rate limit status");
        }
        if (disposed) return;
        setRateLimit(data as RateLimitStatusResponse);
        setRateLimitError(null);
        const nextMs = Number((data as any)?.poll_ms);
        const delay = Number.isFinite(nextMs) && nextMs > 0 ? Math.floor(nextMs) : fallbackPollMs;
        timeout = setTimeout(poll, delay);
      } catch (err) {
        if (disposed) return;
        setRateLimitError(err instanceof Error ? err.message : "Failed to load rate limit status");
        timeout = setTimeout(poll, fallbackPollMs);
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (!activeMap) {
      setParentGeneration(null);
      setRefreshParentsError(null);
      return;
    }

    setParentGeneration(null);
    setRefreshParentsError(null);

    let disposed = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const idlePollMs = 15_000;
    const runningPollMs = 1_000;

    const poll = async () => {
      try {
        const response = await fetch(buildParentGenerationUrl(activeMap.id, activeTimelineIndex), { cache: "no-store" });
        const data = await readJsonPayload(response, "Parent generation status temporarily unavailable");
        if (!response.ok) {
          throw new Error(
            typeof data?.error === "string" && data.error.trim()
              ? data.error.trim()
              : "Failed to load parent generation status",
          );
        }
        if (disposed) return;
        const nextStatus = (data?.status ?? null) as ParentGenerationStatus | null;
        setParentGeneration(nextStatus);
        if (nextStatus?.state === "FAILED") {
          setRefreshParentsError(nextStatus.error || "Parent regeneration failed");
        } else {
          setRefreshParentsError(null);
        }
        timeout = setTimeout(poll, nextStatus?.state === "RUNNING" ? runningPollMs : idlePollMs);
      } catch (err) {
        if (disposed) return;
        setRefreshParentsError(err instanceof Error ? err.message : "Failed to load parent generation status");
        timeout = setTimeout(poll, idlePollMs);
      }
    };

    void poll();
    return () => {
      disposed = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [activeMap, activeTimelineIndex]);

  const resetForm = () => {
    setName("");
    setTemplate("blank");
    setWidth(DEFAULT_BLANK_WIDTH);
    setHeight(DEFAULT_BLANK_HEIGHT);
    setSubmitting(false);
    setError(null);
  };

  const createTilemap = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const payload =
        template === "moon"
          ? { name: name.trim(), template }
          : { name: name.trim(), template, width: Math.round(width), height: Math.round(height) };
      const response = await fetch("/api/tilemaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create tilemap");
      }
      onCreated(data.item as TilemapManifest);
      setOpen(false);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tilemap");
      setSubmitting(false);
    }
  };

  const openCreateModal = () => {
    setOpen(true);
    resetForm();
  };

  const removeTilemap = async (map: TilemapManifest) => {
    if (map.id === DEFAULT_MAP_ID) return;
    const confirmed = window.confirm(`Delete tilemap "${map.name}"? This cannot be undone.`);
    if (!confirmed) return;

    setDeleteError(null);
    setDeletingMapId(map.id);
    try {
      const response = await fetch("/api/tilemaps", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapId: map.id }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete tilemap");
      }
      onDeleted(map.id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete tilemap");
    } finally {
      setDeletingMapId(null);
    }
  };

  const refreshCurrentTilemapParents = async () => {
    if (!activeMap) return;
    const confirmed = window.confirm(`Regenerate parent hierarchy for "${activeMap.name}"?`);
    if (!confirmed) return;

    setRefreshingParents(true);
    setRefreshParentsError(null);
    try {
      const response = await fetch(buildParentGenerationUrl(activeMap.id, activeTimelineIndex), {
        method: "POST",
      });
      const data = await readJsonPayload(response, "Failed to start parent regeneration");
      if (!response.ok) {
        throw new Error(
          typeof data?.error === "string" && data.error.trim()
            ? data.error.trim()
            : "Failed to start parent regeneration",
        );
      }
      setParentGeneration(((data?.status ?? null) as ParentGenerationStatus | null) ?? null);
    } catch (err) {
      setRefreshParentsError(err instanceof Error ? err.message : "Failed to start parent regeneration");
    } finally {
      setRefreshingParents(false);
    }
  };

  return (
    <aside
      className={`${collapsed ? "w-14" : "w-72"} border-r border-gray-200 bg-gray-50/90 h-full flex flex-col transition-[width] duration-200`}
    >
      <div
        className={`${collapsed ? "px-2 justify-center" : "px-4 justify-between"} py-3 border-b border-gray-200 flex items-center gap-2`}
      >
        {!collapsed && (
          <div>
            <div className="text-sm font-semibold text-gray-900">Tilemaps</div>
            <div className="text-xs text-gray-500">{items.length} total</div>
          </div>
        )}

        {!collapsed && (
          <div className="flex items-center gap-2">
            <button
              className="h-8 px-3 rounded-md border border-gray-300 bg-white text-gray-700 text-xs font-medium hover:bg-gray-100 disabled:opacity-60"
              onClick={() => {
                void refreshCurrentTilemapParents();
              }}
              disabled={refreshingParents || parentGenerationRunning || !activeMap}
              title="Regenerate parent hierarchy for current tilemap"
              aria-label="Regenerate parent hierarchy for current tilemap"
            >
              {refreshingParents ? "Starting..." : parentGenerationRunning ? "Running..." : "Regen Map"}
            </button>
            <button
              className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
              onClick={openCreateModal}
            >
              New
            </button>
          </div>
        )}

        <button
          className="h-8 w-8 rounded-md border border-gray-300 bg-white text-gray-700 text-sm hover:bg-gray-100"
          onClick={() => setCollapsed((prev) => !prev)}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? ">" : "<"}
        </button>
      </div>

      {collapsed ? (
        <div className="flex-1 p-2 flex flex-col items-center gap-2">
          <button
            className="h-8 w-8 rounded-md border border-gray-300 bg-white text-[10px] font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60"
            onClick={() => {
              void refreshCurrentTilemapParents();
            }}
            disabled={refreshingParents || parentGenerationRunning || !activeMap}
            title="Regenerate parent hierarchy for current tilemap"
            aria-label="Regenerate parent hierarchy for current tilemap"
          >
            {refreshingParents || parentGenerationRunning ? "..." : "M"}
          </button>
          <button
            className="h-8 w-8 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            onClick={openCreateModal}
            title="Create tilemap"
            aria-label="Create tilemap"
          >
            +
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-2">
          {refreshParentsError && (
            <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{refreshParentsError}</div>
          )}
          {parentGeneration && parentGeneration.state !== "IDLE" && (
            <div className="mb-2 rounded-md border border-blue-200 bg-white px-2 py-2 text-xs text-gray-700">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold text-gray-900">Parent Regen</div>
                <div className="text-[11px] text-gray-500">{parentGenerationPercent}%</div>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded bg-gray-200">
                <div
                  className={`h-full rounded transition-[width] duration-300 ${
                    parentGeneration.state === "FAILED"
                      ? "bg-red-500"
                      : parentGeneration.state === "COMPLETED"
                        ? "bg-green-500"
                        : "bg-blue-500"
                  }`}
                  style={{ width: `${parentGenerationPercent}%` }}
                />
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-gray-600">
                <span>
                  {parentGeneration.processedTiles}/{parentGeneration.totalTiles || 0} processed
                </span>
                <span>z={parentGeneration.currentZ == null ? "-" : parentGeneration.currentZ}</span>
              </div>
              <div className="mt-1 text-[11px] text-gray-600">
                generated {parentGeneration.generatedTiles} | skipped {parentGeneration.skippedTiles}
              </div>
              {parentGeneration.message && <div className="mt-1 text-[11px] text-gray-600">{parentGeneration.message}</div>}
              {parentGeneration.error && <div className="mt-1 text-[11px] text-red-600">{parentGeneration.error}</div>}
            </div>
          )}
          <div className="mb-3 rounded-md border border-gray-200 bg-white p-2">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-xs font-semibold text-gray-800">Gemini Quota</div>
              <div className="text-[10px] text-gray-500">keys: {rateLimit?.key_pool_size ?? 0}</div>
            </div>
            {rateLimitError && <div className="text-[11px] text-red-600">{rateLimitError}</div>}
            {!rateLimitError && !rateLimit && <div className="text-[11px] text-gray-500">Loading quota...</div>}
            {!rateLimitError && rateLimit && (
              <div className="space-y-2">
                {modelEntries.map(({ key, data }) => (
                  <div key={key} className="rounded border border-gray-100 bg-gray-50 px-2 py-1.5">
                    <div className="mb-1 flex items-center justify-between">
                      <span className="text-[11px] font-medium text-gray-700">{data.label}</span>
                      {rateLimit.enabled && data.exhausted && (
                        <span className="text-[10px] font-medium text-red-600">Rate Limited</span>
                      )}
                    </div>
                    <div className="space-y-1">
                      {[
                        { label: "RPM", stat: data.rpm },
                        { label: "RPD", stat: data.rpd },
                      ].map((item) => (
                        <div key={item.label}>
                          <div className="mb-0.5 flex items-center justify-between text-[10px] text-gray-600">
                            <span>{item.label}</span>
                            <span>{formatCounter(item.stat.used, item.stat.limit)}</span>
                          </div>
                          <div className="h-1.5 rounded bg-gray-200">
                            <div
                              className={`h-1.5 rounded ${rateLimit.enabled && data.exhausted ? "bg-red-500" : "bg-blue-500"}`}
                              style={{ width: `${toPercent(item.stat.used, item.stat.limit)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    {rateLimit.enabled && data.exhausted && data.retry_after_seconds > 0 && (
                      <div className="mt-1 text-[10px] text-red-600">Retry in ~{data.retry_after_seconds}s</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {deleteError && <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{deleteError}</div>}

          {items.map((item) => {
            const active = item.id === activeMapId;
            const deleting = deletingMapId === item.id;
            return (
              <div key={item.id} className="mb-1 flex items-stretch gap-1">
                <button
                  className={`flex-1 text-left rounded-md px-3 py-2 border transition-colors ${
                    active ? "bg-blue-600 text-white border-blue-700" : "bg-white text-gray-800 border-gray-200 hover:bg-gray-100"
                  }`}
                  onClick={() => onSelect(item.id)}
                >
                  <div className="text-sm font-medium truncate">{item.name}</div>
                  <div className={`text-[11px] ${active ? "text-blue-100" : "text-gray-500"}`}>
                    {item.id} · {item.template} · {item.width}x{item.height}
                  </div>
                </button>

                {item.id !== DEFAULT_MAP_ID && (
                  <button
                    className="w-14 rounded-md border border-red-200 bg-red-50 text-[11px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
                    onClick={() => {
                      void removeTilemap(item);
                    }}
                    disabled={deletingMapId !== null}
                    title="Delete tilemap"
                    aria-label="Delete tilemap"
                  >
                    {deleting ? "..." : "Delete"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 bg-black/30 z-[10020] flex items-center justify-center p-4">
          <div className="w-[420px] rounded-xl bg-white shadow-xl border border-gray-200 p-4">
            <div className="text-base font-semibold text-gray-900 mb-3">Create Tilemap</div>
            <div className="space-y-3">
              <label className="block">
                <div className="text-xs text-gray-600 mb-1">Name</div>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full h-9 px-2 rounded border border-gray-300 text-sm"
                  placeholder="e.g. crater-west"
                />
              </label>

              <div>
                <div className="text-xs text-gray-600 mb-1">Template</div>
                <div className="inline-flex rounded-md border border-gray-300 overflow-hidden">
                  <button
                    className={`px-3 h-8 text-xs ${template === "blank" ? "bg-blue-600 text-white" : "bg-white text-gray-700"}`}
                    onClick={() => setTemplate("blank")}
                  >
                    blank
                  </button>
                  <button
                    className={`px-3 h-8 text-xs border-l border-gray-300 ${
                      template === "moon" ? "bg-blue-600 text-white" : "bg-white text-gray-700"
                    }`}
                    onClick={() => setTemplate("moon")}
                  >
                    moon
                  </button>
                </div>
              </div>

              {template === "blank" ? (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <div className="text-xs text-gray-600 mb-1">Width</div>
                    <input
                      type="number"
                      min={1}
                      max={256}
                      value={width}
                      onChange={(event) => setWidth(Number(event.target.value))}
                      className="w-full h-9 px-2 rounded border border-gray-300 text-sm"
                    />
                  </label>
                  <label className="block">
                    <div className="text-xs text-gray-600 mb-1">Height</div>
                    <input
                      type="number"
                      min={1}
                      max={256}
                      value={height}
                      onChange={(event) => setHeight(Number(event.target.value))}
                      className="w-full h-9 px-2 rounded border border-gray-300 text-sm"
                    />
                  </label>
                </div>
              ) : (
                <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-md p-2">
                  moon is fixed at index range 0..60 x 0..40 (actual 61x41 tiles).
                </div>
              )}

              {error && <div className="text-xs text-red-600">{error}</div>}
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="h-8 px-3 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
                onClick={() => {
                  setOpen(false);
                  resetForm();
                }}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                className="h-8 px-3 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                onClick={createTilemap}
                disabled={submitting || !name.trim()}
              >
                {submitting ? "Creating..." : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
