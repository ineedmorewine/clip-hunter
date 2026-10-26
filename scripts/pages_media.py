"""Copy the newest streams' videos into the Pages site so the editor can load them same-origin.

Release assets have no CORS headers, so a canvas that draws them can't be recorded.
Files served from GitHub Pages can. Pages sites are limited to ~1 GB, so only the newest
streams that fit in BUDGET_MB are copied; older ones still work through download + upload.

Writes docs/media/<tag>/<file> and docs/media/index.json ({"tags": [...]}).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

BUDGET_MB = 880
DOCS = Path(__file__).resolve().parent.parent / "docs"


def main() -> None:
    out = subprocess.run(["gh", "api", "repos/{owner}/{repo}/releases?per_page=50"],
                         capture_output=True, text=True, check=True)
    releases = sorted(json.loads(out.stdout), key=lambda r: r["created_at"], reverse=True)
    releases.sort(key=lambda r: r["tag_name"], reverse=True)  # tag starts with the stream date
    used, tags = 0, []
    for rel in releases:
        size = sum(a["size"] for a in rel["assets"] if a["name"].endswith(".mp4"))
        if used + size > BUDGET_MB * 1024 * 1024:
            continue
        dest = DOCS / "media" / rel["tag_name"]
        dest.mkdir(parents=True, exist_ok=True)
        subprocess.run(["gh", "release", "download", rel["tag_name"], "-p", "*.mp4", "-D", str(dest), "--clobber"],
                       check=True)
        used += size
        tags.append(rel["tag_name"])
        print(f"media: {rel['tag_name']} ({size // 1048576} MB)")
    (DOCS / "media" / "index.json").write_text(json.dumps({"tags": tags}), encoding="utf-8")
    print(f"media total: {used // 1048576} MB in {len(tags)} streams")


if __name__ == "__main__":
    main()
