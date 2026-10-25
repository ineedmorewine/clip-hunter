"""Thin Gemini wrapper: file upload, structured output, retries and model fallback."""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

from google import genai
from google.genai import errors, types

# Model names change often, so by default we discover the newest Flash models at runtime.
SKIP_WORDS = ("pro", "image", "tts", "live", "embedding", "audio", "thinking", "exp", "preview", "8b")
MIN_GAP_SECONDS = 7.0  # keep well under free-tier requests-per-minute limits


class Gemini:
    def __init__(self) -> None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY secret is missing")
        self.client = genai.Client(api_key=key)
        configured = [m.strip() for m in (os.environ.get("GEMINI_MODELS") or "").split(",") if m.strip()]
        self.models = configured or self._discover()
        print("Gemini models (in order): " + ", ".join(self.models))
        self._last_call = 0.0

    def _discover(self) -> list[str]:
        """Newest stable Flash models first, full before lite."""
        found = []
        for m in self.client.models.list():
            name = (m.name or "").removeprefix("models/")
            actions = getattr(m, "supported_actions", None) or []
            if "flash" not in name or (actions and "generateContent" not in actions):
                continue
            if any(w in name.replace("flash", "") for w in SKIP_WORDS):
                continue
            version = tuple(int(x) for x in re.findall(r"\d+", name.split("flash")[0]))
            found.append((version, "lite" not in name, "latest" not in name, name))
        found.sort(reverse=True)
        names = [n for *_, n in found]
        if not names:
            raise RuntimeError("no Gemini Flash model available for this API key")
        return names[:4]

    def upload(self, path: Path, mime: str):
        f = self.client.files.upload(file=str(path), config={"mime_type": mime})
        for _ in range(90):
            if f.state and f.state.name == "ACTIVE":
                return f
            if f.state and f.state.name == "FAILED":
                raise RuntimeError(f"Gemini could not process {path.name}")
            time.sleep(2)
            f = self.client.files.get(name=f.name)
        raise RuntimeError(f"timed out waiting for {path.name}")

    def delete(self, f) -> None:
        try:
            self.client.files.delete(name=f.name)
        except Exception:
            pass

    def ask(self, parts: list, schema, temperature: float = 0.4):
        """Return a parsed pydantic object; retries on rate limits, falls back across models."""
        config = types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=schema,
            temperature=temperature,
            # Streams are full of slang, swearing and dark jokes; don't let filters blank the answer.
            safety_settings=[
                types.SafetySetting(category=c, threshold=types.HarmBlockThreshold.BLOCK_NONE)
                for c in (
                    types.HarmCategory.HARM_CATEGORY_HARASSMENT,
                    types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                )
            ],
        )
        last_error: Exception | None = None
        for model in list(self.models):
            for attempt in range(4):
                wait = MIN_GAP_SECONDS - (time.time() - self._last_call)
                if wait > 0:
                    time.sleep(wait)
                self._last_call = time.time()
                try:
                    resp = self.client.models.generate_content(model=model, contents=parts, config=config)
                    if resp.parsed is None:
                        reason = ""
                        if resp.candidates:
                            reason = str(resp.candidates[0].finish_reason)
                        elif resp.prompt_feedback:
                            reason = str(resp.prompt_feedback.block_reason)
                        if "PROHIBITED" in reason or "BLOCK" in reason.upper() and "SAFETY" not in reason.upper():
                            # Google's fixed filter: retrying or switching models only wastes quota.
                            raise ContentBlocked(reason)
                        print(f"  {model}: empty answer (reason: {reason or '?'}), retrying")
                        raise RuntimeError(f"empty answer ({reason}): {(resp.text or '')[:200]}")
                    # Remember the working model so later calls skip dead ones.
                    self.models = [model] + [m for m in self.models if m != model]
                    return resp.parsed
                except errors.ClientError as exc:
                    last_error = exc
                    code = getattr(exc, "code", None)
                    if code == 429:
                        delay = _retry_delay(str(exc)) or 20 * (attempt + 1)
                        if "PerDay" in str(exc) or delay > 300:
                            print(f"  {model}: daily quota exhausted for today")
                            self.models = [m for m in self.models if m != model]
                            break
                        print(f"  {model}: rate limited, waiting {delay:.0f}s")
                        time.sleep(delay)
                        continue
                    if code in (400, 403, 404):
                        print(f"  {model}: not usable ({code})")
                        self.models = [m for m in self.models if m != model]
                        break
                    raise
                except errors.ServerError as exc:
                    last_error = exc
                    print(f"  {model}: busy ({getattr(exc, 'code', '?')}), retrying")
                    time.sleep(30 * (attempt + 1))
                except ContentBlocked:
                    raise
                except RuntimeError as exc:
                    last_error = exc
                    time.sleep(5)
                except Exception as exc:  # dropped connection, timeout: transient, try again
                    last_error = exc
                    print(f"  {model}: connection problem ({str(exc)[:80]}), retrying")
                    time.sleep(30 * (attempt + 1))
        if not self.models:
            raise QuotaExhausted("every Gemini model is out of quota for today")
        raise RuntimeError(f"all Gemini models failed: {last_error}")


class ContentBlocked(RuntimeError):
    """Google refused this input with a non-configurable filter."""


class QuotaExhausted(RuntimeError):
    """Raised when no model has quota left; callers should stop asking."""


def _retry_delay(message: str) -> float | None:
    match = re.search(r"retry(?:Delay)?['\"]?\s*[:=]\s*['\"]?(\d+(?:\.\d+)?)s", message)
    return float(match.group(1)) if match else None
