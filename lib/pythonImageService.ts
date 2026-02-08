import { z } from "zod";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8001";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 1;

const serviceResponseSchema = z.object({
  image_base64: z.string().min(1),
  mime_type: z.string().min(1),
  model: z.string().min(1),
  latency_ms: z.number().int().nonnegative(),
});

type GenerateGridImageInput = {
  prompt: string;
  styleName: string;
  gridPng: Buffer;
  negativePrompt?: string;
};

type GenerateGridImageOutput = {
  imageBuffer: Buffer;
  mimeType: string;
  model: string;
  latencyMs: number;
};

export class PythonImageServiceError extends Error {
  statusCode?: number;
  responseBody?: string;
  retryAfterSeconds?: number;
  isTimeout?: boolean;

  constructor(
    message: string,
    options?: {
      statusCode?: number;
      responseBody?: string;
      retryAfterSeconds?: number;
      isTimeout?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "PythonImageServiceError";
    this.statusCode = options?.statusCode;
    this.responseBody = options?.responseBody;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.isTimeout = options?.isTimeout;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

function getServiceUrl(): string {
  return process.env.PY_IMAGE_SERVICE_URL || DEFAULT_SERVICE_URL;
}

function getTimeoutMs(): number {
  const fromEnv = Number(process.env.PY_IMAGE_SERVICE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(fromEnv);
}

function getMaxAttempts(): number {
  const fromEnv = Number(process.env.PY_IMAGE_SERVICE_MAX_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);
  if (!Number.isFinite(fromEnv) || fromEnv < 1) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.min(3, Math.floor(fromEnv));
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof PythonImageServiceError) {
    if (error.isTimeout) return false;
    if (!error.statusCode) return false;
    return error.statusCode === 429 || error.statusCode === 503;
  }
  if (error.name === "AbortError") return false;

  const message = error.message.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("connection refused") ||
    message.includes("503") ||
    message.includes("429")
  );
}

export async function generateGridImage(input: GenerateGridImageInput): Promise<GenerateGridImageOutput> {
  const serviceUrl = getServiceUrl();
  const timeoutMs = getTimeoutMs();
  const maxAttempts = getMaxAttempts();
  const endpoint = `${serviceUrl.replace(/\/$/, "")}/v1/generate-grid`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: input.prompt,
          style_name: input.styleName,
          grid_png_base64: input.gridPng.toString("base64"),
          negative_prompt: input.negativePrompt ?? "",
        }),
        signal: controller.signal,
      });

      const responseText = await response.text();
      if (!response.ok) {
        const retryAfterRaw = response.headers.get("retry-after");
        const retryAfterSeconds =
          retryAfterRaw && Number.isFinite(Number(retryAfterRaw)) ? Number(retryAfterRaw) : undefined;
        throw new PythonImageServiceError(`Python image service ${response.status}: ${responseText}`, {
          statusCode: response.status,
          responseBody: responseText,
          retryAfterSeconds,
        });
      }

      const parsed = serviceResponseSchema.parse(JSON.parse(responseText));
      return {
        imageBuffer: Buffer.from(parsed.image_base64, "base64"),
        mimeType: parsed.mime_type,
        model: parsed.model,
        latencyMs: parsed.latency_ms,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        error = new PythonImageServiceError(`Python image service request timed out after ${timeoutMs}ms`, {
          statusCode: 504,
          isTimeout: true,
          cause: error,
        });
      } else if (error instanceof TypeError && error.message.toLowerCase().includes("fetch failed")) {
        error = new PythonImageServiceError(
          "Python image service is unreachable at PY_IMAGE_SERVICE_URL (fetch failed)",
          {
            statusCode: 502,
            cause: error,
          },
        );
      }
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableError(error)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastError instanceof PythonImageServiceError) {
    throw lastError;
  }
  throw new PythonImageServiceError(`Failed to generate image from Python service: ${String(lastError)}`, {
    cause: lastError,
  });
}
