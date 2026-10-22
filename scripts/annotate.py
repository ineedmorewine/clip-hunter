"""Publish the clip list (or the tail of the log) as a workflow annotation."""

from pathlib import Path


def escape(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "").replace("\n", "%0A")


report = Path("output/klipler.md")
log = Path("run.log")
if report.exists():
    body = report.read_text(encoding="utf-8")
elif log.exists():
    body = "RUN FAILED\n" + log.read_text(encoding="utf-8")[-3000:]
else:
    body = "RUN FAILED (no log)"
print("::notice title=clip-hunter::" + escape(body[-3800:]))
if log.exists():
    print("::notice title=log-tail::" + escape(log.read_text(encoding="utf-8")[-3800:]))
