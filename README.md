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
GOOGLE_CLOUD_API_KEY_GEMINI="your-gemini-key-1,your-gemini-key-2,your-gemini-key-3" # round-robin by request
GOOGLE_CLOUD_API_KEY_AISTUDIO="your-aistudio-key"
GEMINI_RATE_LIMIT_ENABLED="1"
GEMINI_RATE_LIMIT_STATE_PATH=".temp/gemini-rate-limit-state.json"
GEMINI_RATE_LIMIT_DEFAULTS_JSON='{"nano_banana":{"rpm":500,"rpd":2000},"nano_banana_pro":{"rpm":20,"rpd":250}}'
GEMINI_RATE_LIMIT_POLL_MS="5000"
```

6. Edit `.env.local` if needed:

```env
NEXT_HOST="0.0.0.0"
BASIC_AUTH_USER="admin"
BASIC_AUTH_PASSWORD="change-this-password"
PY_IMAGE_SERVICE_URL="http://127.0.0.1:8001"
PY_IMAGE_SERVICE_TIMEOUT_MS="120000"
PY_IMAGE_SERVICE_MAX_ATTEMPTS="1"
VERTEX_PROJECT_ID="lucid-formula-484716-e0"
VERTEX_LOCATION="us-central1"
VERTEX_AUTH_MODE="api_key"
VERTEX_MODEL="gemini-2.5-flash-image"
VERTEX_MODEL_PRO="gemini-3-pro-image-preview"
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
GOOGLE_CLOUD_API_KEY_GEMINI="" # single key or comma-separated key pool
GOOGLE_CLOUD_API_KEY_AISTUDIO=""
GOOGLE_CLOUD_API_KEY=""
GEMINI_RATE_LIMIT_ENABLED="1"
GEMINI_RATE_LIMIT_STATE_PATH=".temp/gemini-rate-limit-state.json"
GEMINI_RATE_LIMIT_DEFAULTS_JSON='{"nano_banana":{"rpm":500,"rpd":2000},"nano_banana_pro":{"rpm":20,"rpd":250}}'
GEMINI_RATE_LIMIT_POLL_MS="5000"
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

This project now binds Next.js to `0.0.0.0` by default for `dev` and `start` (override with `NEXT_HOST` if needed).

## Tilemaps (Multi-Map)

- The app now supports multiple tilemaps with a left sidebar (`/map`).
- Create new tilemaps from:
  - `blank` (custom size `1..256` x `1..256`)
  - `moon` (fixed index range `0..60 x 0..40`, actual `61x41` tiles)
- Map selection is stored in URL via `?mapId=...`.
- Timeline selection is stored in URL via `?t=...` (1-based, default `t=1`).
- Map switch in the workspace keeps `mapId` and resets timeline to `t=1`.

Data layout:

- `.tilemaps/presets/moon/tiles/` -> moon preset source tiles
- `.tilemaps/maps/<mapId>/map.json` -> tilemap manifest
- `.tilemaps/maps/<mapId>/tiles/` -> tile images
- `.tilemaps/maps/<mapId>/meta/` -> tile metadata JSON
- `.tilemaps/maps/<mapId>/timeline/manifest.json` -> timeline manifest for this map
- `.tilemaps/maps/<mapId>/timeline/nodes/<nodeId>/tiles/` -> timeline overlay tile files
- `.tilemaps/maps/<mapId>/timeline/nodes/<nodeId>/meta/` -> timeline overlay metadata
- `.tilemaps/maps/<mapId>/locks/` -> lock files
- `.tilemaps/maps/<mapId>/queue/` -> queue files

On first bootstrap, legacy `.tiles` is migrated into moon preset tiles using `z_y_x -> z_x_y` conversion, then `default` is created from that preset.
If legacy `.timeline/` exists, it is migrated to `default` map timeline storage.

All timeline-aware APIs (`/api/timeline`, `/api/meta/:z/:x/:y`, `/api/tiles/:z/:x/:y`, `/api/claim`, `/api/invalidate`, `/api/edit-tile`, `/api/confirm-edit`) resolve state using both `mapId` and `t`.

## Precompute Parent Tiles (Manual)

Use this command to generate all parent zoom levels (`z=0..ZMAX-1`) for one tilemap from existing child tiles:

```bash
corepack yarn regen:parents [mapId]
```

- If `mapId` is omitted, it defaults to `default`.
- Example: `corepack yarn regen:parents default`
- This is a manual operation; it is not run automatically on app startup or map creation.
- If the map does not exist, the command exits with an error (for example: `Tilemap "..." not found`).

## Public Internet Access + Password

1. Set password protection in `.env.local`:

