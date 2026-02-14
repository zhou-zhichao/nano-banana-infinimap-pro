from __future__ import annotations

import base64
import binascii
import hashlib
import json
import logging
import math
import os
import re
import time
from functools import lru_cache
from pathlib import Path
from threading import Lock
import uuid
from typing import Any, NamedTuple, Tuple

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
DEFAULT_MODEL_PRO = "gemini-3-pro-image-preview"
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

MODEL_BUCKET_NANO = "nano_banana"
MODEL_BUCKET_PRO = "nano_banana_pro"
MODEL_BUCKETS = (MODEL_BUCKET_NANO, MODEL_BUCKET_PRO)
MODEL_BUCKET_LABELS: dict[str, str] = {
    MODEL_BUCKET_NANO: "Nano Banana",
    MODEL_BUCKET_PRO: "Nano Banana Pro",
}

DEFAULT_GEMINI_RATE_LIMIT_STATE_PATH = ".temp/gemini-rate-limit-state.json"
DEFAULT_GEMINI_RATE_LIMIT_DEFAULTS: dict[str, dict[str, int]] = {
    MODEL_BUCKET_NANO: {"rpm": 500, "rpd": 2_000},
    MODEL_BUCKET_PRO: {"rpm": 20, "rpd": 250},
}
DEFAULT_GEMINI_RATE_LIMIT_POLL_MS = 5_000
RPM_WINDOW_SECONDS = 60
RPD_WINDOW_SECONDS = 86_400

_api_key_round_robin_lock = Lock()
_api_key_round_robin_cursor = 0


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


class RateLimitCounter(BaseModel):
    used: int
    limit: int


class RateLimitModelStatus(BaseModel):
    label: str
    rpm: RateLimitCounter
    rpd: RateLimitCounter
    exhausted: bool
    retry_after_seconds: int


class RateLimitStatusResponse(BaseModel):
    enabled: bool
    key_pool_size: int
    updated_at: str
    poll_ms: int
    models: dict[str, RateLimitModelStatus]


class RateLimitReservation(NamedTuple):
    model_bucket: str
    key_fingerprint: str
    event_id: str


class LocalRateLimitExceededError(RuntimeError):
    def __init__(self, model_bucket: str, retry_after_seconds: int):
        self.model_bucket = model_bucket
        self.retry_after_seconds = max(1, int(retry_after_seconds))
        super().__init__(f"Rate limit exceeded for model bucket '{model_bucket}'")


def now_iso(ts: float | None = None) -> str:
    value = ts if ts is not None else time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))


def parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if not normalized:
        return default
    return normalized not in {"0", "false", "no", "off"}


def parse_non_negative_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    if parsed < 0:
        return fallback
    return parsed


def fingerprint_api_key(api_key: str) -> str:
    digest = hashlib.sha256(api_key.encode("utf-8")).hexdigest()
    return digest[:16]


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


def get_vertex_model_pro() -> str:
    return os.environ.get("VERTEX_MODEL_PRO", DEFAULT_MODEL_PRO)


def get_gemini_rate_limit_enabled() -> bool:
    return parse_bool(os.environ.get("GEMINI_RATE_LIMIT_ENABLED"), True)


def get_gemini_rate_limit_poll_ms() -> int:
    raw = os.environ.get("GEMINI_RATE_LIMIT_POLL_MS")
    if raw is None:
        return DEFAULT_GEMINI_RATE_LIMIT_POLL_MS
    try:
        parsed = int(raw)
    except ValueError:
        return DEFAULT_GEMINI_RATE_LIMIT_POLL_MS
    if parsed < 500:
        return DEFAULT_GEMINI_RATE_LIMIT_POLL_MS
    return parsed


def get_gemini_rate_limit_state_path() -> Path:
    raw = (os.environ.get("GEMINI_RATE_LIMIT_STATE_PATH") or DEFAULT_GEMINI_RATE_LIMIT_STATE_PATH).strip()
    path = Path(raw)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path


