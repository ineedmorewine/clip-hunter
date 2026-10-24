"""Publish a finished VOD folder as a GitHub Release so the website can play it.

Videos are release assets (free, no repo bloat). The release body carries a
machine-readable JSON block that the site reads through the GitHub API.

Usage: python scripts/publish.py <folder> [<folder> ...]
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

MARK = "<!-- clip-hunter:"


def describe(folder: Path) -> dict:
    report = (folder / "klipler.md").read_text(encoding="utf-8")
    title = report.splitlines()[0].removeprefix("# Klipler — ").strip()
    date = re.search(r"\d{4}-\d{2}-\d{2}", folder.name)
    clips = json.loads((folder / "klipler.json").read_text(encoding="utf-8"))
    montage = []
    mfile = folder / "fragman.json"
    if mfile.exists():
        montage = json.loads(mfile.read_text(encoding="utf-8"))
    return {
        "title": re.sub(r"\s*\(\d{4}-\d{2}-\d{2}\)$", "", title),
        "date": date.group(0) if date else "",
        "clips": [{k: c[k] for k in ("no", "file", "start_ts", "end_ts", "score", "why", "quote", "verified")
                   if k in c} | {"seconds": round(c["end"] - c["start"])} for c in clips],
        "montage": montage,
        "has_montage": (folder / "fragman.mp4").exists(),
    }


def tag_for(folder: Path) -> str:
    return "vod-" + re.sub(r"[^a-z0-9-]+", "-", folder.name.removeprefix("test_").lower())[:80]


def publish(folder: Path) -> str | None:
    if not (folder / "klipler.json").exists():
        return None
    meta = describe(folder)
    if not meta["clips"] and not meta["has_montage"]:
        return None
    tag = tag_for(folder)
    body = (f"**{meta['title']}** · {meta['date']} · {len(meta['clips'])} klip"
            f"{' + fragman' if meta['has_montage'] else ''}\n\n"
            f"{MARK}{json.dumps(meta, ensure_ascii=False)} -->\n")
    notes = folder / "release_notes.md"
    notes.write_text(body, encoding="utf-8")
    files = sorted(str(p) for p in (folder / "klipler").glob("*.mp4"))
    if meta["has_montage"]:
        files.append(str(folder / "fragman.mp4"))
    # Replace an earlier release of the same VOD (e.g. a re-run with a better prompt).
    subprocess.run(["gh", "release", "delete", tag, "--yes", "--cleanup-tag"],
                   capture_output=True, text=True)
    proc = subprocess.run(
        ["gh", "release", "create", tag, *files, "--title", f"{meta['date']} · {meta['title']}",
         "--notes-file", str(notes), "--latest=false"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        print(f"publish failed for {folder.name}: {proc.stderr[-500:]}")
        return None
    print(f"published {tag} ({len(files)} videos)")
    return tag


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        publish(Path(arg))
