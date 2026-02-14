"use client";

import { useEffect, useMemo, useState } from "react";
import type { TilemapManifest, TilemapTemplate } from "@/lib/tilemaps/types";
import { formatCounter, toPercent, type RateLimitStatusResponse } from "@/lib/rateLimitStatus";

type Props = {
  tilemaps: TilemapManifest[];
  activeMapId: string;
  onSelect: (mapId: string) => void;
  onCreated: (map: TilemapManifest) => void;
};

const DEFAULT_BLANK_WIDTH = 64;
const DEFAULT_BLANK_HEIGHT = 64;

export default function TilemapSidebar({ tilemaps, activeMapId, onSelect, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<TilemapTemplate>("blank");
  const [width, setWidth] = useState(DEFAULT_BLANK_WIDTH);
  const [height, setHeight] = useState(DEFAULT_BLANK_HEIGHT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimit, setRateLimit] = useState<RateLimitStatusResponse | null>(null);
  const [rateLimitError, setRateLimitError] = useState<string | null>(null);

  const items = useMemo(() => tilemaps, [tilemaps]);
  const modelEntries = useMemo(
    () =>
      rateLimit
        ? [
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
          <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700" onClick={openCreateModal}>
            New
          </button>
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
        <div className="flex-1 p-2 flex items-start justify-center">
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

          {items.map((item) => {
            const active = item.id === activeMapId;
            return (
              <button
                key={item.id}
                className={`w-full text-left rounded-md px-3 py-2 mb-1 border transition-colors ${
                  active ? "bg-blue-600 text-white border-blue-700" : "bg-white text-gray-800 border-gray-200 hover:bg-gray-100"
                }`}
                onClick={() => onSelect(item.id)}
              >
                <div className="text-sm font-medium truncate">{item.name}</div>
                <div className={`text-[11px] ${active ? "text-blue-100" : "text-gray-500"}`}>
                  {item.id} · {item.template} · {item.width}x{item.height}
                </div>
              </button>
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
