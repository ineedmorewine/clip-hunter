"""Feasibility probe: can a GitHub Actions runner fetch a Kick VOD?

Tries several ways to resolve a Kick VOD page URL to an HLS (m3u8) playlist,
then downloads the first 60 seconds of audio to prove the stream is reachable.
Prints a short report and exits non-zero if every method fails.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

from curl_cffi import requests as cffi_requests

UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
OUT_DIR = Path("probe_out")


def extract_uuid(url: str) -> str | None:
    match = UUID_RE.search(url)
    return match.group(0) if match else None


def try_api(uuid: str) -> tuple[str | None, str]:
    """Ask Kick's JSON API (with browser impersonation) for the playback source."""
    endpoints = [
        f"https://kick.com/api/v1/video/{uuid}",
        f"https://kick.com/api/v2/video/{uuid}",
    ]
    notes = []
    for endpoint in endpoints:
        try:
            resp = cffi_requests.get(endpoint, impersonate="chrome", timeout=30)
        except Exception as exc:  # network-level failure
            notes.append(f"{endpoint}: error {exc!r}")
            continue
        notes.append(f"{endpoint}: HTTP {resp.status_code}")
        if resp.status_code != 200:
            continue
        try:
            data = resp.json()
        except json.JSONDecodeError:
            notes.append("  body is not JSON (Cloudflare page?)")
            continue
        source = data.get("source") or (data.get("livestream") or {}).get("source")
        if source:
            duration = (data.get("livestream") or {}).get("duration")
            title = (data.get("livestream") or {}).get("session_title")
            notes.append(f"  source found; title={title!r} duration_ms={duration}")
            return source, "\n".join(notes)
        notes.append(f"  JSON keys: {sorted(data.keys())[:20]}")
    return None, "\n".join(notes)


def try_ytdlp(url: str) -> tuple[str | None, str]:
    """Ask yt-dlp (with impersonation) for the direct stream URL."""
    cmd = ["yt-dlp", "--impersonate", "chrome", "-g", "-f", "bestaudio/best", url]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode == 0 and proc.stdout.strip():
        return proc.stdout.strip().splitlines()[0], "yt-dlp: OK"
    return None, f"yt-dlp: failed\n{proc.stderr.strip()[-800:]}"


def grab_audio(m3u8: str) -> tuple[bool, str]:
    """Download 60 s of audio from the playlist to confirm segments are reachable."""
    OUT_DIR.mkdir(exist_ok=True)
    target = OUT_DIR / "sample.m4a"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        "-i", m3u8, "-t", "60", "-vn", "-c:a", "aac", "-b:a", "96k", str(target),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    ok = proc.returncode == 0 and target.exists() and target.stat().st_size > 50_000
    size = target.stat().st_size if target.exists() else 0
    return ok, f"ffmpeg: rc={proc.returncode} size={size} bytes {proc.stderr.strip()[-400:]}"


def main() -> int:
    url = sys.argv[1].strip()
    uuid = extract_uuid(url)
    print(f"VOD URL: {url}\nUUID: {uuid}\n")

    report = []
    m3u8 = None
    if uuid:
        m3u8, note = try_api(uuid)
        report.append("[1] Kick API\n" + note)
    if not m3u8:
        m3u8, note = try_ytdlp(url)
        report.append("[2] yt-dlp\n" + note)

    print("\n\n".join(report))
    if not m3u8:
        print("\nRESULT: FAIL - no method could resolve the VOD playlist.")
        return 1

    print(f"\nPlaylist: {m3u8[:120]}...")
    ok, note = grab_audio(m3u8)
    print(note)
    print("\nRESULT: " + ("OK - audio sample downloaded." if ok else "FAIL - playlist found but download failed."))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
