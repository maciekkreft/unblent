"""voice's server module (architecture.md 3.4, 7.7): the far end of the remote-only voice
fact. Every browser request carries X-Unblent-Local: 1, so a connected Mac still answers
here, with Kokoro on the Mac itself.

On a Mac (the local edition, when server.user.local_user() is set) the voice is Kokoro:
GET "" answers {here: "mac", kokoro: {state, done, size}, voice, voices}; the voice
picked is kept in DATA/voice.json, which belongs to this Mac, not to an account; PUT ""
takes {voice?, download?: "start" | "cancel"} (download.py). On the website the voice is
Inworld on the account's own key: GET "" answers {here: "web", inworld: {keySet}, voice,
voices}; the voice picked and the key, encrypted (crypto.py), are kept in
data/<user>/voice.db; PUT "" takes {voice?, key?, step?}, an empty key removing it. A key
change with a step id keeps the key from before and after under that id (keysteps.py):
PUT "/key/step" brings one back for Undo or Redo, answering the error changed when the key
changed since; PUT "/key/forget" erases them once the step leaves the undo list.

POST "/speak" takes {text} and answers {mime, audio (base64), words: [{from, to, start,
end}]}, or {error}: no-key, not-downloaded or unavailable, answered 200 as updates does,
because a 4xx is a failure of the page (11.2). The test voice, "test", answers on both
editions with a short silence, without a key or a download, the way Echo stands in for a
model (12). A request body that fails validation is answered with a fixed 400, never
echoed, because it may carry the key. The website answers a read without a signed-in user
with the error signed-out, for the same reason.
"""

import base64
import json
import logging
import os
import sqlite3
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from server.user import DATA, current_user, local_user, require_user, user_dir

from . import crypto, download, inworld_adapter, keysteps, kokoro_engine, timing

_log = logging.getLogger("uvicorn.error")

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

TEST = {"id": "test", "label": "Test voice"}
# The voices offered, in the order Settings lists them; the test voice is last, and
# Settings shows it only in the workshop profile.
MAC_VOICES = [
    {"id": "af_heart", "label": "Heart"},
    {"id": "af_bella", "label": "Bella"},
    {"id": "am_michael", "label": "Michael"},
    {"id": "bf_emma", "label": "Emma"},
    {"id": "bm_george", "label": "George"},
    TEST,
]
WEB_VOICES = [
    {"id": "Ashley", "label": "Ashley"},
    {"id": "Dennis", "label": "Dennis"},
    {"id": "Olivia", "label": "Olivia"},
    {"id": "Timothy", "label": "Timothy"},
    TEST,
]
_INWORLD = "inworld"
# A paragraph is short; this bounds what one request can make a voice read.
_MAX_TEXT = 20_000
_FILE = "voice.json"


def _bad():
    return JSONResponse({"error": "bad-request"}, status_code=400)


async def _body(request: Request):
    try:
        return await request.json()
    except ValueError:
        return None


def _ids(voices: list[dict]) -> set[str]:
    return {v["id"] for v in voices}


# --- The Mac ---------------------------------------------------------------------------


def _mac_voice() -> str:
    try:
        value = json.loads((DATA / _FILE).read_text()).get("voice")
    except (OSError, ValueError, AttributeError):
        value = None
    return value if value in _ids(MAC_VOICES) else MAC_VOICES[0]["id"]


def _write_mac_voice(voice: str) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    # Written whole and then renamed, so a read never meets half a file.
    handle, name = tempfile.mkstemp(dir=DATA, prefix=".voice-", suffix=".json")
    try:
        with os.fdopen(handle, "w") as out:
            json.dump({"voice": voice}, out)
        os.replace(name, DATA / _FILE)
    except BaseException:
        os.unlink(name)
        raise


def _mac_picture() -> dict:
    return {"here": "mac", "kokoro": download.state(), "voice": _mac_voice(), "voices": MAC_VOICES}


# --- The website -----------------------------------------------------------------------


@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "voice.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _web_voice(connection: sqlite3.Connection) -> str:
    row = connection.execute("SELECT voice FROM settings WHERE one = 1").fetchone()
    return row["voice"] if row and row["voice"] in _ids(WEB_VOICES) else WEB_VOICES[0]["id"]


def _key(connection: sqlite3.Connection) -> str | None:
    row = connection.execute("SELECT cipher FROM keys WHERE provider = ?", (_INWORLD,)).fetchone()
    return crypto.decrypt(row["cipher"]) if row else None


def _web_picture(connection: sqlite3.Connection) -> dict:
    return {"here": "web", "inworld": {"keySet": _key(connection) is not None}, "voice": _web_voice(connection), "voices": WEB_VOICES}


def _web_read(user_id: str) -> dict:
    with _connect(user_id) as connection:
        return _web_picture(connection)


