#!/usr/bin/env python3
"""Import NASA Moon tiles into local .tiles as z_x_y.webp files.

Default source range:
  z=8, x=100..140, y=300..360

Default mapping mode:
  window-zero -> dstX = srcX - x_min, dstY = srcY - y_min
"""

from __future__ import annotations

import argparse
import io
import os
import random
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image

NASA_TILE_URL_TEMPLATE = (
    "https://trek.nasa.gov/tiles/Moon/EQ/"
    "Apollo15_MetricCam_Shade_Global_1024ppd/1.0.0/default/default028mm/"
    "{z}/{x}/{y}.png"
)
RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}
USER_AGENT = "moon-map-track-importer/1.0"


@dataclass(frozen=True)
class TileTask:
    z: int
    src_x: int
    src_y: int
    dst_x: int
    dst_y: int
    url: str
    out_path: Path


@dataclass
class Stats:
    planned: int = 0
    downloaded: int = 0
    skipped: int = 0
    failed: int = 0
    retried: int = 0

    def __post_init__(self) -> None:
        self._lock = threading.Lock()

    def inc(self, field: str, amount: int = 1) -> None:
        with self._lock:
            setattr(self, field, getattr(self, field) + amount)

    def snapshot(self) -> dict[str, int]:
        with self._lock:
            return {
                "planned": self.planned,
                "downloaded": self.downloaded,
                "skipped": self.skipped,
                "failed": self.failed,
                "retried": self.retried,
            }


