import type { ModelVariant } from "./modelVariant";

export type ModelBucket = "nano_banana" | "nano_banana_pro";

export type RateLimitCounter = {
  used: number;
  limit: number;
};

export type RateLimitModelStatus = {
  label: string;
  rpm: RateLimitCounter;
  rpd: RateLimitCounter;
  exhausted: boolean;
  retry_after_seconds: number;
};

export type RateLimitStatusResponse = {
  enabled: boolean;
  key_pool_size: number;
  updated_at: string;
  poll_ms?: number;
  models: Record<ModelBucket, RateLimitModelStatus>;
};

export function bucketForModelVariant(variant: ModelVariant): ModelBucket {
  return variant === "nano_banana_pro" ? "nano_banana_pro" : "nano_banana";
}

export function toPercent(used: number, limit: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

export function formatCounter(used: number, limit: number): string {
  return `${formatCompact(used)} / ${formatCompact(limit)}`;
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return String(Math.max(0, Math.round(value)));
}