def get_gemini_rate_limit_defaults() -> dict[str, dict[str, int]]:
    configured = os.environ.get("GEMINI_RATE_LIMIT_DEFAULTS_JSON")
    parsed: Any = None
    if configured and configured.strip():
        try:
            parsed = json.loads(configured)
        except Exception as exc:  # pragma: no cover - env misconfiguration path
            logger.warning("Invalid GEMINI_RATE_LIMIT_DEFAULTS_JSON: %s", exc)

    output: dict[str, dict[str, int]] = {}
    for model_bucket in MODEL_BUCKETS:
        defaults = DEFAULT_GEMINI_RATE_LIMIT_DEFAULTS[model_bucket]
        source = parsed.get(model_bucket) if isinstance(parsed, dict) else {}
        if not isinstance(source, dict):
            source = {}
        output[model_bucket] = {
            "rpm": parse_non_negative_int(source.get("rpm"), defaults["rpm"]),
            "rpd": parse_non_negative_int(source.get("rpd"), defaults["rpd"]),
        }
    return output


def parse_api_key_list(raw_value: str) -> list[str]:
    ordered: list[str] = []
    for token in re.split(r"[,\n;]", raw_value):
        key = token.strip()
        if key and key not in ordered:
            ordered.append(key)
    return ordered


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


def get_google_cloud_api_key() -> str:
    keys = get_google_cloud_api_keys()
    if not keys:
        return ""
    return keys[0]


def get_next_google_cloud_api_key() -> tuple[str, int, int]:
    api_keys = get_google_cloud_api_keys()
    if not api_keys:
        return "", -1, 0

    global _api_key_round_robin_cursor
    with _api_key_round_robin_lock:
        key_index = _api_key_round_robin_cursor % len(api_keys)
        _api_key_round_robin_cursor += 1
    return api_keys[key_index], key_index, len(api_keys)


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


def classify_model_bucket(model_name: str, preferred_model: str | None = None) -> str:
    normalized = (model_name or "").strip()
    base_model = (get_vertex_model() or "").strip()
    pro_model = (get_vertex_model_pro() or "").strip()
    if normalized and normalized == pro_model:
        return MODEL_BUCKET_PRO
    if normalized and normalized == base_model:
        return MODEL_BUCKET_NANO
    preferred = (preferred_model or "").strip()
    if preferred and preferred == pro_model:
        return MODEL_BUCKET_PRO
    return MODEL_BUCKET_NANO


def get_gemini_rate_limit_runtime_enabled(api_keys: list[str] | None = None) -> bool:
    if not get_gemini_rate_limit_enabled():
        return False
    if get_effective_auth_mode() != "api_key":
        return False
    if get_api_key_profile() != "gemini":
        return False
    keys = api_keys if api_keys is not None else get_google_cloud_api_keys()
    return bool(keys)


