"""When each word is said where a voice does not say it itself: the words of a text as
the reader lights them up, each word's share of the audio by its characters, the length
of an MP3, and the test voice's silence.
"""

import re

from .kokoro_engine import wav

# A word as the reader lights it: letters or digits, with the apostrophes and hyphens
# inside it, and the decimals and thousands of a number.
_WORD = re.compile(r"\w+(?:[’'\-.,]\w+)*")


def words(text: str) -> list[tuple[int, int]]:
    """Where each word of the text starts and ends, in characters."""
    return [m.span() for m in _WORD.finditer(text)]


def proportional(text: str, seconds: float, offset: float = 0.0) -> list[dict]:
    """Each word's time as its share of `seconds` by characters, a gap counting as one."""
    spans = words(text)
    weights = [b - a + 1 for a, b in spans]
    total = sum(weights) or 1
    out, at = [], offset
    for (a, b), w in zip(spans, weights):
        length = seconds * w / total
        out.append({"from": a, "to": b, "start": round(at, 3), "end": round(at + length * (w - 1) / w, 3)})
        at += length
    return out


_BITRATES = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_RATES = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


def mp3_seconds(data: bytes) -> float:
    """The length of an MP3 of Layer III frames, counted frame by frame; an ID3 tag at the
    start is skipped."""
    i, seconds = 0, 0.0
    if data[:3] == b"ID3" and len(data) >= 10:
        i = 10 + ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
    while i + 4 <= len(data):
        b1, b2, b3 = data[i + 1], data[i + 2], data[i + 3]
        version = (b1 >> 3) & 3
        if data[i] != 0xFF or (b1 & 0xE0) != 0xE0 or version == 1 or ((b1 >> 1) & 3) != 1:
            i += 1
            continue
        bitrate_index, rate_index = b2 >> 4, (b2 >> 2) & 3
        if bitrate_index in (0, 15) or rate_index == 3:
            i += 1
            continue
        bitrate = _BITRATES[1 if version == 3 else 2][bitrate_index] * 1000
        rate = _RATES[version][rate_index]
        samples = 1152 if version == 3 else 576
        size = samples // 8 * bitrate // rate + ((b2 >> 1) & 1)
        seconds += samples / rate
        i += max(size, 4)
    return seconds


# The test voice (architecture.md 12, like Echo): this long a silence per character, at a
# low rate, so a test's audio is small and plays at once.
TEST_SECONDS_PER_CHARACTER = 0.03
TEST_RATE = 8000


def test_voice(text: str) -> tuple[bytes, list[dict]]:
    seconds = max(0.2, len(text) * TEST_SECONDS_PER_CHARACTER)
    pcm = bytes(2 * int(seconds * TEST_RATE))
    return wav(pcm, TEST_RATE), proportional(text, seconds)
