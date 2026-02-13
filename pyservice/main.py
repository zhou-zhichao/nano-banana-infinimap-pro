from __future__ import annotations

import base64
import binascii
import logging
import os
import time
from functools import lru_cache
from typing import Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from google import genai
from google.genai.errors import ClientError
from google.genai import types
from pydantic import BaseModel, Field

load_dotenv()

logging.basicConfig(level=os.environ.get("PY_IMAGE_LOG_LEVEL", "INFO"))
logger = logging.getLogger("py-image-service")

PROMPT_INSTRUCTION = ""
DEFAULT_LOCATION = "us-central1"
DEFAULT_MODEL = "gemini-2.5-flash-image"
DEFAULT_STREAM_TIMEOUT_MS = 90_000
DEFAULT_HTTP_TIMEOUT_MS = 105_000
DEFAULT_RETRY_AFTER_SECONDS = 30
DEFAULT_IMAGE_SIZE = "1K"
DEFAULT_ASPECT_RATIO = "1:1"
DEFAULT_OUTPUT_MIME_TYPE = "image/png"
DEFAULT_MAX_OUTPUT_TOKENS = 4096
DEFAULT_AUTH_MODE = "auto"
DEFAULT_KEY_PROFILE = "gemini"
DEFAULT_API_KEY_BACKEND = "auto"


class GenerateGridRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    style_name: str = Field(min_length=1, max_length=200, default="default-style")
    grid_png_base64: str = Field(min_length=1)
    negative_prompt: str = Field(default="", max_length=1000)
    model: str | None = Field(default=None, min_length=1, max_length=200)


class GenerateGridResponse(BaseModel):
    image_base64: str
    mime_type: str
    model: str
    latency_ms: int


def get_vertex_project() -> str:
    return (
        os.environ.get("VERTEX_PROJECT_ID")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or os.environ.get("GCLOUD_PROJECT")
        or ""
    )


def get_vertex_location() -> str:
    return os.environ.get("VERTEX_LOCATION", DEFAULT_LOCATION)


def get_vertex_model() -> str:
    return os.environ.get("VERTEX_MODEL", DEFAULT_MODEL)


def get_google_cloud_api_key() -> str:
    profile = get_api_key_profile()
    if profile == "gemini":
        return (
            (os.environ.get("GOOGLE_CLOUD_API_KEY_GEMINI") or "").strip()
            or (os.environ.get("GOOGLE_CLOUD_API_KEY") or "").strip()
        )
    if profile == "aistudio":
        return (
            (os.environ.get("GOOGLE_CLOUD_API_KEY_AISTUDIO") or "").strip()
            or (os.environ.get("GOOGLE_CLOUD_API_KEY") or "").strip()
        )
    return (os.environ.get("GOOGLE_CLOUD_API_KEY") or "").strip()


def get_api_key_profile() -> str:
    raw = (os.environ.get("GOOGLE_API_KEY_PROFILE") or DEFAULT_KEY_PROFILE).strip().lower()
    if raw in {"gemini", "aistudio"}:
        return raw
    return DEFAULT_KEY_PROFILE


def get_api_key_backend() -> str:
    raw = (os.environ.get("GOOGLE_CLOUD_API_KEY_BACKEND") or DEFAULT_API_KEY_BACKEND).strip().lower()
    if raw in {"auto", "vertex", "gemini"}:
        return raw
    return DEFAULT_API_KEY_BACKEND


def resolve_api_key_backend(api_key: str) -> str:
    configured = get_api_key_backend()
    if configured in {"vertex", "gemini"}:
        return configured
    # Common Gemini Developer API keys start with AIza.
    return "gemini" if api_key.startswith("AIza") else "vertex"


def get_vertex_auth_mode() -> str:
    raw = (os.environ.get("VERTEX_AUTH_MODE") or DEFAULT_AUTH_MODE).strip().lower()
    if raw in {"auto", "adc", "api_key"}:
        return raw
    return DEFAULT_AUTH_MODE