```env
BASIC_AUTH_USER="your-user"
BASIC_AUTH_PASSWORD="your-strong-password"
```

2. Keep Python service local-only (already default): `127.0.0.1:8001`.

3. Expose only the Next.js app (`3000`) to the internet:

- Recommended quick method (Cloudflare Tunnel):

```bash
cloudflared tunnel --url http://127.0.0.1:3000
```

- Or use router port-forwarding / a reverse proxy to your host on port `3000`.

4. Open the public URL. Browser will prompt for Basic Auth credentials.

Notes:
- If `BASIC_AUTH_USER` or `BASIC_AUTH_PASSWORD` is empty, auth is disabled.
- Use a strong password before exposing the service publicly.
- In the Generate Preview modal, you can choose `Nano Banana` or `Nano Banana Pro` before generation.
- `Nano Banana Pro` uses `VERTEX_MODEL_PRO` (default `gemini-3-pro-image-preview`), and will fall back to `VERTEX_MODEL`/fallback list if unavailable.

## Health Check

Check Python service:

```bash
curl http://127.0.0.1:8001/healthz
```

Check local Gemini key pool quota status:

```bash
curl http://127.0.0.1:8001/v1/rate-limit-status
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
- `gemini_rate_limit_enabled`
- `gemini_rate_limit_runtime_enabled`
- `gemini_rate_limit_state_path`
- `gemini_rate_limit_defaults`
- `gemini_rate_limit_poll_ms`

## Notes

- `GOOGLE_API_KEY_PROFILE` is the single switch to swap keys (`gemini` or `aistudio`).
- `GOOGLE_CLOUD_API_KEY_GEMINI` / `GOOGLE_CLOUD_API_KEY_AISTUDIO` can be comma-separated key pools; the Python service rotates keys in round-robin per generation request.
- `GOOGLE_CLOUD_API_KEY_BACKEND="auto"` detects backend by key pattern (`AIza...` => Gemini Developer API, otherwise Vertex API key path).
- Gemini Developer API path does not use `image_size`/`output_mime_type`; the service adapts config automatically.
- `VERTEX_MODEL_FALLBACKS` is comma-separated and optional.
- Defaults are tuned for responsiveness (`IMAGE` only, `1K`, server stream timeout 90s).
- Stub tile fallback is disabled by default (`ALLOW_STUB_FALLBACK="0"`), so generation errors are visible instead of silent solid-color tiles.
- Rate limit responses are surfaced as `429` with `Retry-After`, instead of being collapsed into generic `500`.
- Sidebar (`/map`) shows aggregated `RPM/RPD` for `Nano Banana` and `Nano Banana Pro`.
- Next.js proxy endpoint `/api/rate-limit-status` reads Python `/v1/rate-limit-status` for frontend polling.
- Local key-pool limiter persists to disk (`GEMINI_RATE_LIMIT_STATE_PATH`), so counters survive service restarts.
- Generation UI disables model actions when local limiter reports exhausted quota; backend still enforces hard `429`.

## Import NASA Moon Background Tiles

This repo includes a Python tool for importing a NASA Moon tile range into `.tilemaps/presets/moon/tiles/` for the built-in `moon` template.

Default source range:
- `z=8`
- `x=100..140`
- `y=300..360`

Default behavior:
- Saves to `.tilemaps/presets/moon/tiles/{z}_{x}_{y}.webp`
- Uses `window-zero` mapping (`dstX=srcX-100`, `dstY=srcY-300`)
- Uses moderate rate settings (`concurrency=4`, request spacing + jitter, retries on `429/5xx`)
- Does not write tile metadata records
- Runs parent regeneration (`scripts/regen-parents.cjs`) when new tiles were downloaded

Run with defaults:

```bash
corepack yarn tools:moon:import
```

Dry-run mapping preview (no downloads):

```bash
python tools/import_nasa_moon_tiles.py --dry-run
```

Custom range / mapping example:

```bash
corepack yarn tools:moon:import:custom -- --x-min 100 --x-max 101 --y-min 300 --y-max 301 --map-mode offset --offset-x 10 --offset-y -256 --no-generate-parents
```

Useful flags:
- `--overwrite`
- `--concurrency`
- `--min-interval-ms`
- `--jitter-ms`
- `--max-retries`
- `--timeout-ms`

### Git LFS for moon preset tiles (recommended)

If you want forks/clones to reuse moon preset background tiles without re-crawling, store `.tilemaps/presets/moon/tiles/*.webp` in Git LFS.

One-time setup:

```bash
git lfs install
git lfs pull
```

After clone/fork:

```bash
git lfs pull
```

CI note:
- If your CI needs local moon preset files, enable LFS fetch in checkout; otherwise only pointer files are present.