class RateLimiter:
    """Global request scheduler shared across workers."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._next_allowed_at = time.monotonic()

    def wait_for_slot(self, min_interval_ms: int, jitter_ms: int) -> None:
        min_interval = max(0, min_interval_ms) / 1000.0
        jitter = random.uniform(0, max(0, jitter_ms) / 1000.0)
        spacing = min_interval + jitter

        with self._lock:
            now = time.monotonic()
            slot_time = max(now, self._next_allowed_at)
            self._next_allowed_at = slot_time + spacing

        wait_seconds = slot_time - time.monotonic()
        if wait_seconds > 0:
            time.sleep(wait_seconds)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download NASA Moon tiles and save as local .tiles/{z}_{x}_{y}.webp"
    )
    parser.add_argument("--z", type=int, default=8, help="Zoom level in source URL.")
    parser.add_argument("--x-min", type=int, default=100)
    parser.add_argument("--x-max", type=int, default=140)
    parser.add_argument("--y-min", type=int, default=300)
    parser.add_argument("--y-max", type=int, default=360)
    parser.add_argument(
        "--map-mode",
        choices=("window-zero", "offset", "identity"),
        default="window-zero",
        help="Coordinate mapping mode for destination tile names.",
    )
    parser.add_argument("--offset-x", type=int, default=0)
    parser.add_argument("--offset-y", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--min-interval-ms", type=int, default=250)
    parser.add_argument("--jitter-ms", type=int, default=120)
    parser.add_argument("--max-retries", type=int, default=5)
    parser.add_argument("--timeout-ms", type=int, default=20000)
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing .webp tiles.")
    parser.add_argument(
        "--generate-parents",
        dest="generate_parents",
        action="store_true",
        default=True,
        help="Generate z<max parent tiles after import (default: true).",
    )
    parser.add_argument(
        "--no-generate-parents",
        dest="generate_parents",
        action="store_false",
        help="Skip parent generation after import.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Preview mapping without downloading.")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.z < 0:
        raise ValueError("--z must be >= 0")
    if args.x_min > args.x_max:
        raise ValueError("--x-min must be <= --x-max")
    if args.y_min > args.y_max:
        raise ValueError("--y-min must be <= --y-max")
    if args.concurrency <= 0:
        raise ValueError("--concurrency must be >= 1")
    if args.max_retries < 0:
        raise ValueError("--max-retries must be >= 0")
    if args.timeout_ms <= 0:
        raise ValueError("--timeout-ms must be > 0")


def map_coords(src_x: int, src_y: int, args: argparse.Namespace) -> tuple[int, int]:
    if args.map_mode == "window-zero":
        return src_x - args.x_min, src_y - args.y_min
    if args.map_mode == "offset":
        return src_x + args.offset_x, src_y + args.offset_y
    return src_x, src_y


def build_tasks(args: argparse.Namespace, repo_root: Path) -> list[TileTask]:
    tile_dir = repo_root / ".tiles"
    tasks: list[TileTask] = []
    for sx in range(args.x_min, args.x_max + 1):
        for sy in range(args.y_min, args.y_max + 1):
            dx, dy = map_coords(sx, sy, args)
            if dx < 0 or dy < 0:
                raise ValueError(
                    "Mapped destination coordinates must be >= 0. "
                    f"Got ({dx}, {dy}) from src ({sx}, {sy})."
                )
            url = NASA_TILE_URL_TEMPLATE.format(z=args.z, x=sx, y=sy)
            out_path = tile_dir / f"{args.z}_{dx}_{dy}.webp"
            tasks.append(
                TileTask(
                    z=args.z,
                    src_x=sx,
                    src_y=sy,
                    dst_x=dx,
                    dst_y=dy,
                    url=url,
                    out_path=out_path,
                )
            )
    return tasks


def parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    if raw.isdigit():
        return float(raw)
    try:
        when = parsedate_to_datetime(raw)
    except Exception:
        return None
    now = time.time()
    return max(0.0, when.timestamp() - now)


def compute_backoff_seconds(attempt_index: int, retry_after_header: Optional[str]) -> float:
    retry_after_seconds = parse_retry_after(retry_after_header)
    base = min(30.0, 0.75 * (2 ** attempt_index)) + random.uniform(0.0, 0.4)
    if retry_after_seconds is not None:
        return max(base, retry_after_seconds)
    return base


def fetch_png_bytes(task: TileTask, args: argparse.Namespace, limiter: RateLimiter, stats: Stats) -> bytes:
    attempt = 0
    timeout_seconds = args.timeout_ms / 1000.0

    while True:
        try:
            limiter.wait_for_slot(args.min_interval_ms, args.jitter_ms)
            req = Request(
                task.url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "image/png,image/*;q=0.9,*/*;q=0.8",
                },
            )
            with urlopen(req, timeout=timeout_seconds) as resp:
                return resp.read()
        except HTTPError as err:
            if err.code in RETRYABLE_HTTP_STATUS and attempt < args.max_retries:
                wait_seconds = compute_backoff_seconds(attempt, err.headers.get("Retry-After"))
                attempt += 1
                stats.inc("retried")
                time.sleep(wait_seconds)
                continue
            raise
        except (URLError, TimeoutError, OSError):
            if attempt < args.max_retries:
                wait_seconds = compute_backoff_seconds(attempt, None)
                attempt += 1
                stats.inc("retried")
                time.sleep(wait_seconds)
                continue
            raise


def png_to_webp_bytes(png_data: bytes) -> bytes:
    with Image.open(io.BytesIO(png_data)) as img:
        out = io.BytesIO()
        if "A" in img.getbands():
            converted = img.convert("RGBA")
        else:
            converted = img.convert("RGB")
        converted.save(out, format="WEBP", quality=90, method=6)
        return out.getvalue()


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            delete=False,
            dir=str(path.parent),
            prefix=f"{path.name}.",
            suffix=".tmp",
        ) as tmp:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp_name = tmp.name
        os.replace(tmp_name, path)
    finally:
        if tmp_name and os.path.exists(tmp_name):
            os.remove(tmp_name)


def process_task(task: TileTask, args: argparse.Namespace, limiter: RateLimiter, stats: Stats) -> None:
    if task.out_path.exists() and not args.overwrite:
        stats.inc("skipped")
        return

    png_data = fetch_png_bytes(task, args, limiter, stats)
    webp_data = png_to_webp_bytes(png_data)
    atomic_write(task.out_path, webp_data)
    stats.inc("downloaded")


def run_parent_regen(repo_root: Path) -> int:
    print("Running parent tile generation: node scripts/regen-parents.cjs")
    proc = subprocess.run(
        ["node", "scripts/regen-parents.cjs"],
        cwd=str(repo_root),
        check=False,
    )
    return proc.returncode


def main() -> int:
    args = parse_args()
    try:
        validate_args(args)
    except ValueError as exc:
        print(f"Argument error: {exc}", file=sys.stderr)
        return 2

    repo_root = Path(__file__).resolve().parents[1]
    tasks = build_tasks(args, repo_root)
    stats = Stats(planned=len(tasks))

    if not tasks:
        print("No tasks generated.")
        return 0

    first = tasks[0]
    last = tasks[-1]
    print("Import plan")
    print(
        f"  Source range: z={args.z}, x={args.x_min}..{args.x_max}, y={args.y_min}..{args.y_max}"
    )
    print(f"  Map mode: {args.map_mode}")
    if args.map_mode == "offset":
        print(f"  Offset: x={args.offset_x}, y={args.offset_y}")
    print(
        f"  First mapping: src({first.src_x},{first.src_y}) -> dst({first.dst_x},{first.dst_y}) "
        f"=> {first.out_path.name}"
    )
    print(
        f"  Last mapping:  src({last.src_x},{last.src_y}) -> dst({last.dst_x},{last.dst_y}) "
        f"=> {last.out_path.name}"
    )
    print(
        "  Rate: "
        f"concurrency={args.concurrency}, min_interval_ms={args.min_interval_ms}, "
        f"jitter_ms={args.jitter_ms}, max_retries={args.max_retries}"
    )

    if args.dry_run:
        print("Dry-run enabled; no files downloaded.")
        summary = stats.snapshot()
        print(
            "Summary: planned={planned} downloaded={downloaded} skipped={skipped} failed={failed} retried={retried}".format(
                **summary
            )
        )
        return 0

    limiter = RateLimiter()
    completed = 0

    from concurrent.futures import ThreadPoolExecutor, as_completed

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        future_to_task = {
            pool.submit(process_task, task, args, limiter, stats): task for task in tasks
        }
        for future in as_completed(future_to_task):
            task = future_to_task[future]
            completed += 1
            try:
                future.result()
            except Exception as exc:
                stats.inc("failed")
                print(
                    f"FAILED src({task.src_x},{task.src_y}) -> dst({task.dst_x},{task.dst_y}) "
                    f"url={task.url} error={exc}"
                )
            if completed % 50 == 0 or completed == len(tasks):
                snapshot = stats.snapshot()
                print(
                    "Progress: {}/{} downloaded={} skipped={} failed={} retried={}".format(
                        completed,
                        len(tasks),
                        snapshot["downloaded"],
                        snapshot["skipped"],
                        snapshot["failed"],
                        snapshot["retried"],
                    )
                )

    snapshot = stats.snapshot()
    print(
        "Summary: planned={planned} downloaded={downloaded} skipped={skipped} failed={failed} retried={retried}".format(
            **snapshot
        )
    )

    parent_rc = 0
    if args.generate_parents and snapshot["downloaded"] > 0:
        parent_rc = run_parent_regen(repo_root)
        if parent_rc != 0:
            print(f"Parent tile generation failed with exit code {parent_rc}", file=sys.stderr)
    elif args.generate_parents:
        print("Skipping parent generation because no new tiles were downloaded.")

    if snapshot["failed"] > 0:
        return 1
    if parent_rc != 0:
        return parent_rc
    return 0


if __name__ == "__main__":
    sys.exit(main())
