"""Minimal HLS helpers for Kick VODs.

The static ffmpeg build used on CI cannot resolve DNS reliably, so all network
access happens here in Python; ffmpeg only ever reads local files.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

from curl_cffi import requests as cffi_requests

SESSION = cffi_requests.Session(impersonate="chrome")


@dataclass
class Variant:
    url: str
    bandwidth: int
    resolution: str


@dataclass
class Segment:
    url: str
    start: float
    duration: float


def resolve_playlist(vod_url: str) -> str:
    """Use yt-dlp to turn a Kick VOD page URL into its master m3u8 URL."""
    cmd = ["yt-dlp", "--impersonate", "chrome", "-g", "-f", "best", vod_url]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise RuntimeError(f"yt-dlp could not resolve the VOD:\n{proc.stderr[-1000:]}")
    return proc.stdout.strip().splitlines()[0]


def _get_text(url: str) -> str:
    resp = SESSION.get(url, timeout=60)
    resp.raise_for_status()
    return resp.text


def list_variants(playlist_url: str) -> list[Variant]:
    """Return renditions of a master playlist; a media playlist yields itself."""
    text = _get_text(playlist_url)
    if "#EXT-X-STREAM-INF" not in text:
        return [Variant(playlist_url, 0, "single")]
    variants: list[Variant] = []
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith("#EXT-X-STREAM-INF"):
            continue
        attrs = dict(
            part.split("=", 1) for part in line.split(":", 1)[1].split(",") if "=" in part
        )
        uri = lines[i + 1].strip()
        variants.append(
            Variant(
                url=urljoin(playlist_url, uri),
                bandwidth=int(attrs.get("BANDWIDTH", "0")),
                resolution=attrs.get("RESOLUTION", "?"),
            )
        )
    return sorted(variants, key=lambda v: v.bandwidth)


def list_segments(media_url: str) -> list[Segment]:
    text = _get_text(media_url)
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


def download_range(segments: list[Segment], start: float, end: float, out_ts: Path) -> float:
    """Download segments overlapping [start, end) into one .ts file.

    Returns the timestamp (seconds into the VOD) where the file begins.
    """
    chosen = [s for s in segments if s.start + s.duration > start and s.start < end]
    if not chosen:
        raise ValueError("requested range is outside the VOD")
    out_ts.parent.mkdir(parents=True, exist_ok=True)
    with out_ts.open("wb") as fh:
        for seg in chosen:
            resp = SESSION.get(seg.url, timeout=120)
            resp.raise_for_status()
            fh.write(resp.content)
    return chosen[0].start
