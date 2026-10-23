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

from gemini_client import ContentBlocked, Gemini, QuotaExhausted
from local_signals import Line, laughter_curve, transcribe
from kick_hls import download_range, list_renditions, list_segments, renditions_from_master

ROOT = Path(__file__).resolve().parent.parent
WORK = Path("work")
OUT = Path("output")
CACHE = Path("cache")  # persisted between runs by actions/cache, keyed by VOD

CHUNK_SECONDS = 40 * 60  # fewer, longer requests stay inside free-tier daily quotas
CHUNK_OVERLAP = 60
MIN_CLIP, MAX_CLIP = 10.0, 120.0
VERIFY_PAD = 20.0  # seconds of context around a candidate for pass 2
SKIPPED: list[str] = []  # time ranges that could not be analysed in this run


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


class Micro(BaseModel):
    start: str
    end: str
    why: str


class Analysis(BaseModel):
    moments: list[Moment]
    montage: list[Micro]


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



# ---------- quota-free analysis ----------

LAUGH_ON, SHOUT_ON = 0.35, 0.5


def annotated_transcript(lines: list[Line], laugh: list[float], shout: list[float],
                         levels: list[float]) -> str:
    spikes = set(loud_spikes(levels, 0, len(levels)))
    out = []
    for ln in lines:
        secs = range(int(ln.start), int(ln.end) + 2)
        tags = []
        if any(laugh[s] > LAUGH_ON for s in secs if s < len(laugh)):
            tags.append("[KAHKAHA]")
        if any(shout[s] > SHOUT_ON for s in secs if s < len(shout)):
            tags.append("[BAĞIRMA]")
        if any(s in spikes for s in secs):
            tags.append("[SES↑]")
        out.append(f"[{fmt_ts(ln.start)}] {ln.text} {' '.join(tags)}".rstrip())
    return "\n".join(out)


def text_candidates(gem: Gemini, lines: list[Line], laugh, shout, levels,
                    duration: float) -> tuple[list[Candidate], list[Candidate]]:
    """One text-only Gemini request per VOD: story clips + montage snippets. Cached."""
    if gem is None:
        raise RuntimeError("Gemini is not configured")
    cache_file = CACHE / "analysis_v2.json"
    if cache_file.exists():
        analysis = Analysis(**json.loads(cache_file.read_text(encoding="utf-8")))
        print("AI analysis: from cache")
    else:
        hours = max(duration / 3600, 0.25)
        template = (ROOT / "prompts" / "find_moments_text.md").read_text(encoding="utf-8")
        template = (template.replace("{clip_target}", f"{round(hours * 8)}–{round(hours * 10)}")
                    .replace("{duration}", fmt_ts(duration)))
        text = annotated_transcript(lines, laugh, shout, levels)
        parts = [text]
        if len(text) > 300_000:  # very long VODs: two requests
            mid = text.rfind("\n", 0, len(text) // 2)
            parts = [text[:mid], text[mid:]]
        analysis = Analysis(moments=[], montage=[])
        for part in parts:
            print(f"Asking Gemini about {len(part) // 1000}k characters of transcript")
            result: Analysis = gem.ask([template.replace("{transcript}", part)], Analysis)
            analysis.moments += result.moments
            analysis.montage += result.montage
        cache_file.write_text(analysis.model_dump_json(), encoding="utf-8")

    def to_cands(items, scored: bool) -> list[Candidate]:
        out = []
        for m in items:
            try:
                s, e = parse_ts(m.start), parse_ts(m.end)
            except ValueError:
                continue
            if e > s:
                out.append(Candidate(s, e, int(m.score) if scored else 0, m.why,
                                     getattr(m, "quote", "")))
        return out

    cands, micros = to_cands(analysis.moments, True), to_cands(analysis.montage, False)
    for c in cands:
        print(f"   + {fmt_ts(c.start)} ({c.score}/10) {c.why[:90]}")
    print(f"   montage snippets: {len(micros)}")
    return cands, micros


def laughter_candidates(laugh: list[float], shout: list[float], top: int = 20) -> list[Candidate]:
    """Fallback without any AI: clip the context leading up to each laughter burst."""
    bursts, cur = [], None
    for sec, v in enumerate(laugh):
        hot = v > LAUGH_ON or shout[sec] > SHOUT_ON
        if hot:
            if cur and sec - cur[1] <= 3:
                cur[1] = sec
            else:
                cur = [sec, sec]
                bursts.append(cur)
    scored = []
    for b0, b1 in bursts:
        strength = sum(laugh[b0:b1 + 1]) + 0.5 * sum(shout[b0:b1 + 1])
        if strength >= 1.5:
            scored.append((strength, b0, b1))
    scored.sort(reverse=True)
    cands = []
    for strength, b0, b1 in scored[:top]:
        score = min(9, 5 + int(strength))
        cands.append(Candidate(max(0, b0 - 18), b1 + 3, score, f"Kahkaha/bağırma ({b1 - b0 + 1} sn)", ""))
    print(f"Laughter fallback: {len(cands)} candidates")
    return cands


MONTAGE_MAX = 90.0
MICRO_MIN, MICRO_MAX = 4.0, 13.0


def pick_montage(micros: list[Candidate], duration: float) -> list[Candidate]:
    """Keep the model's priority order until ~90 s, then play them chronologically."""
    chosen, total = [], 0.0
    for m in micros:
        m.start, m.end = max(0.0, m.start - 0.3), min(duration, m.end + 0.5)
        if m.end - m.start < MICRO_MIN:
            m.end = min(duration, m.start + MICRO_MIN)
        if m.end - m.start > MICRO_MAX:
            m.end = m.start + MICRO_MAX
        if any(overlap(m, k) > 0 for k in chosen):
            continue
        if total + (m.end - m.start) > MONTAGE_MAX:
            continue
        chosen.append(m)
        total += m.end - m.start
    return sorted(chosen, key=lambda m: m.start)


def laughter_montage(laugh: list[float], shout: list[float]) -> list[Candidate]:
    return [Candidate(max(0, c.end - 11), c.end, 0, c.why, "") for c in laughter_candidates(laugh, shout, 12)]


def render_montage(segments, micros: list[Candidate]) -> Path | None:
    if not micros:
        return None
    pieces = []
    for i, m in enumerate(micros, 1):
        print(f"Montage piece {i}/{len(micros)} at {fmt_ts(m.start)}")
        pieces.append(render(segments, m, 100 + i, WORK / f"piece_{i:02d}.mp4", fade=True))
    listing = WORK / "pieces.txt"
    listing.write_text("".join(f"file '{p.resolve()}'\n" for p in pieces), encoding="utf-8")
    out = OUT / "fragman.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
         "-c", "copy", "-movflags", "+faststart", str(out)])
    for p in pieces:
        p.unlink(missing_ok=True)
    return out


