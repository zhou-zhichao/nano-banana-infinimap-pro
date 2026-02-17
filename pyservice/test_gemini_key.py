from __future__ import annotations

import argparse
import base64
import hashlib
import io
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from google import genai
from google.genai import types
from google.genai.errors import ClientError
from PIL import Image

DEFAULT_MODEL = "gemini-2.5-flash-image"
DEFAULT_KEY_PROFILE = "gemini"
DEFAULT_API_KEY_BACKEND = "auto"
DEFAULT_HTTP_TIMEOUT_MS = 105_000
DEFAULT_IMAGE_SIZE = "1K"
DEFAULT_ASPECT_RATIO = "1:1"
DEFAULT_OUTPUT_MIME_TYPE = "image/png"
DEFAULT_MAX_OUTPUT_TOKENS = 4096


def parse_api_key_list(raw_value: str) -> list[str]:
    ordered: list[str] = []
    for token in re.split(r"[,\n;]", raw_value):
        key = token.strip()
        if key and key not in ordered:
            ordered.append(key)
    return ordered


def get_api_key_profile() -> str:
    raw = (os.environ.get("GOOGLE_API_KEY_PROFILE") or DEFAULT_KEY_PROFILE).strip().lower()
    if raw in {"gemini", "aistudio"}:
        return raw
    return DEFAULT_KEY_PROFILE


def get_google_cloud_api_keys() -> list[str]:
    profile = get_api_key_profile()
    configured_pool = ""
    if profile == "gemini":
        configured_pool = (os.environ.get("GOOGLE_CLOUD_API_KEY_GEMINI") or "").strip()
    elif profile == "aistudio":
        configured_pool = (os.environ.get("GOOGLE_CLOUD_API_KEY_AISTUDIO") or "").strip()

    fallback_pool = (os.environ.get("GOOGLE_CLOUD_API_KEY") or "").strip()
    ordered = parse_api_key_list(configured_pool)
    for key in parse_api_key_list(fallback_pool):
        if key not in ordered:
            ordered.append(key)
    return ordered


def mask_api_key(api_key: str) -> str:
    if len(api_key) <= 8:
        return "*" * len(api_key)
    return f"{api_key[:4]}...{api_key[-4:]}"


def fingerprint_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:16]


def resolve_backend(api_key: str, configured_backend: str) -> str:
    backend = configured_backend.strip().lower()
    if backend in {"gemini", "vertex"}:
        return backend
    return "gemini" if api_key.startswith("AIza") else "vertex"


def get_status_code(error: Exception) -> str:
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code is None:
        return "-"
    return str(status_code)


def pick_response_text(response: Any) -> str:
    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        return text.strip()
    return "<empty>"


def get_client(api_key: str, backend: str, timeout_ms: int) -> genai.Client:
    http_options = types.HttpOptions(timeout=timeout_ms)
    if backend == "gemini":
        return genai.Client(api_key=api_key, http_options=http_options)
    return genai.Client(vertexai=True, api_key=api_key, http_options=http_options)


def load_local_env(env_file: str) -> None:
    env_path = Path(env_file)
    if not env_path.is_absolute():
        env_path = Path(__file__).resolve().parents[1] / env_path
    if env_path.exists():
        load_dotenv(env_path, override=False)


def get_http_timeout_ms(configured_timeout_ms: int) -> int:
    if configured_timeout_ms > 0:
        return max(1_000, configured_timeout_ms)
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


