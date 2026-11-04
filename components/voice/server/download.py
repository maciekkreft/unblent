"""Downloading the Kokoro voice once to this Mac (architecture.md 3.4, 11.1): the model
and the voices from kokoro-onnx's release model-files-v1.0, into DATA/voice/. Each file is
written under a temporary name, checked by its size and its sha256, and only then renamed
into place, so a voice that reads as ready is always whole. The download runs on a thread
of its own, its progress is kept in memory, and Cancel stops it and keeps nothing.
"""

import hashlib
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

from server.user import DATA

# UNBLENT_VOICE_URL points a throwaway server at a local copy of the files.
_BASE = os.environ.get("UNBLENT_VOICE_URL") or "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = (
    ("kokoro-v1.0.onnx", 325_532_387, "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"),
    ("voices-v1.0.bin", 28_214_398, "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"),
)
SIZE = sum(size for _, size, _ in FILES)
_CHUNK = 1 << 20

_lock = threading.Lock()
_run: dict | None = None  # {"thread", "cancel": Event, "done": int}


def folder() -> Path:
    return DATA / "voice"


def model() -> Path:
    return folder() / FILES[0][0]


def voices() -> Path:
    return folder() / FILES[1][0]


def ready() -> bool:
    # Whole files only ever reach their own names, so the size says it is there.
    for name, size, _ in FILES:
        try:
            if (folder() / name).stat().st_size != size:
                return False
        except OSError:
            return False
    return True


def state() -> dict:
    """The picture's kokoro part: missing, downloading with the bytes so far, or ready."""
    with _lock:
        if _run is not None:
            return {"state": "downloading", "done": _run["done"], "size": SIZE}
    if ready():
        return {"state": "ready", "done": SIZE, "size": SIZE}
    return {"state": "missing", "done": 0, "size": SIZE}


def start() -> None:
    global _run
    with _lock:
        if _run is not None or ready():
            return
        run = {"cancel": threading.Event(), "done": 0}
        run["thread"] = threading.Thread(target=_download, args=(run,), name="voice-download", daemon=True)
        _run = run
    run["thread"].start()


def cancel() -> None:
    global _run
    with _lock:
        run, _run = _run, None
    if run is not None:
        run["cancel"].set()


def _download(run: dict) -> None:
    global _run
    target = folder()
    target.mkdir(parents=True, exist_ok=True)
    written = []
    try:
        for name, size, sha in FILES:
            final = target / name
            if final.exists() and final.stat().st_size == size:
                _add(run, size)
                continue
            part = target / f".{name}.{id(run)}.part"
            written.append(part)
            if not _fetch(run, f"{_BASE}/{name}", part, size, sha):
                return
            os.replace(part, final)
            written.remove(part)
    finally:
        for part in written:
            part.unlink(missing_ok=True)
        with _lock:
            if _run is run:
                _run = None


def _add(run: dict, n: int) -> None:
    with _lock:
        run["done"] += n


def _fetch(run: dict, url: str, part: Path, size: int, sha: str) -> bool:
    digest, got = hashlib.sha256(), 0
    try:
        with urllib.request.urlopen(url, timeout=30) as response, open(part, "wb") as out:
            while chunk := response.read(_CHUNK):
                if run["cancel"].is_set():
                    return False
                got += len(chunk)
                if got > size:
                    return False
                digest.update(chunk)
                out.write(chunk)
                _add(run, len(chunk))
    except (urllib.error.URLError, TimeoutError, OSError):
        return False
    return got == size and digest.hexdigest() == sha
