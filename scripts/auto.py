"""Entry point for the workflow.

Manual mode  (VOD_URL set): process that one VOD.
Automatic mode (VOD_URL empty): find new VODs on the Kick channel and process
them oldest first until Gemini's daily quota runs out. Each finished VOD gets
a GitHub issue (so the owner is notified) and is recorded in state/.
"""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from curl_cffi import requests as cffi_requests

from clip_hunter import fmt_ts, process
from gemini_client import Gemini
from publish import publish

CHANNEL = os.environ.get("KICK_CHANNEL") or "lunverra"
STATE = Path("state/processed.json")
OUTPUT = Path("output")
CACHE = Path("cache")
BACKLOG_DAYS = 7      # on the very first automatic run, also clip the last week
MIN_VOD_SECONDS = 600  # skip test/aborted streams shorter than 10 minutes


def slugify(text: str) -> str:
    table = str.maketrans("çğıöşüÇĞİÖŞÜ", "cgiosuCGIOSU")
    return re.sub(r"[^a-z0-9]+", "-", text.translate(table).lower()).strip("-")[:50] or "yayin"


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    since = (datetime.now(timezone.utc) - timedelta(days=BACKLOG_DAYS)).isoformat()
    return {"since": since, "done": []}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")


def channel_vods() -> list[dict]:
    resp = cffi_requests.get(f"https://kick.com/api/v2/channels/{CHANNEL}/videos",
                             impersonate="chrome", timeout=30)
    resp.raise_for_status()
    data = resp.json()
    items = data if isinstance(data, list) else data.get("data") or []
    vods = []
    for it in items:
        if it.get("is_live") or not it.get("source"):
            continue
        created = (it.get("created_at") or it.get("start_time") or "").replace(" ", "T")
        if created and "+" not in created and not created.endswith("Z"):
            created += "+00:00"  # Kick returns UTC without a zone
        vods.append({
            "id": str(it.get("id")),
            "title": (it.get("session_title") or "").strip(),
            "created": created,
            "seconds": (it.get("duration") or 0) / 1000,
            "source": it["source"],
        })
    return sorted(vods, key=lambda v: v["created"])


def create_issue(title: str, body: str) -> None:
    token, repo = os.environ.get("GITHUB_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        return
    resp = cffi_requests.post(
        f"https://api.github.com/repos/{repo}/issues",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "User-Agent": "clip-hunter", "X-GitHub-Api-Version": "2022-11-28"},
        json={"title": title, "body": body}, timeout=30,
    )
    print(f"issue: HTTP {resp.status_code} {resp.text[:200] if resp.status_code >= 300 else ''}")


def run_link() -> str:
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    return f"{server}/{os.environ.get('GITHUB_REPOSITORY', '')}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"


def site_link() -> str:
    owner, _, name = (os.environ.get("GITHUB_REPOSITORY") or "ineedmorewine/clip-hunter").partition("/")
    return f"https://{owner}.github.io/{name}/"


def deliver(folder: Path, title: str) -> None:
    tag = publish(folder)
    report = (folder / "klipler.md").read_text(encoding="utf-8")
    where = (f"**İzle ve indir:** {site_link()}#{tag}" if tag else
             f"**Klipleri indir:** {run_link()} → **Artifacts → klipler**")
    create_issue(f"🎬 Klipler: {title}", f"{where}\n\n{report}")


def main() -> int:
    try:
        gem = Gemini()
    except Exception as exc:  # no key / API down: still deliver clips from laughter detection
        print(f"Gemini not available: {exc}")
        gem = None
    summary: list[str] = []
    vod_url = (os.environ.get("VOD_URL") or "").strip()
    max_clips = int(os.environ.get("MAX_CLIPS") or 20)
    min_score = int(os.environ.get("MIN_SCORE") or 6)

    if vod_url.isdigit():
        # A channel VOD id: test run on that VOD without touching the processed list.
        match = next((v for v in channel_vods() if v["id"] == vod_url), None)
        if not match:
            raise SystemExit(f"VOD id {vod_url} not found on the channel")
        day = match["created"][:10]
        folder = OUTPUT / f"test_{day}_{slugify(match['title'])}_{vod_url}"
        process(match["source"], f"https://kick.com/{CHANNEL}/videos · {day}", f"{match['title']} ({day})",
                folder, CACHE / f"test_{vod_url}", gem, max_clips, min_score)
        publish(folder)
        summary.append((folder / "klipler.md").read_text(encoding="utf-8"))
    elif vod_url:
        # Optional "#YYYY-MM-DD#Title" after the link names the stream on the site.
        url, _, extra = vod_url.partition("#")
        day, _, title = extra.partition("#")
        key = slugify(url)[-40:]
        folder = OUTPUT / f"{day or 'manuel'}_{slugify(title or 'yayin')}_{key[-8:]}"
        complete = process(url, url, title, folder, CACHE / key, gem, max_clips, min_score)
        summary.append((folder / "klipler.md").read_text(encoding="utf-8"))
        if complete:
            deliver(folder, title or "elle verilen yayın")
    else:
        state = load_state()
        todo = [v for v in channel_vods()
                if v["id"] not in state["done"] and v["created"] >= state["since"]]
        print(f"New VODs to process: {len(todo)}")
        for v in todo:
            if v["seconds"] and v["seconds"] < MIN_VOD_SECONDS:
                print(f"skip short VOD {v['title']} ({fmt_ts(v['seconds'])})")
                state["done"].append(v["id"])
                save_state(state)
                continue
            day = v["created"][:10]
            folder = OUTPUT / f"{day}_{slugify(v['title'])}_{v['id']}"
            label = f"{v['title'] or 'Kick yayını'} ({day})"
            link = f"https://kick.com/{CHANNEL}/videos · {day} tarihli yayın"
            complete = process(v["source"], link, label, folder, CACHE / v["id"], gem,
                               max_clips, min_score)
            summary.append((folder / "klipler.md").read_text(encoding="utf-8"))
            if not complete:
                print("Gemini unavailable; this VOD and the rest continue on the next scheduled run.")
                break
            deliver(folder, label)
            state["done"].append(v["id"])
            save_state(state)
        if not todo:
            summary.append("Yeni yayın yok.")
        save_state(state)

    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / "ozet.md").write_text("\n\n".join(summary), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
