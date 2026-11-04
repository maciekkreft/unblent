"""The Kokoro-82M voice on the user's Mac (architecture.md 3.4, 10): the model downloaded
into DATA/voice/ runs in ONNX Runtime, the phonemes come from lexicon.py, and the voices
are read from voices-v1.0.bin with numpy. The tokenizer is our own: each phoneme becomes
its number in the model's vocabulary (data/kokoro_vocab.json, see data/NOTICE), and what
the vocabulary lacks is dropped, as kokoro-onnx does.

The model takes at most 510 phonemes at a time, so a long paragraph is read in pieces,
each ending at a sentence or a clause where it can. This export reports no durations, so
each word's time is its share of its piece by its number of phonemes.

onnxruntime and numpy are imported only when the voice first speaks, so a server that
never reads aloud with Kokoro never loads them.
"""

import json
import threading
from pathlib import Path

from . import lexicon

SAMPLE_RATE = 24000
MAX_PHONEMES = 510

_VOCAB: dict[str, int] = json.loads((Path(__file__).parent / "data" / "kokoro_vocab.json").read_text(encoding="utf-8"))

_lock = threading.Lock()
_loaded: dict = {}


def _session(model: Path, voices: Path):
    """The model and the voices, loaded once per server and kept, because loading takes
    seconds and each paragraph would otherwise wait for it."""
    with _lock:
        if _loaded.get("model") != model:
            import numpy as np
            import onnxruntime as rt

            _loaded.clear()
            _loaded["session"] = rt.InferenceSession(str(model), providers=["CPUExecutionProvider"])
            with np.load(voices) as archive:
                _loaded["voices"] = {name: archive[name] for name in archive.files}
            _loaded["model"] = model
        return _loaded["session"], _loaded["voices"]


def _pieces(tokens: list) -> list[list]:
    """The tokens in pieces of at most MAX_PHONEMES phonemes with their spaces, each piece
    ended at the last sentence end, else the last clause mark, else the last word that fits."""
    pieces, current, size = [], [], 0
    for t in tokens:
        cost = len(t.phonemes) + 1
        if current and size + cost > MAX_PHONEMES:
            cut = next((i for i in range(len(current) - 1, 0, -1) if current[i].phonemes in (".", "!", "?")), None)
            if cut is None:
                cut = next((i for i in range(len(current) - 1, 0, -1) if current[i].kind == "punct"), len(current) - 1)
            pieces.append(current[: cut + 1])
            current = current[cut + 1 :]
            size = sum(len(x.phonemes) + 1 for x in current)
        current.append(t)
        size += cost
    if current:
        pieces.append(current)
    return pieces


def _ids(tokens: list) -> tuple[list[int], list[tuple[object, int, int]]]:
    """The piece's vocabulary numbers, and for each word the span of numbers it holds."""
    ids, spans = [], []
    for t in tokens:
        if ids and t.space:
            ids.append(_VOCAB[" "])
        start = len(ids)
        ids.extend(_VOCAB[c] for c in t.phonemes if c in _VOCAB)
        if t.kind == "word":
            spans.append((t, start, len(ids)))
    return ids[: MAX_PHONEMES], spans


def speak(text: str, voice: str, model: Path, voices_file: Path) -> tuple[bytes, list[dict]]:
    """The text as 16-bit mono WAV at 24 kHz, with when each word is said."""
    import numpy as np

    session, voices = _session(model, voices_file)
    style_of = voices[voice]
    audio, words, offset = [], [], 0.0
    for piece in _pieces(lexicon.tokens(text)):
        ids, spans = _ids(piece)
        if not ids:
            continue
        style = style_of[min(len(ids), len(style_of)) - 1]
        out = session.run(
            None,
            {
                "tokens": np.array([[0, *ids, 0]], dtype=np.int64),
                "style": np.asarray(style, dtype=np.float32),
                "speed": np.array([1.0], dtype=np.float32),
            },
        )[0].ravel()
        out = _trim(out, np)
        if audio:
            # The pause the model leaves at a piece's end is trimmed, so one is put back.
            audio.append(np.zeros(int(_PAUSE * SAMPLE_RATE), dtype=out.dtype))
            offset += _PAUSE
        seconds = len(out) / SAMPLE_RATE
        per = seconds / len(ids)
        for t, start, end in spans:
            words.append({
                "from": t.start, "to": t.end,
                "start": round(offset + start * per, 3), "end": round(offset + end * per, 3),
            })
        audio.append(out)
        offset += seconds
    if not audio:
        raise ValueError("nothing to read")
    samples = np.concatenate(audio)
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    return wav(pcm, SAMPLE_RATE), words


_PAUSE = 0.25
_MARGIN = int(0.03 * SAMPLE_RATE)


def _trim(out, np):
    """The audio without the silence the model puts before and after the speech, so the
    words' shares of the time fall on the speech itself."""
    loud = np.flatnonzero(np.abs(out) > 0.02 * (np.abs(out).max() or 1))
    if not len(loud):
        return out
    return out[max(0, loud[0] - _MARGIN) : loud[-1] + _MARGIN]


def wav(pcm: bytes, rate: int) -> bytes:
    """16-bit mono PCM in a WAV file."""
    import io
    import wave

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm)
    return buffer.getvalue()
