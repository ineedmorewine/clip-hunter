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
    # Pass decoded samples: faster-whisper's own decoder breaks on some PyAV versions.
    segments, info = model.transcribe(
        load_pcm(audio), language="tr", beam_size=1, vad_filter=True,
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


def _labels(model: Path) -> list[str]:
    """YAMNet's class names, packed inside the .tflite as metadata (a zip)."""
    import zipfile
    try:
        with zipfile.ZipFile(model) as zf:
            name = next(n for n in zf.namelist() if n.endswith(".txt") or n.endswith(".csv"))
            raw = zf.read(name).decode("utf-8").splitlines()
            if name.endswith(".csv"):
                return [row.split(",", 2)[-1].strip().strip('"') for row in raw[1:]]
            return [r.strip() for r in raw]
    except Exception:
        pass
    csv = model.with_name("yamnet_class_map.csv")
    if not csv.exists():
        subprocess.run(["curl", "-sSLf", "-o", str(csv),
                        "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv"],
                       check=True)
    rows = csv.read_text(encoding="utf-8").splitlines()[1:]
    return [r.split(",", 2)[-1].strip().strip('"') for r in rows]


def laughter_curve(audio: Path, cache_file: Path, model_dir: Path) -> tuple[list[float], list[float]]:
    """Return (laugh, shout) probability per second. Never fatal: zeros on failure."""
    if cache_file.exists():
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        print("Laughter: from cache")
        return data["laugh"], data["shout"]
    pcm = load_pcm(audio)
    seconds = int(len(pcm) / 16000) + 1
    laugh, shout = [0.0] * seconds, [0.0] * seconds
    try:
        from ai_edge_litert.interpreter import Interpreter

        model = _yamnet_model(model_dir / "yamnet.tflite")
        labels = _labels(model)
        laugh_idx = [i for i, n in enumerate(labels) if n in LAUGH_LABELS]
        shout_idx = [i for i, n in enumerate(labels) if n in SHOUT_LABELS]
        print(f"YAMNet: {len(labels)} classes, laugh={laugh_idx}, shout={shout_idx}")
        interp = Interpreter(model_path=str(model))
        inp = interp.get_input_details()[0]
        win = int(inp["shape"][-1]) if int(inp["shape"][-1]) > 1 else 15600
        if list(inp["shape"]) != [win] and list(inp["shape"]) != [1, win]:
            interp.resize_tensor_input(inp["index"], [win])
        interp.allocate_tensors()
        inp = interp.get_input_details()[0]
        out_index = interp.get_output_details()[0]["index"]
        for sec in range(seconds):
            frame = pcm[sec * 16000: sec * 16000 + win]
            if len(frame) < win:
                frame = np.pad(frame, (0, win - len(frame)))
            interp.set_tensor(inp["index"], frame.reshape(inp["shape"]).astype(np.float32))
            interp.invoke()
            scores = interp.get_tensor(out_index).reshape(-1)
            laugh[sec] = float(sum(scores[i] for i in laugh_idx))
            shout[sec] = float(sum(scores[i] for i in shout_idx))
    except Exception as exc:
        print(f"   ! laughter detection unavailable: {exc}")
        return laugh, shout
    cache_file.write_text(json.dumps({"laugh": laugh, "shout": shout}), encoding="utf-8")
    print(f"Laughter: {sum(1 for v in laugh if v > 0.3)} seconds with laughter")
    return laugh, shout