def _web_apply(user_id: str, fields: dict) -> dict:
    with _connect(user_id) as connection:
        if "voice" in fields:
            connection.execute(
                "INSERT INTO settings (one, voice) VALUES (1, ?) ON CONFLICT(one) DO UPDATE SET voice = excluded.voice",
                (fields["voice"],),
            )
        if "key" in fields:
            key = fields["key"].strip()
            cipher = crypto.encrypt(key) if key else None
            keysteps.put(connection, "keys", "key_steps", _INWORLD, cipher, int(time.time() * 1000), fields.get("step"))
        return _web_picture(connection)


def _web_move(user_id: str, body: dict) -> dict | None:
    with _connect(user_id) as connection:
        if not keysteps.move(connection, "keys", "key_steps", body["step"], body["restore"], body["expect"]):
            return None
        return _web_picture(connection)


def _web_forget(user_id: str, step: str) -> None:
    with _connect(user_id) as connection:
        keysteps.forget(connection, "key_steps", step)


# --- Routes ----------------------------------------------------------------------------


@router.get("")
async def read(request: Request):
    if local_user():
        return await run_in_threadpool(_mac_picture)
    user_id = current_user(request)
    if not user_id:
        return {"error": "signed-out"}
    return await run_in_threadpool(_web_read, user_id)


def _valid(body, mac: bool) -> dict | None:
    allowed = {"voice", "download"} if mac else {"voice", "key", "step"}
    if not isinstance(body, dict) or not body or not set(body) <= allowed:
        return None
    if "voice" in body and body["voice"] not in _ids(MAC_VOICES if mac else WEB_VOICES):
        return None
    if "download" in body and body["download"] not in ("start", "cancel"):
        return None
    if "key" in body and (not isinstance(body["key"], str) or len(body["key"]) > 2000):
        return None
    if "step" in body and ("key" not in body or not keysteps.valid_step(body["step"])):
        return None
    return body


@router.put("")
async def edit(request: Request):
    mac = bool(local_user())
    fields = _valid(await _body(request), mac)
    if fields is None:
        return _bad()
    if mac:
        if "voice" in fields:
            await run_in_threadpool(_write_mac_voice, fields["voice"])
        if fields.get("download") == "start":
            download.start()
        elif fields.get("download") == "cancel":
            download.cancel()
        return await run_in_threadpool(_mac_picture)
    user_id = require_user(request)
    return await run_in_threadpool(_web_apply, user_id, fields)


@router.put("/key/step")
async def step_key(request: Request):
    # Undo or Redo of a key step (12): the key comes back from the server's own copy and
    # never travels; a key changed since refuses it.
    if local_user():
        return JSONResponse({"error": "not-found"}, status_code=404)
    body = keysteps.valid_move(await _body(request))
    if body is None:
        return _bad()
    user_id = require_user(request)
    picture = await run_in_threadpool(_web_move, user_id, body)
    return picture if picture is not None else {"error": "changed"}


@router.put("/key/forget")
async def forget_key(request: Request):
    if local_user():
        return JSONResponse({"error": "not-found"}, status_code=404)
    body = await _body(request)
    if not isinstance(body, dict) or set(body) != {"step"} or not keysteps.valid_step(body["step"]):
        return _bad()
    user_id = require_user(request)
    await run_in_threadpool(_web_forget, user_id, body["step"])
    return {"ok": True}


def _answer(audio: bytes, mime: str, words: list[dict]) -> dict:
    return {"mime": mime, "audio": base64.b64encode(audio).decode(), "words": words}


def _speak_mac(text: str) -> dict:
    voice = _mac_voice()
    if voice == TEST["id"]:
        return _answer(*_test(text))
    if not download.ready():
        return {"error": "not-downloaded"}
    try:
        audio, words = kokoro_engine.speak(text, voice, download.model(), download.voices())
    except Exception as error:  # noqa: BLE001 - any failure of the model is unavailable
        _log.warning("voice: Kokoro could not read a paragraph: %s", type(error).__name__)
        return {"error": "unavailable"}
    return _answer(audio, "audio/wav", words)


def _speak_web(user_id: str, text: str) -> dict:
    with _connect(user_id) as connection:
        voice, key = _web_voice(connection), _key(connection)
    if voice == TEST["id"]:
        return _answer(*_test(text))
    if not key:
        return {"error": "no-key"}
    try:
        audio, words = inworld_adapter.speak(key, voice, text)
    except inworld_adapter.Refused as refused:
        return {"error": refused.code}
    return _answer(audio, inworld_adapter.MIME, words)


def _test(text: str) -> tuple[bytes, str, list[dict]]:
    audio, words = timing.test_voice(text)
    return audio, "audio/wav", words


@router.post("/speak")
async def speak(request: Request):
    body = await _body(request)
    if not isinstance(body, dict) or set(body) != {"text"} or not isinstance(body["text"], str):
        return _bad()
    text = body["text"]
    if not text.strip() or len(text) > _MAX_TEXT:
        return _bad()
    if local_user():
        return await run_in_threadpool(_speak_mac, text)
    user_id = current_user(request)
    if not user_id:
        return {"error": "signed-out"}
    return await run_in_threadpool(_speak_web, user_id, text)