class RateLimitStore:
    def __init__(self, state_path: Path):
        self._state_path = state_path
        self._lock = Lock()
        self._state = self._load_state()

    def _empty_state(self) -> dict[str, Any]:
        return {
            "version": 1,
            "updated_at": now_iso(),
            "events": {},
        }

    def _load_state(self) -> dict[str, Any]:
        if not self._state_path.exists():
            return self._empty_state()

        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
        except Exception as exc:  # pragma: no cover - corrupt/on-disk integration path
            logger.warning("Failed to load rate limit state '%s': %s", self._state_path, exc)
            return self._empty_state()

        events = raw.get("events") if isinstance(raw, dict) else {}
        normalized_events: dict[str, dict[str, list[dict[str, Any]]]] = {}
        if isinstance(events, dict):
            for bucket, bucket_events in events.items():
                if bucket not in MODEL_BUCKETS or not isinstance(bucket_events, dict):
                    continue
                normalized_bucket: dict[str, list[dict[str, Any]]] = {}
                for fingerprint, entries in bucket_events.items():
                    if not isinstance(fingerprint, str) or not isinstance(entries, list):
                        continue
                    normalized_entries: list[dict[str, Any]] = []
                    for event in entries:
                        if not isinstance(event, dict):
                            continue
                        ts_raw = event.get("ts")
                        try:
                            ts = float(ts_raw)
                        except (TypeError, ValueError):
                            continue
                        tokens_raw = event.get("tokens", 0)
                        try:
                            tokens = int(tokens_raw)
                        except (TypeError, ValueError):
                            tokens = 0
                        tokens = max(0, tokens)
                        event_id = event.get("id")
                        if not isinstance(event_id, str) or not event_id:
                            event_id = uuid.uuid4().hex
                        normalized_entries.append(
                            {
                                "id": event_id,
                                "ts": ts,
                                "tokens": tokens,
                            }
                        )
                    if normalized_entries:
                        normalized_entries.sort(key=lambda item: float(item["ts"]))
                        normalized_bucket[fingerprint] = normalized_entries
                if normalized_bucket:
                    normalized_events[bucket] = normalized_bucket

        return {
            "version": 1,
            "updated_at": raw.get("updated_at") if isinstance(raw, dict) else now_iso(),
            "events": normalized_events,
        }

    def _persist_locked(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self._state_path.with_suffix(self._state_path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(self._state, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
        tmp_path.replace(self._state_path)

    def _prune_locked(self, now_ts: float) -> bool:
        changed = False
        cutoff = now_ts - RPD_WINDOW_SECONDS
        events = self._state.setdefault("events", {})
        for bucket in list(events.keys()):
            bucket_events = events.get(bucket)
            if not isinstance(bucket_events, dict):
                del events[bucket]
                changed = True
                continue
            for fingerprint in list(bucket_events.keys()):
                entries = bucket_events.get(fingerprint)
                if not isinstance(entries, list):
                    del bucket_events[fingerprint]
                    changed = True
                    continue
                kept = [entry for entry in entries if float(entry.get("ts", 0.0)) >= cutoff]
                if len(kept) != len(entries):
                    changed = True
                if kept:
                    bucket_events[fingerprint] = kept
                else:
                    del bucket_events[fingerprint]
                    changed = True
            if not bucket_events:
                del events[bucket]
                changed = True
        if changed:
            self._state["updated_at"] = now_iso(now_ts)
        return changed

    def _entries_locked(self, bucket: str, key_fingerprint: str) -> list[dict[str, Any]]:
        events = self._state.setdefault("events", {})
        bucket_events = events.setdefault(bucket, {})
        return bucket_events.setdefault(key_fingerprint, [])

    @staticmethod
    def _usage_for_entries(entries: list[dict[str, Any]], now_ts: float) -> tuple[int, int, list[dict[str, Any]], list[dict[str, Any]]]:
        rpm_cutoff = now_ts - RPM_WINDOW_SECONDS
        rpd_cutoff = now_ts - RPD_WINDOW_SECONDS
        minute_events = [entry for entry in entries if float(entry.get("ts", 0.0)) >= rpm_cutoff]
        day_events = [entry for entry in entries if float(entry.get("ts", 0.0)) >= rpd_cutoff]
        rpm_used = len(minute_events)
        rpd_used = len(day_events)
        minute_events.sort(key=lambda item: float(item.get("ts", 0.0)))
        day_events.sort(key=lambda item: float(item.get("ts", 0.0)))
        return rpm_used, rpd_used, minute_events, day_events

    def _key_wait_seconds_locked(self, entries: list[dict[str, Any]], limits: dict[str, int], now_ts: float) -> int:
        if limits.get("rpm", 0) <= 0 or limits.get("rpd", 0) <= 0:
            return get_retry_after_seconds()

        rpm_used, rpd_used, minute_events, day_events = self._usage_for_entries(entries, now_ts)
        waits: list[float] = []

        rpm_limit = limits["rpm"]
        if rpm_used >= rpm_limit and minute_events:
            release_index = max(0, rpm_used - rpm_limit)
            release_ts = float(minute_events[release_index].get("ts", now_ts)) + RPM_WINDOW_SECONDS
            waits.append(max(0.0, release_ts - now_ts))

        rpd_limit = limits["rpd"]
        if rpd_used >= rpd_limit and day_events:
            release_index = max(0, rpd_used - rpd_limit)
            release_ts = float(day_events[release_index].get("ts", now_ts)) + RPD_WINDOW_SECONDS
            waits.append(max(0.0, release_ts - now_ts))

        if not waits:
            return 0
        return max(1, int(math.ceil(max(waits))))

    def _is_key_available_locked(self, entries: list[dict[str, Any]], limits: dict[str, int], now_ts: float) -> bool:
        if limits.get("rpm", 0) <= 0 or limits.get("rpd", 0) <= 0:
            return False

        rpm_used, rpd_used, _, _ = self._usage_for_entries(entries, now_ts)
        return (
            rpm_used < limits["rpm"]
            and rpd_used < limits["rpd"]
        )

    def reserve_key(
        self,
        model_bucket: str,
        api_keys: list[str],
        limits: dict[str, int],
        start_index: int,
    ) -> tuple[dict[str, Any] | None, int]:
        with self._lock:
            now_ts = time.time()
            state_changed = self._prune_locked(now_ts)

            if not api_keys:
                if state_changed:
                    self._persist_locked()
                return None, get_retry_after_seconds()

            waits: list[int] = []
            key_count = len(api_keys)
            for offset in range(key_count):
                key_index = (start_index + offset) % key_count
                api_key = api_keys[key_index]
                key_fingerprint = fingerprint_api_key(api_key)
                entries = self._entries_locked(model_bucket, key_fingerprint)

                if self._is_key_available_locked(entries, limits, now_ts):
                    event_id = uuid.uuid4().hex
                    entries.append(
                        {
                            "id": event_id,
                            "ts": now_ts,
                        }
                    )
                    self._state["updated_at"] = now_iso(now_ts)
                    self._persist_locked()
                    return (
                        {
                            "api_key": api_key,
                            "key_index": key_index,
                            "key_count": key_count,
                            "key_fingerprint": key_fingerprint,
                            "event_id": event_id,
                        },
                        0,
                    )

                wait_seconds = self._key_wait_seconds_locked(entries, limits, now_ts)
                if wait_seconds > 0:
                    waits.append(wait_seconds)

            if state_changed:
                self._persist_locked()
            retry_after_seconds = min(waits) if waits else get_retry_after_seconds()
            return None, max(1, int(retry_after_seconds))

    def finalize_reservation(self, reservation: RateLimitReservation) -> None:
        with self._lock:
            now_ts = time.time()
            state_changed = self._prune_locked(now_ts)
            entries = self._entries_locked(reservation.model_bucket, reservation.key_fingerprint)

            updated = False
            for event in entries:
                if event.get("id") != reservation.event_id:
                    continue
                # Move timestamp to completion moment so RPM reflects completed requests,
                # which is easier to observe when a single generation can run >60s.
                event["ts"] = max(float(event.get("ts", now_ts)), now_ts)
                updated = True
                break

            if updated:
                self._state["updated_at"] = now_iso(now_ts)
                self._persist_locked()
            elif state_changed:
                self._persist_locked()

    def snapshot(
        self,
        api_keys: list[str],
        limits_by_bucket: dict[str, dict[str, int]],
        enabled: bool,
    ) -> dict[str, Any]:
        with self._lock:
            now_ts = time.time()
            state_changed = self._prune_locked(now_ts)
            if state_changed:
                self._persist_locked()

            models: dict[str, dict[str, Any]] = {}
            for model_bucket in MODEL_BUCKETS:
                limits = limits_by_bucket.get(model_bucket, DEFAULT_GEMINI_RATE_LIMIT_DEFAULTS[model_bucket])
                rpm_total = max(0, int(limits.get("rpm", 0))) * len(api_keys)
                rpd_total = max(0, int(limits.get("rpd", 0))) * len(api_keys)

                rpm_used_total = 0
                rpd_used_total = 0
                any_key_available = False
                blocked_waits: list[int] = []

                for api_key in api_keys:
                    key_fingerprint = fingerprint_api_key(api_key)
                    entries = self._entries_locked(model_bucket, key_fingerprint)
                    rpm_used, rpd_used, _, _ = self._usage_for_entries(entries, now_ts)
                    rpm_used_total += rpm_used
                    rpd_used_total += rpd_used

                    if self._is_key_available_locked(entries, limits, now_ts):
                        any_key_available = True
                    else:
                        blocked_wait = self._key_wait_seconds_locked(entries, limits, now_ts)
                        if blocked_wait > 0:
                            blocked_waits.append(blocked_wait)

                exhausted = enabled and bool(api_keys) and not any_key_available
                retry_after_seconds = min(blocked_waits) if exhausted and blocked_waits else 0
                models[model_bucket] = {
                    "label": MODEL_BUCKET_LABELS[model_bucket],
                    "rpm": {"used": rpm_used_total, "limit": rpm_total},
                    "rpd": {"used": rpd_used_total, "limit": rpd_total},
                    "exhausted": exhausted,
                    "retry_after_seconds": retry_after_seconds,
                }

            return {
                "updated_at": self._state.get("updated_at") or now_iso(now_ts),
                "models": models,
            }


@lru_cache(maxsize=1)
def get_rate_limit_store(path_key: str) -> RateLimitStore:
    return RateLimitStore(Path(path_key))


def get_rate_limit_store_instance() -> RateLimitStore:
    return get_rate_limit_store(str(get_gemini_rate_limit_state_path()))


def get_gemini_rate_limit_status_payload() -> dict[str, Any]:
    api_keys = get_google_cloud_api_keys()
    defaults = get_gemini_rate_limit_defaults()
    enabled = get_gemini_rate_limit_runtime_enabled(api_keys)
    snapshot = get_rate_limit_store_instance().snapshot(api_keys, defaults, enabled)
    return {
        "enabled": enabled,
        "key_pool_size": len(api_keys),
        "updated_at": snapshot["updated_at"],
        "poll_ms": get_gemini_rate_limit_poll_ms(),
        "models": snapshot["models"],
    }


def reserve_api_key_for_model(model_bucket: str) -> tuple[str, int, int, RateLimitReservation | None]:
    api_keys = get_google_cloud_api_keys()
    if not api_keys:
        return "", -1, 0, None

    global _api_key_round_robin_cursor
    with _api_key_round_robin_lock:
        start_index = _api_key_round_robin_cursor % len(api_keys)

    if get_gemini_rate_limit_runtime_enabled(api_keys):
        limits_by_bucket = get_gemini_rate_limit_defaults()
        limits = limits_by_bucket.get(model_bucket, DEFAULT_GEMINI_RATE_LIMIT_DEFAULTS[MODEL_BUCKET_NANO])
        allocation, retry_after = get_rate_limit_store_instance().reserve_key(
            model_bucket,
            api_keys,
            limits,
            start_index,
        )
        if not allocation:
            with _api_key_round_robin_lock:
                _api_key_round_robin_cursor = start_index + 1
            raise LocalRateLimitExceededError(model_bucket=model_bucket, retry_after_seconds=retry_after)

        with _api_key_round_robin_lock:
            _api_key_round_robin_cursor = int(allocation["key_index"]) + 1

        reservation = RateLimitReservation(
            model_bucket=model_bucket,
            key_fingerprint=str(allocation["key_fingerprint"]),
            event_id=str(allocation["event_id"]),
        )
        return (
            str(allocation["api_key"]),
            int(allocation["key_index"]),
            int(allocation["key_count"]),
            reservation,
        )

    with _api_key_round_robin_lock:
        key_index = _api_key_round_robin_cursor % len(api_keys)
        _api_key_round_robin_cursor += 1
    return api_keys[key_index], key_index, len(api_keys), None


def finalize_rate_limit_reservation(reservation: RateLimitReservation | None) -> None:
    if not reservation:
        return
    try:
        get_rate_limit_store_instance().finalize_reservation(reservation)
    except Exception as exc:  # pragma: no cover - storage integration path
        logger.warning("Failed to finalize local rate limit reservation: %s", exc)


@lru_cache(maxsize=16)
def get_api_key_client(api_key: str, backend: str, timeout_ms: int) -> genai.Client:
    # google-genai expects timeout in milliseconds.
    http_options = types.HttpOptions(timeout=timeout_ms)
    if backend == "gemini":
        return genai.Client(api_key=api_key, http_options=http_options)
    return genai.Client(vertexai=True, api_key=api_key, http_options=http_options)


@lru_cache(maxsize=1)
def get_vertex_client(project: str, location: str, timeout_ms: int) -> genai.Client:
    # google-genai expects timeout in milliseconds.
    http_options = types.HttpOptions(timeout=timeout_ms)
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", project)
    os.environ.setdefault("GCLOUD_PROJECT", project)
    return genai.Client(
        vertexai=True,
        project=project,
        location=location,
        http_options=http_options,
    )


def get_client(model_bucket: str) -> tuple[genai.Client, str, RateLimitReservation | None]:
    project = get_vertex_project()
    auth_mode = get_effective_auth_mode()

    if auth_mode == "api_key":
        api_key, key_index, key_count, reservation = reserve_api_key_for_model(model_bucket)
        if not api_key:
            raise RuntimeError(
                "VERTEX_AUTH_MODE=api_key requires GOOGLE_CLOUD_API_KEY, "
                "or the selected profile key in GOOGLE_CLOUD_API_KEY_GEMINI/GOOGLE_CLOUD_API_KEY_AISTUDIO."
            )
        backend = resolve_api_key_backend(api_key)
        if key_count > 1:
            logger.info(
                "Using API key %s/%s for profile '%s'",
                key_index + 1,
                key_count,
                get_api_key_profile(),
            )
        return get_api_key_client(api_key, backend, get_http_timeout_ms()), backend, reservation

    if not project:
        if auth_mode == "adc":
            raise RuntimeError(
                "VERTEX_AUTH_MODE=adc requires VERTEX_PROJECT_ID (or GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT)."
            )
        raise RuntimeError(
            "Missing Vertex credentials. Set VERTEX_PROJECT_ID for ADC mode or "
            "set VERTEX_AUTH_MODE=api_key with GOOGLE_CLOUD_API_KEY."
        )
    return get_vertex_client(project, get_vertex_location(), get_http_timeout_ms()), "vertex", None


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


def build_generate_config(backend: str | None = None) -> types.GenerateContentConfig:
    resolved_backend = backend or get_effective_api_backend()
    image_config_kwargs = {
        "aspect_ratio": get_aspect_ratio(),
    }
    # Gemini Developer API currently rejects image_size/output_mime_type.
    if resolved_backend != "gemini":
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
    api_keys = get_google_cloud_api_keys()
    api_key = api_keys[0] if api_keys else ""
    return {
        "ok": bool(project or api_key),
        "vertex_project_id": project or None,
        "vertex_location": get_vertex_location(),
        "vertex_auth_mode": get_vertex_auth_mode(),
        "effective_auth_mode": get_auth_mode(),
        "api_key_profile": get_api_key_profile(),
        "api_key_backend": get_api_key_backend(),
        "effective_api_backend": get_effective_api_backend(),
        "api_key_pool_size": len(api_keys),
        "vertex_model": get_vertex_model(),
        "vertex_model_pro": get_vertex_model_pro(),
        "model_fallbacks": get_model_fallbacks(),
        "candidate_models": get_candidate_models(),
        "auth_mode": get_auth_mode(),
        "api_key_configured": bool(api_key),
        "response_modalities": get_response_modalities(),
        "image_size": get_image_size(),
        "http_timeout_ms": get_http_timeout_ms(),
        "stream_timeout_ms": get_stream_timeout_ms(),
        "gemini_rate_limit_enabled": get_gemini_rate_limit_enabled(),
        "gemini_rate_limit_runtime_enabled": get_gemini_rate_limit_runtime_enabled(api_keys),
        "gemini_rate_limit_state_path": str(get_gemini_rate_limit_state_path()),
        "gemini_rate_limit_defaults": get_gemini_rate_limit_defaults(),
        "gemini_rate_limit_poll_ms": get_gemini_rate_limit_poll_ms(),
    }


@app.get("/v1/rate-limit-status", response_model=RateLimitStatusResponse)
async def rate_limit_status() -> RateLimitStatusResponse:
    return RateLimitStatusResponse.model_validate(get_gemini_rate_limit_status_payload())


@app.post("/v1/generate-grid", response_model=GenerateGridResponse)
def generate_grid(payload: GenerateGridRequest) -> GenerateGridResponse:
    grid_png = decode_base64_png(payload.grid_png_base64)
    models = get_candidate_models(payload.model)
    prompt_text = build_prompt(payload.prompt, payload.style_name, payload.negative_prompt)
    last_error: Exception | None = None

    for model_name in models:
        model_bucket = classify_model_bucket(model_name, payload.model)
        try:
            client, backend, reservation = get_client(model_bucket=model_bucket)
        except LocalRateLimitExceededError as exc:
            label = MODEL_BUCKET_LABELS.get(exc.model_bucket, exc.model_bucket)
            raise HTTPException(
                status_code=429,
                detail=f"{label} rate limit reached. Please wait and retry.",
                headers={"Retry-After": str(exc.retry_after_seconds)},
            ) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

        generate_config = build_generate_config(backend)
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
                config=generate_config,
            )
            finalize_rate_limit_reservation(reservation)

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
            finalize_rate_limit_reservation(reservation)
            if is_rate_limit_error(exc):
                logger.warning("Model '%s' hit upstream rate limit: %s", model_name, exc)
                raise HTTPException(
                    status_code=429,
                    detail=f"Model '{model_name}' hit upstream rate limit. Please wait and retry.",
                    headers={"Retry-After": str(get_retry_after_seconds())},
                ) from exc
            if is_model_access_error(exc):
                logger.warning("Model '%s' unavailable: %s", model_name, exc)
                continue
            logger.exception("Vertex generate_content call failed for model '%s'", model_name)
            raise HTTPException(status_code=500, detail=f"Vertex request failed: {exc}") from exc

    raise HTTPException(
        status_code=500,
        detail=f"No usable Vertex image model found in candidates {models}: {last_error}",
    )