def get_effective_auth_mode() -> str:
    configured = get_vertex_auth_mode()
    if configured != "auto":
        return configured
    # Prefer ADC when a project is configured so we can use explicit Vertex project quotas.
    if get_vertex_project():
        return "adc"
    if get_google_cloud_api_key():
        return "api_key"
    return "none"


def get_auth_mode() -> str:
    return get_effective_auth_mode()


def get_effective_api_backend() -> str:
    if get_effective_auth_mode() != "api_key":
        return "vertex"
    api_key = get_google_cloud_api_key()
    if not api_key:
        return "vertex"
    return resolve_api_key_backend(api_key)


def get_http_timeout_ms() -> int:
    raw = os.environ.get("VERTEX_HTTP_TIMEOUT_MS")
    if not raw:
        return DEFAULT_HTTP_TIMEOUT_MS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_HTTP_TIMEOUT_MS
    if value <= 0:
        return DEFAULT_HTTP_TIMEOUT_MS
    return value


def get_stream_timeout_ms() -> int:
    raw = os.environ.get("VERTEX_STREAM_TIMEOUT_MS")
    if not raw:
        return DEFAULT_STREAM_TIMEOUT_MS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_STREAM_TIMEOUT_MS
    if value <= 0:
        return DEFAULT_STREAM_TIMEOUT_MS
    return value


def get_max_output_tokens() -> int:
    raw = os.environ.get("VERTEX_MAX_OUTPUT_TOKENS")
    if not raw:
        return DEFAULT_MAX_OUTPUT_TOKENS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_MAX_OUTPUT_TOKENS
    if value <= 0:
        return DEFAULT_MAX_OUTPUT_TOKENS
    return value


def get_retry_after_seconds() -> int:
    raw = os.environ.get("VERTEX_RETRY_AFTER_SECONDS")
    if not raw:
        return DEFAULT_RETRY_AFTER_SECONDS
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_RETRY_AFTER_SECONDS
    if value <= 0:
        return DEFAULT_RETRY_AFTER_SECONDS
    return value


def get_response_modalities() -> list[str]:
    raw = (os.environ.get("VERTEX_RESPONSE_MODALITIES") or "IMAGE").strip()
    values: list[str] = []
    for token in raw.split(","):
        normalized = token.strip().upper()
        if normalized and normalized not in values:
            values.append(normalized)
    if not values:
        return ["IMAGE"]
    return values


def get_image_size() -> str:
    value = (os.environ.get("VERTEX_IMAGE_SIZE") or DEFAULT_IMAGE_SIZE).strip().upper()
    if value not in {"1K", "2K", "4K"}:
        return DEFAULT_IMAGE_SIZE
    return value


def get_aspect_ratio() -> str:
    return (os.environ.get("VERTEX_ASPECT_RATIO") or DEFAULT_ASPECT_RATIO).strip() or DEFAULT_ASPECT_RATIO


def get_output_mime_type() -> str:
    value = (os.environ.get("VERTEX_OUTPUT_MIME_TYPE") or DEFAULT_OUTPUT_MIME_TYPE).strip().lower()
    if value not in {"image/png", "image/jpeg"}:
        return DEFAULT_OUTPUT_MIME_TYPE
    return value


def get_model_fallbacks() -> list[str]:
    raw = (os.environ.get("VERTEX_MODEL_FALLBACKS") or "").strip()
    if not raw:
        return []
    ordered: list[str] = []
    for token in raw.split(","):
        model_name = token.strip()
        if model_name and model_name not in ordered:
            ordered.append(model_name)
    return ordered


def get_candidate_models(preferred_model: str | None = None) -> list[str]:
    configured = (get_vertex_model() or "").strip()
    ordered: list[str] = []
    preferred = (preferred_model or "").strip()
    for model_name in [preferred, configured, *get_model_fallbacks()]:
        if model_name and model_name not in ordered:
            ordered.append(model_name)
    return ordered


