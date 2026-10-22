"""clip-hunter: find funny moments in a Kick VOD and render vertical clips.

Pipeline
1. Resolve the VOD renditions with yt-dlp.
2. Download the lowest rendition and extract mono audio.
3. Compute a per-second loudness curve; spikes become hints for the model.
4. Pass 1: Gemini listens to ~20 min audio chunks and proposes moments.
5. Pass 2: Gemini watches a low-res window around each candidate, confirms it
   and tightens the boundaries.
6. Render the best moments from the highest rendition as 1080x1920 clips
   with a blurred background, plus a list with VOD timestamps.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

from pydantic import BaseModel

from gemini_client import Gemini, QuotaExhausted
from kick_hls import download_range, list_renditions, list_segments

ROOT = Path(__file__).resolve().parent.parent
WORK = Path("work")
OUT = Path("output")
CACHE = Path("cache")  # persisted between runs by actions/cache, keyed by VOD

CHUNK_SECONDS = 40 * 60  # fewer, longer requests stay inside free-tier daily quotas
CHUNK_OVERLAP = 60
MIN_CLIP, MAX_CLIP = 10.0, 120.0
VERIFY_PAD = 20.0  # seconds of context around a candidate for pass 2


# ---------- schemas returned by the model ----------

class Moment(BaseModel):
    start: str
    end: str
    hook: int
    payoff: int
    standalone: int
    score: int
    why: str
    quote: str


class Moments(BaseModel):
    moments: list[Moment]


class Verdict(BaseModel):
    keep: bool
    start: str
    end: str
    score: int
    why: str


@dataclass
class Candidate:
    start: float  # seconds into the VOD
    end: float
    score: int
    why: str
    quote: str
    verified: bool = False


# ---------- helpers ----------

def run(cmd: list[str], timeout: int = 3600) -> str:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd[:3])}...\n{proc.stderr[-1500:]}")
    return proc.stderr


def parse_ts(value: str) -> float:
    """Parse 'MM:SS', 'H:MM:SS' or plain seconds."""
    value = value.strip()
    if re.fullmatch(r"\d+(\.\d+)?", value):
        return float(value)
    parts = [float(p) for p in value.split(":")]
    total = 0.0
    for p in parts:
        total = total * 60 + p
    return total


def fmt_ts(seconds: float) -> str:
    seconds = int(round(seconds))
    return f"{seconds // 3600:d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def media_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return float(out or 0)


def loudness_curve(audio: Path) -> list[float]:
    """Per-second RMS level in dB."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(audio), "-af",
         "asetnsamples=16000,astats=metadata=1:reset=1,"
         "ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
         "-f", "null", "-"],
        capture_output=True, text=True,
    )
    levels = []
    for line in proc.stdout.splitlines():
        if "RMS_level=" in line:
            raw = line.split("=", 1)[1]
            levels.append(-90.0 if raw in ("-inf", "inf", "nan") else max(float(raw), -90.0))
    return levels


def loud_spikes(levels: list[float], start: int, end: int) -> list[int]:
    """Seconds (relative to `start`) where loudness jumps well above the local norm."""
    window = levels[start:end]
    if len(window) < 30:
        return []
    voiced = [v for v in window if v > -60]
    if not voiced:
        return []
    mean = sum(voiced) / len(voiced)
    std = math.sqrt(sum((v - mean) ** 2 for v in voiced) / len(voiced)) or 1.0
    spikes, last = [], -100
    for i, v in enumerate(window):
        if v > mean + 2.0 * std and i - last > 20:
            spikes.append(i)
            last = i
    return spikes[:40]


def overlap(a: Candidate, b: Candidate) -> float:
    inter = max(0.0, min(a.end, b.end) - max(a.start, b.start))
    union = max(a.end, b.end) - min(a.start, b.start)
    return inter / union if union else 0.0


def dedupe(cands: list[Candidate]) -> list[Candidate]:
    kept: list[Candidate] = []
    for c in sorted(cands, key=lambda c: c.score, reverse=True):
        if all(overlap(c, k) < 0.3 for k in kept):
            kept.append(c)
    return kept


def clamp(c: Candidate, duration: float) -> Candidate:
    c.start = max(0.0, c.start - 2.0)  # small lead-in so the first word is not clipped
    c.end = min(duration, c.end + 1.5)
    if c.end - c.start < MIN_CLIP:
        c.end = min(duration, c.start + MIN_CLIP)
    if c.end - c.start > MAX_CLIP:
        c.end = c.start + MAX_CLIP
    return c


# ---------- pipeline steps ----------

