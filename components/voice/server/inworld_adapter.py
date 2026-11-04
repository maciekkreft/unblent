"""Inworld's text to speech, on the account's own Inworld key (architecture.md 3.4, 7.7).
The standard library's urllib makes the call, as llm's Jev adapter does, because the
import check allows only the standard library and what requirements.txt names (11.2).
The key and the text are never logged: the text is the user's own book.

Inworld takes at most 2,000 characters in one request, so a longer paragraph is sent in
pieces cut at sentence ends, and the pieces' MP3s are joined, which a browser plays as
one. Each word's time comes from Inworld's word timestamps when their words match the
text's; otherwise it is the word's share of the audio by characters.
"""

import base64
import json
import os
import re
import urllib.error
import urllib.request

from . import timing

# UNBLENT_INWORLD_URL points a throwaway server at a local stand-in for Inworld, so the
# website's reading can be tried by hand without spending money.
_URL = os.environ.get("UNBLENT_INWORLD_URL") or "https://api.inworld.ai/tts/v1/voice"
_MODEL = "inworld-tts-2"
_TIMEOUT = 30
_LIMIT = 1900
MIME = "audio/mpeg"


class Refused(Exception):
    """Inworld would not speak: `code` is the reply's error, no-key or unavailable."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _pieces(text: str) -> list[tuple[int, str]]:
    """The text cut into pieces Inworld takes, each with where it starts in the text."""
    pieces, start = [], 0
    while len(text) - start > _LIMIT:
        window = text[start : start + _LIMIT]
        cut = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
        if cut <= 0:
            cut = window.rfind(" ")
        cut = _LIMIT if cut <= 0 else cut + 1
        pieces.append((start, text[start : start + cut]))
        start += cut
    pieces.append((start, text[start:]))
    return [(at, piece) for at, piece in pieces if piece.strip()]


def _ask(key: str, voice: str, text: str) -> dict:
    body = {
        "text": text,
        "voiceId": voice,
        "modelId": _MODEL,
        "audioConfig": {"audioEncoding": "MP3"},
        "timestampType": "WORD",
    }
    request = urllib.request.Request(
        _URL,
        data=json.dumps(body).encode(),
        # Inworld's key is already the Base64 credentials its Portal hands out.
        headers={"Content-Type": "application/json", "Authorization": f"Basic {key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise Refused("no-key" if error.code in (401, 403) else "unavailable") from None
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        raise Refused("unavailable") from None


def _alignment(reply: dict):
    words = (reply.get("timestampInfo") or {}).get("wordAlignment") or {}
    said = words.get("words") or []
    starts = words.get("wordStartTimeSeconds") or []
    ends = words.get("wordEndTimeSeconds") or []
    if not (len(said) == len(starts) == len(ends)):
        return []
    # Inworld may list a punctuation mark as a word of its own; only words with a letter
    # or a digit are matched with the text's words.
    return [(s, e) for w, s, e in zip(said, starts, ends) if re.search(r"\w", str(w))]


def speak(key: str, voice: str, text: str) -> tuple[bytes, list[dict]]:
    """The text in Inworld's voice as MP3, with when each word is said."""
    audio, words, offset = b"", [], 0.0
    for at, piece in _pieces(text):
        reply = _ask(key, voice, piece)
        try:
            chunk = base64.b64decode(reply["audioContent"])
        except (KeyError, TypeError, ValueError):
            raise Refused("unavailable") from None
        spans = timing.words(piece)
        aligned = _alignment(reply)
        if aligned and len(aligned) == len(spans):
            placed = [
                {"from": at + a, "to": at + b, "start": round(offset + s, 3), "end": round(offset + e, 3)}
                for (a, b), (s, e) in zip(spans, aligned)
            ]
            length = max(aligned[-1][1], 0.0)
        else:
            length = timing.mp3_seconds(chunk)
            placed = [{**w, "from": w["from"] + at, "to": w["to"] + at} for w in timing.proportional(piece, length, offset)]
        words += placed
        audio += chunk
        offset += length
    return audio, words
