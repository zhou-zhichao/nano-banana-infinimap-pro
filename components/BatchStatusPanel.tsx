"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BatchRunState } from "@/lib/batch/types";

type BatchStatusPanelProps = {
  state: BatchRunState | null;
  onCancel?: () => void;
  review?: {
    enabled: boolean;
    active: number;
    queued: number;
  };
};

function overlapsHorizontally(
  leftA: number,
  rightA: number,
  leftB: number,
  rightB: number,
) {
  return leftA < rightB && rightA > leftB;
}

export default function BatchStatusPanel({ state, onCancel, review }: BatchStatusPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [bottom, setBottom] = useState(12);

  const statusTone = useMemo(() => {
    if (!state) return "bg-gray-100 text-gray-700 border-gray-300";
    if (state.status === "COMPLETED") return "bg-emerald-100 text-emerald-700 border-emerald-300";
    if (state.status === "FAILED") return "bg-red-100 text-red-700 border-red-300";
    if (state.status === "CANCELLED") return "bg-gray-100 text-gray-700 border-gray-300";
    return "bg-blue-100 text-blue-700 border-blue-300";
  }, [state]);

  const recomputeBottom = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const baseBottom = 12;
    const timeline = document.querySelector<HTMLElement>("[data-timeline-bar]");
    if (!timeline) {
      setBottom(baseBottom);
      return;
    }

    const timelineRect = timeline.getBoundingClientRect();
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;
    const panelLeftAtBase = window.innerWidth - baseBottom - panelWidth;
    const panelRightAtBase = window.innerWidth - baseBottom;
    const panelTopAtBase = window.innerHeight - baseBottom - panelHeight;
    const panelBottomAtBase = window.innerHeight - baseBottom;

    const overlapX = overlapsHorizontally(panelLeftAtBase, panelRightAtBase, timelineRect.left, timelineRect.right);
    const overlapY = panelTopAtBase < timelineRect.bottom && panelBottomAtBase > timelineRect.top;
    if (!overlapX || !overlapY) {
      setBottom(baseBottom);
      return;
    }

    const liftedBottom = Math.ceil(window.innerHeight - timelineRect.top + 12);
    setBottom(Math.max(baseBottom, liftedBottom));
  }, []);

  useEffect(() => {
    if (!state) return;
    const raf = requestAnimationFrame(recomputeBottom);
    window.addEventListener("resize", recomputeBottom);
    const observer = new ResizeObserver(() => recomputeBottom());
    if (panelRef.current) observer.observe(panelRef.current);
    const timeline = document.querySelector<HTMLElement>("[data-timeline-bar]");
    if (timeline) observer.observe(timeline);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", recomputeBottom);
      observer.disconnect();
    };
  }, [recomputeBottom, state]);

  if (!state) return null;

  const showCancel = state.status === "RUNNING" || state.status === "COMPLETING";

  return (
    <div
      ref={panelRef}
      className="absolute right-3 z-[1600] w-[min(88vw,380px)] pointer-events-auto"
      style={{ bottom }}
    >
      <div className="rounded-xl border border-gray-200 bg-white/95 backdrop-blur shadow-xl p-3">
        <div className="flex items-center gap-2 mb-2">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone}`}>
            {state.status}
          </span>
          <span className="text-xs text-gray-500">Wave {state.currentWave}</span>
          {showCancel && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="ml-auto h-7 px-2 rounded-md border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 text-xs"
            >
              Cancel
            </button>
          )}
        </div>

        {state.error && <div className="text-xs text-red-600 mt-1 mb-2 break-words">{state.error}</div>}

        <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 mb-2">
          <div className="text-[11px] font-medium text-gray-700 mb-0.5">Generate</div>
          <div className="text-[11px] text-gray-600 leading-5">
            total {state.generate.total} | running {state.generate.running} | success {state.generate.success} | failed{" "}
            {state.generate.failed} | blocked {state.generate.blocked}
          </div>
        </div>

        <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5">
          <div className="text-[11px] font-medium text-gray-700 mb-0.5">Parents</div>
          <div className="text-[11px] text-gray-600 leading-5">
            enqueued batches {state.parents.enqueuedWaves} | completed batches {state.parents.completedWaves} | level{" "}
            {state.parents.currentLevelZ == null ? "-" : state.parents.currentLevelZ}
          </div>
        </div>

        {review && (
          <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 mt-2">
            <div className="text-[11px] font-medium text-gray-700 mb-0.5">Review</div>
            <div className="text-[11px] text-gray-600 leading-5">
              enabled {review.enabled ? "yes" : "no"} | active {review.active} | queued {review.queued}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

