"""List a Kick channel's VODs and print the ones not processed yet.

Prints one VOD URL per line, oldest first. State lives in state/processed.json.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests as cffi_requests

STATE = Path("state/processed.json")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {"since": None, "done": []}


def from_api(channel: str) -> list[tuple[str, str]]:
    """Return (created_at, uuid) pairs from Kick's channel video API."""
    session = cffi_requests.Session(impersonate="chrome")
    for url in (f"https://kick.com/api/v2/channels/{channel}/videos",
                f"https://kick.com/api/v1/channels/{channel}/videos"):
        try:
            resp = session.get(url, timeout=30)
        except Exception as exc:
            print(f"# {url}: {exc}")
            continue
        print(f"# {url}: HTTP {resp.status_code}")
        if resp.status_code != 200:
            continue
        try:
            data = resp.json()
        except ValueError:
            continue
        items = data if isinstance(data, list) else data.get("data") or data.get("videos") or []
        out = []
        for item in items:
            video = item.get("video") or {}
            uuid = video.get("uuid") or item.get("uuid")
            created = item.get("created_at") or item.get("start_time") or ""
            if uuid and not item.get("is_live"):
                out.append((created, uuid))
        if out:
            return out
    return []


def from_ytdlp(channel: str) -> list[tuple[str, str]]:
    """Fallback: let yt-dlp enumerate the channel's videos page."""
    proc = subprocess.run(
        ["yt-dlp", "--impersonate", "chrome", "--flat-playlist", "--print", "%(id)s",
         f"https://kick.com/{channel}/videos"],
        capture_output=True, text=True, timeout=180,
    )
    print(f"# yt-dlp rc={proc.returncode} {proc.stderr.strip()[-300:]}")
    return [("", m.group(0)) for line in proc.stdout.splitlines() if (m := UUID_RE.search(line))]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("channel")
    ap.add_argument("--limit", type=int, default=1)
    args = ap.parse_args()

    state = load_state()
    vods = from_api(args.channel) or from_ytdlp(args.channel)
    print(f"# found {len(vods)} VODs")
    if state["since"] is None:
        # First run: only VODs from now on, so the backlog does not eat the quota.
        state["since"] = datetime.now(timezone.utc).isoformat()
        state["done"] = sorted({u for _, u in vods} | set(state["done"]))
        STATE.parent.mkdir(exist_ok=True)
        STATE.write_text(json.dumps(state, indent=2), encoding="utf-8")
        print("# first run: existing VODs marked as already seen")
        return 0
    todo = [(c, u) for c, u in vods if u not in state["done"]]
    todo.sort()
    for _, uuid in todo[: args.limit]:
        print(f"https://kick.com/{args.channel}/videos/{uuid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