@lru_cache(maxsize=1)
def get_client() -> genai.Client:
    project = get_vertex_project()
    api_key = get_google_cloud_api_key()
    auth_mode = get_effective_auth_mode()
    # google-genai expects timeout in milliseconds.
    http_options = types.HttpOptions(timeout=get_http_timeout_ms())

    if auth_mode == "api_key":
        if not api_key:
            raise RuntimeError(
                "VERTEX_AUTH_MODE=api_key requires GOOGLE_CLOUD_API_KEY, "
                "or the selected profile key in GOOGLE_CLOUD_API_KEY_GEMINI/GOOGLE_CLOUD_API_KEY_AISTUDIO."
            )
        backend = resolve_api_key_backend(api_key)
        if backend == "gemini":
            return genai.Client(api_key=api_key, http_options=http_options)
        return genai.Client(vertexai=True, api_key=api_key, http_options=http_options)

    if not project:
        if auth_mode == "adc":
            raise RuntimeError(
                "VERTEX_AUTH_MODE=adc requires VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT)."
            )
        raise RuntimeError(
            "Missing Vertex credentials. Set VERTEX_PROJECT_ID for ADC mode or "
            "set VERTEX_AUTH_MODE=api_key with GOOGLE_CLOUD_API_KEY."
        )
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", project)
    os.environ.setdefault("GCLOUD_PROJECT", project)
    return genai.Client(
        vertexai=True,
        project=project,
        location=get_vertex_location(),
        http_options=http_options,
    )


def decode_base64_png(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="grid_png_base64 must be valid base64") from exc


def build_prompt(prompt: str, style_name: str, negative_prompt: str) -> str:
    text = f"{PROMPT_INSTRUCTION}\n\nStyle: {style_name}\nAdditional context: {prompt}"
    if negative_prompt:
        text += f"\nNegative prompt: {negative_prompt}"
    return text


