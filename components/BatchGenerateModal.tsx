"use client";

import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  DEFAULT_MODEL_VARIANT,
  MODEL_VARIANT_LABELS,
  MODEL_VARIANTS,
  type ModelVariant,
} from "@/lib/modelVariant";

export type BatchGenerateOptions = {
  prompt: string;
  modelVariant: ModelVariant;
  layers: number;
  maxParallel: number;
  requireReview: boolean;
};

type BatchGenerateModalProps = {
  open: boolean;
  running?: boolean;
  originX: number;
  originY: number;
  onClose: () => void;
  onSubmit: (options: BatchGenerateOptions) => Promise<void> | void;
};

const DEFAULT_LAYERS = 2;
const DEFAULT_MAX_PARALLEL = 4;
const DEFAULT_REQUIRE_REVIEW = true;

export default function BatchGenerateModal({
  open,
  running = false,
  originX,
  originY,
  onClose,
  onSubmit,
}: BatchGenerateModalProps) {
  const [prompt, setPrompt] = useState("");
  const [modelVariant, setModelVariant] = useState<ModelVariant>(DEFAULT_MODEL_VARIANT);
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [maxParallel, setMaxParallel] = useState(DEFAULT_MAX_PARALLEL);
  const [requireReview, setRequireReview] = useState(DEFAULT_REQUIRE_REVIEW);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPrompt("");
    setModelVariant(DEFAULT_MODEL_VARIANT);
    setLayers(DEFAULT_LAYERS);
    setMaxParallel(DEFAULT_MAX_PARALLEL);
    setRequireReview(DEFAULT_REQUIRE_REVIEW);
    setError(null);
  }, [open]);

  const cleanedPrompt = useMemo(() => prompt.trim(), [prompt]);

  const submit = async () => {
    const nextLayers = Math.max(1, Math.min(64, Math.floor(layers)));
    const nextParallel = Math.max(1, Math.min(16, Math.floor(maxParallel)));
    if (!cleanedPrompt) {
      setError("Prompt is required");
      return;
    }
    setError(null);
    await onSubmit({
      prompt: cleanedPrompt,
      modelVariant,
      layers: nextLayers,
      maxParallel: nextParallel,
      requireReview,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !running) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay data-dialog-root className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[10000]" />
        <Dialog.Content
          data-dialog-root
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl shadow-xl p-4 w-[min(92vw,560px)] z-[10001]"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <div className="mb-3">
            <Dialog.Title className="text-base font-semibold text-gray-900">Batch 3x3 Generate</Dialog.Title>
            <Dialog.Description className="text-xs text-gray-600 mt-1">
              Anchor tile ({originX}, {originY}) as center. Execution follows dependency waves with overlap-safe parallelism.
            </Dialog.Description>
          </div>

          <div className="space-y-3">
            <label className="block">
              <div className="text-xs text-gray-600 mb-1">Prompt</div>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                disabled={running}
                placeholder="Describe what to generate for this batch..."
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm resize-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              />
            </label>

            <div>
              <div className="text-xs text-gray-600 mb-1">Model</div>
              <div className="inline-flex rounded-lg border bg-gray-50 p-0.5">
                {MODEL_VARIANTS.map((variant) => {
                  const active = variant === modelVariant;
                  return (
                    <button
                      key={variant}
                      type="button"
                      disabled={running}
                      onClick={() => setModelVariant(variant)}
                      className={`px-3 py-1 text-xs rounded-md transition-colors ${
                        active ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
                      }`}
                    >
                      {MODEL_VARIANT_LABELS[variant]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <div className="text-xs text-gray-600 mb-1">Layers (R)</div>
                <input
                  type="number"
                  min={1}
                  max={64}
                  step={1}
                  value={layers}
                  disabled={running}
                  onChange={(event) => setLayers(Number(event.target.value))}
                  className="w-full h-9 rounded-md border border-gray-300 px-2 text-sm"
                />
              </label>

              <label className="block">
                <div className="text-xs text-gray-600 mb-1">Max Parallel</div>
                <input
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  value={maxParallel}
                  disabled={running}
                  onChange={(event) => setMaxParallel(Number(event.target.value))}
                  className="w-full h-9 rounded-md border border-gray-300 px-2 text-sm"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-700">
              <input
                type="checkbox"
                checked={requireReview}
                disabled={running}
                onChange={(event) => setRequireReview(event.target.checked)}
                className="h-4 w-4 accent-amber-600"
              />
              Human Review (Accept/Reject before apply)
            </label>

            {error && <div className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">{error}</div>}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              disabled={running}
              onClick={onClose}
              className="h-8 px-3 text-xs rounded border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={running || !cleanedPrompt}
              onClick={() => {
                void submit().catch(() => {});
              }}
              className="h-8 px-3 text-xs rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {running ? "Running..." : "Start Batch"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