def build_generate_config(backend: str) -> types.GenerateContentConfig:
    image_config_kwargs: dict[str, Any] = {
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


def extract_image_meta(response: types.GenerateContentResponse) -> tuple[bool, str]:
    for candidate in response.candidates or []:
        content = getattr(candidate, "content", None)
        if not content:
            continue
        for part in content.parts or []:
            inline_data = getattr(part, "inline_data", None)
            raw_data = getattr(inline_data, "data", None)
            if not raw_data:
                continue
            if isinstance(raw_data, str):
                image_bytes = base64.b64decode(raw_data)
            else:
                image_bytes = bytes(raw_data)
            mime_type = getattr(inline_data, "mime_type", None) or "image/png"
            return True, f"mime={mime_type} bytes={len(image_bytes)}"
    return False, pick_response_text(response)


def build_test_grid_png() -> bytes:
    image = Image.new("RGB", (256, 256))
    pixels = image.load()
    for y in range(256):
        for x in range(256):
            shade = int((x + y) / 2) % 256
            pixels[x, y] = (shade, shade, shade)

    with io.BytesIO() as buffer:
        image.save(buffer, format="PNG")
        return buffer.getvalue()


def run_probe(client: genai.Client, model: str, prompt: str, backend: str, grid_png: bytes) -> tuple[bool, int, str]:
    generate_config = build_generate_config(backend)
    started = time.perf_counter()
    try:
        response = client.models.generate_content(
            model=model,
            contents=[
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_text(text=prompt),
                        types.Part.from_bytes(data=grid_png, mime_type="image/png"),
                    ],
                )
            ],
            config=generate_config,
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        has_image, detail = extract_image_meta(response)
        if has_image:
            return True, latency_ms, detail
        if len(detail) > 120:
            detail = detail[:117] + "..."
        return False, latency_ms, f"status=200 type=NoImageOutput detail={detail}"
    except ClientError as error:
        latency_ms = int((time.perf_counter() - started) * 1000)
        msg = f"status={get_status_code(error)} type=ClientError detail={str(error).strip()}"
        return False, latency_ms, msg
    except Exception as error:
        latency_ms = int((time.perf_counter() - started) * 1000)
        msg = f"status={get_status_code(error)} type={type(error).__name__} detail={str(error).strip()}"
        return False, latency_ms, msg


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Probe Nano Banana API key pool by calling image generation multiple times.",
    )
    parser.add_argument(
        "--api-key",
        default="",
        help="API key or comma-separated key pool. If omitted, read from env profile pool.",
    )
    parser.add_argument(
        "--attempts",
        type=int,
        default=3,
        help="Number of probe requests (default: 3).",
    )
    parser.add_argument(
        "--model",
        default="",
        help="Model for probe requests. Default: VERTEX_MODEL or gemini-2.5-flash-image.",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        default=0,
        help="HTTP timeout for each request in milliseconds. 0 means use VERTEX_HTTP_TIMEOUT_MS.",
    )
    parser.add_argument(
        "--backend",
        choices=["auto", "gemini", "vertex"],
        default="auto",
        help="Force backend selection, or auto-detect from key prefix.",
    )
    parser.add_argument(
        "--env-file",
        default=".env.local",
        help="Environment file to load before reading key.",
    )
    parser.add_argument(
        "--prompt",
        default="Generate a simple grayscale moon-like texture tile with no text.",
        help="Prompt text sent in each probe request.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    load_local_env(args.env_file)

    api_keys = parse_api_key_list(args.api_key) if args.api_key.strip() else get_google_cloud_api_keys()
    if not api_keys:
        print("[error] Missing API key pool. Use --api-key or set GOOGLE_CLOUD_API_KEY_GEMINI.")
        return 2

    attempts = max(1, int(args.attempts))
    timeout_ms = get_http_timeout_ms(int(args.timeout_ms))
    model = (args.model or os.environ.get("VERTEX_MODEL") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    grid_png = build_test_grid_png()
    configured_backend = os.environ.get("GOOGLE_CLOUD_API_KEY_BACKEND", DEFAULT_API_KEY_BACKEND)
    backend_hint = args.backend if args.backend != "auto" else configured_backend

    key_preview = ", ".join(
        f"{index + 1}:{mask_api_key(api_key)}({fingerprint_api_key(api_key)})"
        for index, api_key in enumerate(api_keys[:5])
    )
    if len(api_keys) > 5:
        key_preview = f"{key_preview}, ... (+{len(api_keys) - 5} more)"

    print(
        "[info] "
        f"profile={get_api_key_profile()} "
        f"pool_size={len(api_keys)} "
        f"backend_hint={backend_hint} "
        f"model={model} attempts={attempts} timeout_ms={timeout_ms}"
    )
    print(f"[keys] {key_preview}")

    success_count = 0
    clients: dict[tuple[str, str], genai.Client] = {}
    for index in range(1, attempts + 1):
        key_index = (index - 1) % len(api_keys)
        api_key = api_keys[key_index]
        backend = resolve_backend(api_key, backend_hint)
        cache_key = (api_key, backend)
        if cache_key not in clients:
            clients[cache_key] = get_client(api_key=api_key, backend=backend, timeout_ms=timeout_ms)
        client = clients[cache_key]

        ok, latency_ms, detail = run_probe(
            client=client,
            model=model,
            prompt=args.prompt,
            backend=backend,
            grid_png=grid_png,
        )
        key_meta = f"key={key_index + 1}/{len(api_keys)} fp={fingerprint_api_key(api_key)} backend={backend}"
        if ok:
            success_count += 1
            print(f"[{index}/{attempts}] OK {latency_ms}ms {key_meta} {detail}")
        else:
            print(f"[{index}/{attempts}] FAIL {latency_ms}ms {key_meta} {detail}")

    failure_count = attempts - success_count
    usable = success_count == attempts
    print(f"[summary] success={success_count} failure={failure_count} usable={str(usable).lower()}")
    return 0 if usable else 1


if __name__ == "__main__":
    sys.exit(main())