def find_candidates(gem: Gemini, audio: Path, levels: list[float], duration: float) -> tuple[list[Candidate], bool]:
    template = (ROOT / "prompts" / "find_moments.md").read_text(encoding="utf-8")
    cands: list[Candidate] = []
    complete = True
    starts = list(range(0, max(1, int(duration)), CHUNK_SECONDS - CHUNK_OVERLAP))
    for n, offset in enumerate(starts, 1):
        length = min(CHUNK_SECONDS, duration - offset)
        if length < 30:
            continue
        cache_file = CACHE / f"p1_{int(offset)}_{int(length)}.json"
        print(f"Pass 1 · chunk {n}/{len(starts)} ({fmt_ts(offset)} – {fmt_ts(offset + length)})")
        if cache_file.exists():
            moments = [Moment(**m) for m in json.loads(cache_file.read_text(encoding="utf-8"))]
            print("   (from cache)")
        else:
            try:
                moments = _ask_chunk(gem, template, audio, levels, n, offset, length)
            except QuotaExhausted:
                print("   ! Gemini daily quota is used up; remaining chunks will be done on the next run")
                return cands, False
            except Exception as exc:
                print(f"   ! chunk skipped: {exc}")
                complete = False
                continue
            cache_file.write_text(json.dumps([m.model_dump() for m in moments], ensure_ascii=False), encoding="utf-8")
        for m in moments:
            try:
                s, e = parse_ts(m.start) + offset, parse_ts(m.end) + offset
            except ValueError:
                continue
            if e <= s:
                continue
            cands.append(Candidate(s, e, int(m.score), m.why, m.quote))
            print(f"   + {fmt_ts(s)} ({m.score}/10) {m.why[:90]}")
    return cands, complete


def _ask_chunk(gem: Gemini, template: str, audio: Path, levels: list[float],
               n: int, offset: float, length: float) -> list[Moment]:
        chunk = WORK / f"chunk_{n:02d}.mp3"
        run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(offset), "-i", str(audio),
             "-t", str(length), "-ac", "1", "-ar", "16000", "-b:a", "32k", str(chunk)])
        hints = loud_spikes(levels, int(offset), int(offset + length))
        prompt = template.replace("{loud_hints}", ", ".join(fmt_ts(h)[2:] for h in hints) or "yok")
        f = gem.upload(chunk, "audio/mpeg")
        try:
            result: Moments = gem.ask([f, prompt], Moments)
        finally:
            gem.delete(f)
            chunk.unlink(missing_ok=True)
        return result.moments


def verify(gem: Gemini, v_segments, c: Candidate, duration: float) -> Candidate | None:
    template = (ROOT / "prompts" / "verify_moment.md").read_text(encoding="utf-8")
    w_start = max(0.0, c.start - VERIFY_PAD)
    w_end = min(duration, c.end + VERIFY_PAD)
    cache_file = CACHE / f"p2_{int(c.start)}_{int(c.end)}.json"
    if cache_file.exists():
        v = Verdict(**json.loads(cache_file.read_text(encoding="utf-8")))
        return _apply_verdict(v, c, w_start)
    src = WORK / f"verify_{int(c.start)}.ts"
    src_start = download_range(v_segments, w_start, w_end, src)
    clip = WORK / f"verify_{int(c.start)}.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{w_start - src_start:.2f}", "-i", str(src),
         "-t", str(w_end - w_start), "-vf", "scale=-2:360,fps=2", "-c:v", "libx264", "-preset", "veryfast",
         "-crf", "32", "-ac", "1", "-c:a", "aac", "-b:a", "48k", str(clip)])
    prompt = (template.replace("{start}", fmt_ts(c.start - w_start)[2:])
              .replace("{end}", fmt_ts(c.end - w_start)[2:]).replace("{why}", c.why))
    f = gem.upload(clip, "video/mp4")
    try:
        v: Verdict = gem.ask([f, prompt], Verdict, temperature=0.2)
    finally:
        gem.delete(f)
        clip.unlink(missing_ok=True)
        src.unlink(missing_ok=True)
    cache_file.write_text(v.model_dump_json(), encoding="utf-8")
    return _apply_verdict(v, c, w_start)


def _apply_verdict(v: Verdict, c: Candidate, w_start: float) -> Candidate | None:
    if not v.keep:
        return None
    try:
        s, e = parse_ts(v.start) + w_start, parse_ts(v.end) + w_start
    except ValueError:
        s, e = c.start, c.end
    if e <= s:
        s, e = c.start, c.end
    return Candidate(s, e, int(v.score), v.why or c.why, c.quote, verified=True)


