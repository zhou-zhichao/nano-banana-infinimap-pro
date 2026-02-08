# Nano Banana Infinimap (Vertex + Python Service)

An experimental infinite map generator that creates seamless, neighbor-aware tiles on demand.

This fork runs image generation through a local Python FastAPI service backed by Vertex AI, and the Next.js app calls that service.

## Stack

- Next.js 15 + TypeScript
- Sharp image processing
- Local file-based tile store
- Python FastAPI image service (`pyservice/`)
- Vertex AI model default: `gemini-2.5-flash-image`

## Prerequisites

- Node.js 18+
- Corepack (bundled with modern Node.js)
- Python 3.10+
- Google Cloud CLI (`gcloud`)
- A Google Cloud project with Vertex AI API enabled

## Setup

1. Install JavaScript dependencies:

```bash
corepack yarn install
```

2. Create a Python virtual environment and install packages:

```bash
python -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\pip install -r pyservice/requirements.txt
```

3. Create local environment file:

```bash
copy .env.local.example .env.local
```

4. Configure Vertex authentication (ADC):

```bash
gcloud auth application-default login
gcloud config set project lucid-formula-484716-e0
gcloud auth application-default set-quota-project lucid-formula-484716-e0
gcloud services enable aiplatform.googleapis.com
```

5. Optional: if you prefer API key auth instead of ADC, set:

```env
VERTEX_AUTH_MODE="api_key"
GOOGLE_API_KEY_PROFILE="gemini" # or "aistudio"
GOOGLE_CLOUD_API_KEY_BACKEND="auto" # auto | gemini | vertex
GOOGLE_CLOUD_API_KEY_GEMINI="your-gemini-key"
GOOGLE_CLOUD_API_KEY_AISTUDIO="your-aistudio-key"
```

6. Edit `.env.local` if needed:

```env
PY_IMAGE_SERVICE_URL="http://127.0.0.1:8001"
PY_IMAGE_SERVICE_TIMEOUT_MS="120000"
PY_IMAGE_SERVICE_MAX_ATTEMPTS="1"
VERTEX_PROJECT_ID="lucid-formula-484716-e0"
VERTEX_LOCATION="us-central1"
VERTEX_AUTH_MODE="api_key"
VERTEX_MODEL="gemini-2.5-flash-image"
VERTEX_MODEL_FALLBACKS=""
VERTEX_RESPONSE_MODALITIES="IMAGE"
VERTEX_IMAGE_SIZE="1K"
VERTEX_ASPECT_RATIO="1:1"
VERTEX_OUTPUT_MIME_TYPE="image/png"
VERTEX_MAX_OUTPUT_TOKENS="4096"
VERTEX_HTTP_TIMEOUT_MS="105000"
VERTEX_STREAM_TIMEOUT_MS="90000"
VERTEX_RETRY_AFTER_SECONDS="30"
GOOGLE_API_KEY_PROFILE="gemini"
GOOGLE_CLOUD_API_KEY_BACKEND="auto"
GOOGLE_CLOUD_API_KEY_GEMINI=""
GOOGLE_CLOUD_API_KEY_AISTUDIO=""
GOOGLE_CLOUD_API_KEY=""
ALLOW_STUB_FALLBACK="0"
```

## Run

Start Python service:

```bash
corepack yarn dev:py
```

Start web app in another terminal:

```bash
corepack yarn dev
```

Open `http://localhost:3000`.

## Health Check

Check Python service:

```bash
curl http://127.0.0.1:8001/healthz
```

Expected result includes:

- `ok: true`
- `vertex_project_id`
- `vertex_location`
- `vertex_auth_mode`
- `effective_auth_mode`
- `api_key_profile`
- `api_key_backend`
- `vertex_model`
- `auth_mode`
- `candidate_models`
- `response_modalities`
- `image_size`
- `http_timeout_ms`
- `stream_timeout_ms`

## Notes

- `GOOGLE_API_KEY_PROFILE` is the single switch to swap keys (`gemini` or `aistudio`).
- `GOOGLE_CLOUD_API_KEY_BACKEND="auto"` detects backend by key pattern (`AIza...` => Gemini Developer API, otherwise Vertex API key path).
- Gemini Developer API path does not use `image_size`/`output_mime_type`; the service adapts config automatically.
- `VERTEX_MODEL_FALLBACKS` is comma-separated and optional.
- Defaults are tuned for responsiveness (`IMAGE` only, `1K`, server stream timeout 90s).
- Stub tile fallback is disabled by default (`ALLOW_STUB_FALLBACK="0"`), so generation errors are visible instead of silent solid-color tiles.
- Rate limit responses are surfaced as `429` with `Retry-After`, instead of being collapsed into generic `500`.
