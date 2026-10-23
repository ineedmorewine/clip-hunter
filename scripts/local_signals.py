"""Quota-free signals computed on the runner itself.

- transcribe(): Turkish speech-to-text with faster-whisper (open-source Whisper).
- laughter_curve(): per-second laughter / shouting probability with YAMNet.
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

YAMNET_URLS = [
    "https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite",
    "https://tfhub.dev/google/lite-model/yamnet/classification/tflite/1?lite-format=tflite",
]
LAUGH_LABELS = {"Laughter", "Giggle", "Snicker", "Belly laugh", "Chuckle, chortle", "Baby laughter"}
SHOUT_LABELS = {"Shout", "Yell", "Screaming", "Bellow", "Whoop", "Children shouting"}
WHISPER_MODEL = os.environ.get("WHISPER_MODEL") or "large-v3-turbo"


@dataclass
class Line:
    start: float
    end: float
    text: str


def load_pcm(audio: Path) -> np.ndarray:
    """Decode audio to mono 16 kHz float32 via ffmpeg."""
    proc = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(audio), "-ac", "1", "-ar", "16000",
         "-f", "s16le", "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(audio: Path, cache_file: Path) -> list[Line]:
    if cache_file.exists():
        print("Transcript: from cache")
        return [Line(**d) for d in json.loads(cache_file.read_text(encoding="utf-8"))]
    from faster_whisper import WhisperModel

    print(f"Transcribing with Whisper ({WHISPER_MODEL}) …")
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8",
                         cpu_threads=os.cpu_count() or 4)
    segments, info = model.transcribe(
        str(audio), language="tr", beam_size=1, vad_filter=True,
        condition_on_previous_text=False,  # avoids repetition loops on long streams
        vad_parameters={"min_silence_duration_ms": 700},
    )
    lines: list[Line] = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            lines.append(Line(round(seg.start, 1), round(seg.end, 1), text))
        if len(lines) % 200 == 0 and lines:
            print(f"   … {int(seg.end // 60)} min transcribed")
    cache_file.write_text(json.dumps([asdict(l) for l in lines], ensure_ascii=False), encoding="utf-8")
    print(f"Transcript: {len(lines)} lines")
    return lines


def _yamnet_model(dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 1_000_000:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    for url in YAMNET_URLS:
        if subprocess.run(["curl", "-sSLf", "-o", str(dest), url]).returncode == 0 \
                and dest.stat().st_size > 1_000_000:
            return dest
    raise RuntimeError("could not download the YAMNet model")


def laughter_curve(audio: Path, cache_file: Path, model_dir: Path) -> tuple[list[float], list[float]]:
    """Return (laugh, shout) probability per second."""
    if cache_file.exists():
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        print("Laughter: from cache")
        return data["laugh"], data["shout"]
    import mediapipe as mp

    model = _yamnet_model(model_dir / "yamnet.tflite")
    options = mp.tasks.audio.AudioClassifierOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model.resolve())),
        max_results=-1, running_mode=mp.tasks.audio.RunningMode.AUDIO_CLIPS,
    )
    pcm = load_pcm(audio)
    seconds = int(len(pcm) / 16000) + 1
    laugh, shout = [0.0] * seconds, [0.0] * seconds
    block = 16000 * 600  # classify 10 minutes at a time to bound memory
    with mp.tasks.audio.AudioClassifier.create_from_options(options) as clf:
        for off in range(0, len(pcm), block):
            data = mp.tasks.components.containers.AudioData.create_from_array(pcm[off:off + block], 16000)
            for res in clf.classify(data):
                sec = int(off / 16000 + res.timestamp_ms / 1000)
                if sec >= seconds or not res.classifications:
                    continue
                cats = res.classifications[0].categories
                laugh[sec] = max(laugh[sec], sum(c.score for c in cats if c.category_name in LAUGH_LABELS))
                shout[sec] = max(shout[sec], sum(c.score for c in cats if c.category_name in SHOUT_LABELS))
    cache_file.write_text(json.dumps({"laugh": laugh, "shout": shout}), encoding="utf-8")
    print(f"Laughter: {sum(1 for v in laugh if v > 0.3)} seconds with laughter")
    return laugh, shout
