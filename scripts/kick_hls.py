"""Minimal HLS helpers for Kick VODs.

The static ffmpeg build used on CI cannot resolve DNS reliably, so all network
access happens here in Python; ffmpeg only ever reads local files.
"""

from __future__ import annotations

import json
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

from curl_cffi import requests as cffi_requests

SESSION = cffi_requests.Session(impersonate="chrome")


@dataclass
class Rendition:
    url: str
    height: int
    tbr: float


@dataclass
class Segment:
    url: str
    start: float
    duration: float


def list_renditions(vod_url: str) -> tuple[str, list[Rendition]]:
    """Ask yt-dlp for the VOD title and its HLS renditions (sorted low -> high)."""
    cmd = ["yt-dlp", "--impersonate", "chrome", "-J", vod_url]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"yt-dlp could not read the VOD:\n{proc.stderr[-1000:]}")
    info = json.loads(proc.stdout)
    renditions = []
    for fmt in info.get("formats", []):
        url = fmt.get("url") or ""
        if "m3u8" not in (fmt.get("protocol") or "") and ".m3u8" not in url:
            continue
        renditions.append(
            Rendition(url=url, height=int(fmt.get("height") or 0), tbr=float(fmt.get("tbr") or 0))
        )
    if not renditions:
        raise RuntimeError("no HLS renditions found for this VOD")
    renditions.sort(key=lambda r: (r.height, r.tbr))
    return info.get("title") or "", renditions


def _get(url: str, timeout: int = 120) -> bytes:
    last_exc: Exception | None = None
    for _ in range(4):
        try:
            resp = SESSION.get(url, timeout=timeout)
            resp.raise_for_status()
            return resp.content
        except Exception as exc:  # retry transient CDN errors
            last_exc = exc
    raise RuntimeError(f"download failed: {url}") from last_exc


def _media_playlist(url: str) -> tuple[str, str]:
    """Follow a master playlist to its first media playlist if needed."""
    text = _get(url, 60).decode("utf-8", "replace")
    if "#EXT-X-STREAM-INF" in text:
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if line.startswith("#EXT-X-STREAM-INF"):
                url = urljoin(url, lines[i + 1].strip())
                text = _get(url, 60).decode("utf-8", "replace")
                break
    return url, text


def list_segments(playlist_url: str) -> list[Segment]:
    media_url, text = _media_playlist(playlist_url)
    segments: list[Segment] = []
    clock = 0.0
    pending: float | None = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF:"):
            pending = float(line.split(":", 1)[1].split(",")[0])
        elif line and not line.startswith("#") and pending is not None:
            segments.append(Segment(urljoin(media_url, line), clock, pending))
            clock += pending
            pending = None
    return segments


def download_range(
    segments: list[Segment], start: float, end: float, out_ts: Path, workers: int = 8
) -> float:
    """Download segments overlapping [start, end) into one .ts file.

    Returns the timestamp (seconds into the VOD) where the file begins.
    """
    chosen = [s for s in segments if s.start + s.duration > start and s.start < end]
    if not chosen:
        raise ValueError("requested range is outside the VOD")
    out_ts.parent.mkdir(parents=True, exist_ok=True)
    batch = workers * 4  # bound memory: only a few dozen segments in flight
    with ThreadPoolExecutor(max_workers=workers) as pool, out_ts.open("wb") as fh:
        for i in range(0, len(chosen), batch):
            for data in pool.map(lambda s: _get(s.url), chosen[i : i + batch]):
                fh.write(data)
    return chosen[0].start
