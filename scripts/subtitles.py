"""Word-timed subtitles for rendered clips, with a speaker index per cue.

For every clip range the stream audio is re-transcribed with word timestamps
(the full-stream transcript only has sentence timing). Words are grouped into
short caption cues. Speakers are told apart by clustering voice embeddings
(Resemblyzer) over the whole stream, so a person keeps the same colour in
every clip. The most frequent voice gets index 0 (white in the editor).

Output per clip, times relative to the clip start:
  {"speakers": 3, "cues": [{"s": 0.42, "e": 1.10, "t": "bi dakika", "p": 0}, ...]}
If speaker separation fails, every cue gets p = 0.
"""

from __future__ import annotations

import os
import re

import numpy as np

SR = 16000
MAX_WORDS = 4
MAX_CHARS = 24
PAUSE = 0.45
MAX_SPEAKERS = 5


def _words(model, pcm: np.ndarray, start: float, end: float) -> list[dict]:
    chunk = pcm[int(start * SR):int(end * SR)]
    if chunk.size < SR // 2:
        return []
    segments, _ = model.transcribe(chunk, language="tr", beam_size=5, vad_filter=True,
                                   word_timestamps=True, condition_on_previous_text=False)
    out = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                out.append({"s": round(w.start, 2), "e": round(w.end, 2), "t": text, "seg": seg.id})
    return out


def _cues(words: list[dict]) -> list[dict]:
    cues, cur = [], []

    def flush():
        if cur:
            cues.append({"s": cur[0]["s"], "e": cur[-1]["e"], "t": " ".join(w["t"] for w in cur),
                         "seg": cur[0]["seg"]})
            cur.clear()

    for w in words:
        if cur and (len(cur) >= MAX_WORDS
                    or len(" ".join(x["t"] for x in cur)) + len(w["t"]) > MAX_CHARS
                    or w["s"] - cur[-1]["e"] > PAUSE
                    or w["seg"] != cur[-1]["seg"]):
            flush()
        cur.append(w)
        if re.search(r"[.!?…]$", w["t"]):
            flush()
    flush()
    # Hold each cue on screen until the next one starts (max 0.6 s extra), never overlapping.
    for a, b in zip(cues, cues[1:]):
        a["e"] = round(min(b["s"], a["e"] + 0.6), 2)
    if cues:
        cues[-1]["e"] = round(cues[-1]["e"] + 0.4, 2)
    return cues


def _speakers(pcm: np.ndarray, spans: list[tuple[float, float]]) -> list[int]:
    """Cluster voice embeddings of absolute (start, end) spans; returns one index per span."""
    from resemblyzer import VoiceEncoder
    from sklearn.cluster import AgglomerativeClustering

    enc = VoiceEncoder("cpu", verbose=False)
    embeds = []
    for s, e in spans:
        # Very short spans give noisy embeddings; pad them out to at least 1.2 s.
        mid = (s + e) / 2
        if e - s < 1.2:
            s, e = mid - 0.6, mid + 0.6
        chunk = pcm[max(0, int(s * SR)):int(e * SR)]
        embeds.append(enc.embed_utterance(chunk) if chunk.size > SR // 4 else None)
    ok = [i for i, v in enumerate(embeds) if v is not None]
    if len(ok) < 4:
        return [0] * len(spans)
    X = np.stack([embeds[i] for i in ok])
    labels = AgglomerativeClustering(n_clusters=None, distance_threshold=0.55, metric="cosine",
                                     linkage="average").fit_predict(X)
    # Keep the biggest clusters as speakers; fold small ones into the closest big one.
    counts = np.bincount(labels)
    big = [int(c) for c in np.argsort(-counts) if counts[c] >= max(3, len(ok) * 0.04)][:MAX_SPEAKERS] \
        or [int(np.argmax(counts))]
    cents = {c: X[labels == c].mean(axis=0) for c in big}
    order = {c: n for n, c in enumerate(big)}  # 0 = most frequent voice
    result = [0] * len(spans)
    for row, i in enumerate(ok):
        c = int(labels[row])
        if c not in order:
            c = max(big, key=lambda b: float(np.dot(X[row], cents[b])))
        result[i] = order[c]
    # Spans without an embedding inherit the previous speaker.
    for i in range(1, len(spans)):
        if embeds[i] is None:
            result[i] = result[i - 1]
    return result


def build(pcm: np.ndarray, ranges: list[tuple[float, float]]) -> list[dict]:
    """Subtitles for each (start, end) range in stream seconds."""
    from faster_whisper import WhisperModel

    model = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3-turbo"), device="cpu",
                         compute_type="int8", cpu_threads=os.cpu_count() or 4)
    per_clip = []
    for n, (s, e) in enumerate(ranges, 1):
        print(f"Subtitles {n}/{len(ranges)}")
        per_clip.append(_cues(_words(model, pcm, s, e)))

    # One speaker label per Whisper segment (cues of a segment share it).
    spans, keys = [], []
    for k, ((s, _), cues) in enumerate(zip(ranges, per_clip)):
        segs: dict[int, list[float]] = {}
        for c in cues:
            span = segs.setdefault(c["seg"], [c["s"], c["e"]])
            span[1] = c["e"]
        for seg, (a, b) in segs.items():
            spans.append((s + a, s + b))
            keys.append((k, seg))
    try:
        labels = _speakers(pcm, spans)
    except Exception as exc:  # optional: subtitles still work in one colour
        print(f"   ! speaker separation failed: {str(exc)[:160]}")
        labels = [0] * len(spans)
    who = dict(zip(keys, labels))
    speakers = (max(labels) + 1) if labels else 1
    out = []
    for k, cues in enumerate(per_clip):
        out.append({"speakers": speakers,
                    "cues": [{"s": c["s"], "e": c["e"], "t": c["t"], "p": who.get((k, c["seg"]), 0)}
                             for c in cues]})
    return out
