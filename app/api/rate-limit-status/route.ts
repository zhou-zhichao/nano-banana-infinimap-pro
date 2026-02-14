import { NextResponse } from "next/server";
import { z } from "zod";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8001";
const DEFAULT_POLL_MS = 5_000;

const counterSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
});

const modelStatusSchema = z.object({
  label: z.string(),
  rpm: counterSchema,
  rpd: counterSchema,
  exhausted: z.boolean(),
  retry_after_seconds: z.number().int().nonnegative(),
});

const responseSchema = z.object({
  enabled: z.boolean(),
  key_pool_size: z.number().int().nonnegative(),
  updated_at: z.string(),
  poll_ms: z.number().int().positive().optional(),
  models: z.object({
    nano_banana: modelStatusSchema,
    nano_banana_pro: modelStatusSchema,
  }),
});

function getServiceUrl() {
  return process.env.PY_IMAGE_SERVICE_URL || DEFAULT_SERVICE_URL;
}

function getPollMs() {
  const raw = Number(process.env.GEMINI_RATE_LIMIT_POLL_MS ?? DEFAULT_POLL_MS);
  if (!Number.isFinite(raw) || raw < 500) return DEFAULT_POLL_MS;
  return Math.floor(raw);
}

export const dynamic = "force-dynamic";

export async function GET() {
  const endpoint = `${getServiceUrl().replace(/\/$/, "")}/v1/rate-limit-status`;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });

    const responseText = await response.text();
    if (!response.ok) {
      const retryAfter = response.headers.get("retry-after");
      return NextResponse.json(
        {
          error: `Python image service ${response.status}: ${responseText || "failed to fetch rate limit status"}`,
        },
        {
          status: response.status,
          headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
        },
      );
    }

    const parsed = responseSchema.parse(JSON.parse(responseText));
    return NextResponse.json(
      {
        ...parsed,
        poll_ms: parsed.poll_ms ?? getPollMs(),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch rate limit status";
    return NextResponse.json(
      { error: message },
      {
        status: 502,
      },
    );
  }
}