def render(segments, c: Candidate, index: int) -> Path:
    src = WORK / f"src_{index:02d}.ts"
    file_start = download_range(segments, c.start - 2, c.end + 2, src)
    out = OUT / "klipler" / f"{index:02d}_{fmt_ts(c.start).replace(':', '-')}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    vf = (
        "[0:v]split=2[a][b];"
        "[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
        "boxblur=25:3,eq=brightness=-0.08[bg];"
        "[b]scale=1080:-2[fg];"
        "[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[v]"
    )
    run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{c.start - file_start:.2f}",
         "-i", str(src), "-t", f"{c.end - c.start:.2f}", "-filter_complex", vf,
         "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
         "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)])
    src.unlink(missing_ok=True)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("vod_url")
    ap.add_argument("--max-clips", type=int, default=15)
    ap.add_argument("--min-score", type=int, default=6)
    args = ap.parse_args()

    for d in (WORK, OUT, CACHE):
        d.mkdir(exist_ok=True)

    title, renditions = list_renditions(args.vod_url)
    print("Renditions: " + ", ".join(f"{r.height}p/{r.tbr:.0f}k" for r in renditions))
    # Unknown-height entries sort first but may be the full-quality source; pick by bitrate instead.
    known = [r for r in renditions if r.height] or renditions
    low = min(renditions, key=lambda r: r.tbr or 1e9)
    high = known[-1]
    for r in known:
        if r.height and r.height <= 1080:
            high = r  # sorted ascending, so this ends on the best <=1080p
    verify_rend = next((r for r in known if r.height >= 360), known[-1])
    print(f"VOD: {title}\nAnalysis: {low.height}p · Check: {verify_rend.height}p · Clips: {high.height}p")

    low_segments = list_segments(low.url)
    duration = sum(s.duration for s in low_segments)
    print(f"Length: {fmt_ts(duration)} · downloading analysis copy…")
    low_ts = WORK / "low.ts"
    download_range(low_segments, 0, duration, low_ts)

    audio = WORK / "audio.m4a"
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(low_ts), "-vn", "-ac", "1",
         "-ar", "16000", "-c:a", "aac", "-b:a", "48k", str(audio)])
    levels = loudness_curve(audio)

    gem = Gemini()
    found, complete = find_candidates(gem, audio, levels, duration)
    cands = dedupe(found)
    cands = [c for c in cands if c.score >= args.min_score - 1]
    cands = sorted(cands, key=lambda c: c.score, reverse=True)[: args.max_clips + 5]
    print(f"\nPass 2 · checking {len(cands)} candidates by watching them")

    v_segments = list_segments(verify_rend.url)
    final: list[Candidate] = []
    can_verify = True
    for c in cands:
        v = c  # keep the pass-1 result if checking is unavailable
        if can_verify:
            try:
                v = verify(gem, v_segments, c, duration)
            except QuotaExhausted:
                print("   ! Gemini daily quota is used up; remaining candidates kept unchecked")
                can_verify = False
            except Exception as exc:
                print(f"   ! check failed at {fmt_ts(c.start)}: {exc}")
        if v and v.score >= args.min_score:
            final.append(v)
            print(f"   ✓ {fmt_ts(v.start)} ({v.score}/10)")
        else:
            print(f"   ✗ {fmt_ts(c.start)} dropped")

    final = sorted(dedupe(final), key=lambda c: c.score, reverse=True)[: args.max_clips]
    final = [clamp(c, duration) for c in sorted(final, key=lambda c: c.start)]

    high_segments = low_segments if high.url == low.url else list_segments(high.url)
    rows = []
    for i, c in enumerate(final, 1):
        print(f"Rendering clip {i}/{len(final)} at {fmt_ts(c.start)}")
        path = render(high_segments, c, i)
        rows.append({"no": i, "file": path.name, **asdict(c),
                     "start_ts": fmt_ts(c.start), "end_ts": fmt_ts(c.end)})

    write_report(args.vod_url, title, rows, complete)
    return 0


def write_report(vod_url: str, title: str, rows: list[dict], complete: bool = True) -> None:
    lines = [f"# Klipler — {title or 'Kick yayını'}", "", f"Yayın: {vod_url}", "",
             "| # | Dosya | Yayındaki yer | Süre | Puan | Kontrol | Neden |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        dur = int(r["end"] - r["start"])
        why = r["why"].replace("|", "/").replace("\n", " ")
        lines.append(f"| {r['no']} | {r['file']} | {r['start_ts']} – {r['end_ts']} | {dur} sn | {r['score']}/10 | {'✓' if r['verified'] else '·'} | {why} |")
    if not rows and complete:
        lines.append("\nBu yayında yeterince güçlü an bulunamadı.")
    if not complete:
        lines.append("\n⚠️ Gemini'nin günlük ücretsiz kotası dolduğu için yayının bir kısmı dinlenemedi. "
                     "Yarın aynı linkle tekrar çalıştır; dinlenen kısımlar hatırlanır, sadece kalan kısım işlenir.")
    lines.append("\n✓ = izlenerek kontrol edildi, · = sadece dinlendi")
    text = "\n".join(lines) + "\n"
    (OUT / "klipler.md").write_text(text, encoding="utf-8")
    (OUT / "klipler.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + text)


if __name__ == "__main__":
    raise SystemExit(main())