def snap(c: Candidate, lines: list[Line], duration: float) -> None:
    """Move boundaries to sentence edges so clips don't start or end mid-word."""
    before = [ln.start for ln in lines if ln.start <= c.start + 0.5]
    if before and c.start - before[-1] < 8:
        c.start = before[-1]
    after = [ln.end for ln in lines if ln.end >= c.end - 0.5]
    if after and after[0] - c.end < 6:
        c.end = after[0]
    c.end = min(c.end, duration)

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
            except ContentBlocked:
                # Split so only the part Google refuses is lost, not the whole 40 minutes.
                print("   ! Google blocked this part; retrying in 10-minute pieces")
                moments = []
                for k, sub in enumerate(range(0, int(length), 600)):
                    sub_len = min(600, length - sub)
                    try:
                        for m in _ask_chunk(gem, template, audio, levels, n * 100 + k, offset + sub, sub_len):
                            m.start = fmt_ts(parse_ts(m.start) + sub)
                            m.end = fmt_ts(parse_ts(m.end) + sub)
                            moments.append(m)
                    except ContentBlocked:
                        SKIPPED.append(f"{fmt_ts(offset + sub)} – {fmt_ts(offset + sub + sub_len)} (Google filtresi)")
            except QuotaExhausted:
                print("   ! Gemini daily quota is used up; remaining chunks will be done on the next run")
                return cands, False
            except Exception as exc:
                # A non-quota failure must not block delivery forever; report the gap instead.
                print(f"   ! chunk skipped: {exc}")
                SKIPPED.append(f"{fmt_ts(offset)} – {fmt_ts(offset + length)}")
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


def render(segments, c: Candidate, index: int, out: Path | None = None, fade: bool = False) -> Path:
    src = WORK / f"src_{index:02d}.ts"
    file_start = download_range(segments, c.start - 2, c.end + 2, src)
    out = out or OUT / "klipler" / f"{index:02d}_{fmt_ts(c.start).replace(':', '-')}.mp4"
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
         "-map", "[v]", "-map", "0:a?",
         *(["-af", f"afade=t=in:d=0.08,afade=t=out:st={max(0.0, c.end - c.start - 0.12):.2f}:d=0.12,"
                   "aresample=48000"] if fade else ["-ar", "48000"]),
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
         "-r", "30", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(out)])
    src.unlink(missing_ok=True)
    return out