def build_generate_config() -> types.GenerateContentConfig:
    backend = get_effective_api_backend()
    image_config_kwargs = {
        "aspect_ratio": get_aspect_ratio(),
    }
    # Gemini Developer API currently rejects image_size/output_mime_type.
    if backend != "gemini":
        image_config_kwargs["image_size"] = get_image_size()
        image_config_kwargs["output_mime_type"] = get_output_mime_type()

    return types.GenerateContentConfig(
        temperature=1,
        top_p=0.95,
        max_output_tokens=get_max_output_tokens(),
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        response_modalities=get_response_modalities(),
        safety_settings=[
            types.SafetySetting(category="HARM_CATEGORY_HATE_SPEECH", threshold="OFF"),
            types.SafetySetting(category="HARM_CATEGORY_DANGEROUS_CONTENT", threshold="OFF"),
            types.SafetySetting(category="HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold="OFF"),
            types.SafetySetting(category="HARM_CATEGORY_HARASSMENT", threshold="OFF"),
        ],
        image_config=types.ImageConfig(**image_config_kwargs),
    )


def extract_image_bytes_from_response(response: types.GenerateContentResponse) -> Tuple[bytes, str]:
    prompt_feedback = getattr(response, "prompt_feedback", None)
    block_reason = getattr(prompt_feedback, "block_reason", None)
    if block_reason:
        raise HTTPException(status_code=400, detail=f"Prompt blocked by safety filter: {block_reason}")

    collected_text: list[str] = []
    response_text = getattr(response, "text", None)
    if response_text:
        collected_text.append(response_text)

    for candidate in response.candidates or []:
        finish_reason = str(candidate.finish_reason or "")
        if finish_reason in {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"}:
            raise HTTPException(status_code=400, detail=f"Generation blocked: {finish_reason}")

        content = getattr(candidate, "content", None)
        if not content:
            continue

        for part in content.parts or []:
            text_part = getattr(part, "text", None)
            if text_part:
                collected_text.append(text_part)

            inline_data = getattr(part, "inline_data", None)
            raw_data = getattr(inline_data, "data", None)
            if not raw_data:
                continue

            if isinstance(raw_data, str):
                image_bytes = base64.b64decode(raw_data)
            else:
                image_bytes = bytes(raw_data)

            mime_type = getattr(inline_data, "mime_type", None) or "image/png"
            return image_bytes, mime_type

    if collected_text:
        logger.warning("Model returned text but no image output: %s", "".join(collected_text)[:500])

    raise HTTPException(status_code=502, detail="Model response completed without image data")


def is_model_access_error(error: Exception) -> bool:
    if isinstance(error, ClientError) and getattr(error, "response", None) is not None:
        status_code = getattr(error.response, "status_code", None)
        if status_code in {400, 403, 404}:
            text = str(error).lower()
            access_markers = [
                "publisher model",
                "not found",
                "not_found",
                "does not have access",
                "permission denied",
            ]
            return any(marker in text for marker in access_markers)
    return False


def is_rate_limit_error(error: Exception) -> bool:
    if isinstance(error, ClientError) and getattr(error, "response", None) is not None:
        return getattr(error.response, "status_code", None) == 429
    text = str(error).lower()
    return "resource_exhausted" in text or "429" in text


app = FastAPI(title="Nano Banana Infinimap Python Image Service")


@app.get("/healthz")
async def healthz() -> dict:
    project = get_vertex_project()
    api_key = get_google_cloud_api_key()
    return {
        "ok": bool(project or api_key),
        "vertex_project_id": project or None,
        "vertex_location": get_vertex_location(),
        "vertex_auth_mode": get_vertex_auth_mode(),
        "effective_auth_mode": get_auth_mode(),
        "api_key_profile": get_api_key_profile(),
        "api_key_backend": get_api_key_backend(),
        "effective_api_backend": get_effective_api_backend(),
        "vertex_model": get_vertex_model(),
        "model_fallbacks": get_model_fallbacks(),
        "candidate_models": get_candidate_models(),
        "auth_mode": get_auth_mode(),
        "api_key_configured": bool(api_key),
        "response_modalities": get_response_modalities(),
        "image_size": get_image_size(),
        "http_timeout_ms": get_http_timeout_ms(),
        "stream_timeout_ms": get_stream_timeout_ms(),
    }


@app.post("/v1/generate-grid", response_model=GenerateGridResponse)
def generate_grid(payload: GenerateGridRequest) -> GenerateGridResponse:
    try:
        client = get_client()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    grid_png = decode_base64_png(payload.grid_png_base64)
    models = get_candidate_models(payload.model)
    prompt_text = build_prompt(payload.prompt, payload.style_name, payload.negative_prompt)
    last_error: Exception | None = None
    saw_rate_limit = False
    for model_name in models:
        start = time.perf_counter()
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_text(text=prompt_text),
                            types.Part.from_bytes(data=grid_png, mime_type="image/png"),
                        ],
                    )
                ],
                config=build_generate_config(),
            )
            image_bytes, mime_type = extract_image_bytes_from_response(response)
            latency_ms = int((time.perf_counter() - start) * 1000)
            if model_name != models[0]:
                logger.warning(
                    "Primary model '%s' unavailable; used fallback model '%s'",
                    models[0],
                    model_name,
                )
            return GenerateGridResponse(
                image_base64=base64.b64encode(image_bytes).decode("ascii"),
                mime_type=mime_type,
                model=model_name,
                latency_ms=latency_ms,
            )
        except HTTPException:
            raise
        except Exception as exc:  # pragma: no cover - runtime integration path
            last_error = exc
            if is_rate_limit_error(exc):
                saw_rate_limit = True
                logger.warning("Model '%s' hit rate limit: %s", model_name, exc)
                continue
            if is_model_access_error(exc):
                logger.warning("Model '%s' unavailable: %s", model_name, exc)
                continue
            logger.exception("Vertex generate_content call failed for model '%s'", model_name)
            raise HTTPException(status_code=500, detail=f"Vertex request failed: {exc}") from exc

    if saw_rate_limit:
        raise HTTPException(
            status_code=429,
            detail=(
                f"All candidate models were rate-limited ({models}). "
                "Please wait a bit and retry."
            ),
            headers={"Retry-After": str(get_retry_after_seconds())},
        )

    raise HTTPException(
        status_code=500,
        detail=f"No usable Vertex image model found in candidates {models}: {last_error}",
    )
