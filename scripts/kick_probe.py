"""Feasibility probe: can a GitHub Actions runner fetch a Kick VOD?

Resolves the VOD playlist, lists renditions, downloads the first 60 seconds
of the lowest rendition and extracts audio from it with ffmpeg.
"""

import subprocess
import sys
from pathlib import Path

from kick_hls import download_range, list_segments, list_variants, resolve_playlist

OUT_DIR = Path("probe_out")


def main() -> int:
    vod_url = sys.argv[1].strip()
    print(f"VOD URL: {vod_url}")

    master = resolve_playlist(vod_url)
    print("Playlist resolved: yes")

    variants = list_variants(master)
    print("Renditions: " + ", ".join(f"{v.resolution}@{v.bandwidth // 1000}kbps" for v in variants))

    segments = list_segments(variants[0].url)
    total = sum(s.duration for s in segments)
    print(f"Segments: {len(segments)}, total length: {total / 60:.1f} min")

    ts_file = OUT_DIR / "sample.ts"
    download_range(segments, 0, 60, ts_file)
    print(f"Downloaded sample: {ts_file.stat().st_size // 1024} KB")

    audio = OUT_DIR / "sample.m4a"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(ts_file), "-vn",
         "-c:a", "aac", "-b:a", "64k", str(audio)],
        capture_output=True, text=True, timeout=120,
    )
    ok = proc.returncode == 0 and audio.exists() and audio.stat().st_size > 20_000
    print(f"ffmpeg rc={proc.returncode} audio={audio.stat().st_size // 1024 if audio.exists() else 0} KB {proc.stderr[-300:]}")
    print("RESULT: " + ("OK - Kick VOD is reachable from GitHub." if ok else "FAIL - audio extraction failed."))
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"RESULT: FAIL - {exc}")
        sys.exit(1)