def process(source: str, link: str, title: str, out_dir: Path, cache_dir: Path,
            gem: Gemini, max_clips: int = 20, min_score: int = 6) -> bool:
    """Find and render clips for one VOD. Returns False if the quota cut it short.

    `source` is either a Kick VOD page URL or an HLS master playlist URL.
    """
    global OUT, CACHE
    OUT, CACHE = out_dir, cache_dir
    SKIPPED.clear()
    for d in (WORK, OUT, CACHE):
        d.mkdir(parents=True, exist_ok=True)

    if ".m3u8" in source:
        renditions = renditions_from_master(source)
    else:
        title_from_page, renditions = list_renditions(source)
        title = title or title_from_page
    print("Renditions: " + ", ".join(f"{r.height}p/{r.tbr:.0f}k" for r in renditions))
    known = [r for r in renditions if r.height] or renditions
    low = min(renditions, key=lambda r: r.tbr or 1e9)
    high = known[-1]
    for r in known:
        if r.height and r.height <= 1080:
            high = r  # sorted ascending, so this ends on the best <=1080p
    print(f"VOD: {title}\nAnalysis: {low.height}p · Clips: {high.height}p")

    low_segments = list_segments(low.url)
    duration = sum(s.duration for s in low_segments)
    print(f"Length: {fmt_ts(duration)} · downloading analysis copy…")
    low_ts = WORK / "low.ts"
    download_range(low_segments, 0, duration, low_ts)

    audio = WORK / "audio.m4a"
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(low_ts), "-vn", "-ac", "1",
         "-ar", "16000", "-c:a", "aac", "-b:a", "48k", str(audio)])
    low_ts.unlink(missing_ok=True)
    levels = loudness_curve(audio)

    lines = transcribe(audio, CACHE / "transcript.json")
    laugh, shout = laughter_curve(audio, CACHE / "laughter.json", Path("models"))

    micros: list[Candidate] = []
    try:
        cands, micros = text_candidates(gem, lines, laugh, shout, levels, duration)
        source = "AI"
    except Exception as exc:  # quota, outage or a content block: fall back to laughter
        print(f"   ! Gemini unavailable ({str(exc)[:120]}); using laughter detection only")
        cands, source = [], "kahkaha"
    if not cands:
        cands, source = laughter_candidates(laugh, shout), "kahkaha"
    if not micros:
        micros = laughter_montage(laugh, shout)
    for c in cands:
        snap(c, lines, duration)
        c.verified = source == "AI"
    final = [c for c in dedupe(cands) if c.score >= min_score]
    complete = True
    rows = []
    if complete:
        final = sorted(final, key=lambda c: c.score, reverse=True)[:max_clips]
        final = [clamp(c, duration) for c in sorted(final, key=lambda c: c.start)]
        high_segments = list_segments(high.url)
        for i, c in enumerate(final, 1):
            print(f"Rendering clip {i}/{len(final)} at {fmt_ts(c.start)}")
            path = render(high_segments, c, i)
            rows.append({"no": i, "file": path.name, **asdict(c),
                         "start_ts": fmt_ts(c.start), "end_ts": fmt_ts(c.end)})
        montage = pick_montage(micros, duration)
        try:
            render_montage(high_segments, montage)
        except Exception as exc:
            print(f"   ! montage failed: {exc}")
            montage = []
    audio.unlink(missing_ok=True)
    write_report(link, title, rows, complete, montage if complete else [])
    return complete


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("vod_url")
    ap.add_argument("--max-clips", type=int, default=20)
    ap.add_argument("--min-score", type=int, default=6)
    args = ap.parse_args()
    key = re.sub(r"[^a-z0-9]+", "-", args.vod_url.lower())[-60:]
    complete = process(args.vod_url, args.vod_url, "", OUT, CACHE / key, Gemini(),
                       args.max_clips, args.min_score)
    (OUT / "status.json").write_text(json.dumps({"complete": complete}), encoding="utf-8")
    return 0


def write_report(vod_url: str, title: str, rows: list[dict], complete: bool = True,
                 montage: list[Candidate] | None = None) -> None:
    lines = [f"# Klipler — {title or 'Kick yayını'}", "", f"Yayın: {vod_url}", "",
             "| # | Dosya | Yayındaki yer | Süre | Puan | Seçen | Neden |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        dur = int(r["end"] - r["start"])
        why = r["why"].replace("|", "/").replace("\n", " ")
        lines.append(f"| {r['no']} | {r['file']} | {r['start_ts']} – {r['end_ts']} | {dur} sn | {r['score']}/10 | {'AI' if r['verified'] else 'kahkaha'} | {why} |")
    if not rows and complete:
        lines.append("\nBu yayında yeterince güçlü an bulunamadı.")
    if not complete:
        lines.append("\n⏳ Gemini'nin günlük ücretsiz kotası doldu. Yarın kaldığı yerden otomatik devam edecek; "
                     "dinlenen kısımlar hatırlanıyor.")
    if montage:
        total = sum(m.end - m.start for m in montage)
        lines.append(f"\n## Fragman — `fragman.mp4` ({int(total)} sn, {len(montage)} parça)\n")
        for m in montage:
            lines.append(f"- {fmt_ts(m.start)} ({int(m.end - m.start)} sn) — {m.why}")
    if SKIPPED:
        lines.append("\n⚠️ Şu bölümler dinlenemedi: " + ", ".join(SKIPPED))
    lines.append("\nAI = Gemini konuşmayı okuyup seçti · kahkaha = Gemini'ye ulaşılamadı, kahkaha tespitiyle seçildi")
    text = "\n".join(lines) + "\n"
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "klipler.md").write_text(text, encoding="utf-8")
    (OUT / "klipler.json").write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print("\n" + text)


if __name__ == "__main__":
    raise SystemExit(main())
