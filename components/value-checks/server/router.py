"""value-checks' server module (architecture.md 5): the far end of the replicated
value-checks fact. Every route needs a signed-in user (require_user) and resolves that
user's own SQLite file, so isolation holds by construction and the code reads as if for a
single user. The settings are last write wins: a write is never refused for a stale base,
and version is assigned here. An answer is added under its key and never changed: a key
the server already holds keeps its first answer, which is returned so the browser adopts
it.

A body is validated against the component's own event schemas: the settings as
value-checks.changed carries them, the answers as values.checked carries a line's.
"""

import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from jsonschema import Draft202012Validator

from server.user import require_user, user_dir

router = APIRouter()

_HERE = Path(__file__).parent
_SCHEMA = (_HERE / "schema.sql").read_text()

_KEY = re.compile(r"^[0-9a-f]{28}$")
# The settings are one row, under this key.
_ROW = "settings"

_changed = json.loads((_HERE.parent / "events" / "value-checks.changed.json").read_text())
_checked = json.loads((_HERE.parent / "events" / "values.checked.json").read_text())
_SETTINGS = Draft202012Validator(_changed["properties"]["settings"])
_ANSWERS = Draft202012Validator(
    _checked["properties"]["values"]["items"]["properties"]["lines"]["items"]["properties"]["answers"]
)

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which can run the server out of file descriptors; closing when the block ends keeps one
# handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "value-checks.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _settings(row: sqlite3.Row) -> dict:
    return {"values": row["values_ev"], "examples": row["examples_ev"], "version": row["version"]}


def _answer(row: sqlite3.Row) -> dict:
    return {"key": row["key"], "answers": json.loads(row["answers"])}


def _next_seq(connection: sqlite3.Connection) -> int:
    return (
        connection.execute(
            "SELECT MAX(COALESCE((SELECT MAX(seq) FROM settings), 0), COALESCE((SELECT MAX(seq) FROM answers), 0))"
        ).fetchone()[0]
        + 1
    )


async def _body(request: Request):
    try:
        return await request.json()
    except ValueError:
        return None


@router.put("/settings")
async def put_settings(request: Request, user_id: str = Depends(require_user)):
    payload = await _body(request)
    # Both lines are named, null for none, so a body that leaves one out is not read as Not checked.
    if not isinstance(payload, dict) or "values" not in payload or "examples" not in payload:
        return JSONResponse(_BAD, status_code=400)
    base = payload.get("baseVersion")
    settings = {"values": payload.get("values"), "examples": payload.get("examples")}
    valid = _SETTINGS.is_valid(settings) and (
        base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1)
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM settings WHERE key = ?", (_ROW,)).fetchone()
        if row is None:
            # A first write continues from the base the client held, or 1, so settings
            # made signed out arrive with their history.
            connection.execute(
                "INSERT INTO settings (key, values_ev, examples_ev, version, seq) VALUES (?, ?, ?, ?, ?)",
                (_ROW, settings["values"], settings["examples"], (base or 0) + 1, _next_seq(connection)),
            )
        elif (row["values_ev"], row["examples_ev"]) != (settings["values"], settings["examples"]):
            connection.execute(
                "UPDATE settings SET values_ev = ?, examples_ev = ?, version = ?, seq = ? WHERE key = ?",
                (settings["values"], settings["examples"], row["version"] + 1, _next_seq(connection), _ROW),
            )
        # What the server already holds is not a change: no new version and no new seq.
        return _settings(connection.execute("SELECT * FROM settings WHERE key = ?", (_ROW,)).fetchone())


@router.put("/answers/{key}")
async def put_answer(key: str, request: Request, user_id: str = Depends(require_user)):
    payload = await _body(request)
    if not (_KEY.match(key) and isinstance(payload, dict) and _ANSWERS.is_valid(payload.get("answers"))):
        return JSONResponse(_BAD, status_code=400)
    with _connect(user_id) as connection:
        connection.execute(
            "INSERT OR IGNORE INTO answers (key, answers, seq) VALUES (?, ?, ?)",
            (key, json.dumps(payload["answers"], separators=(",", ":")), _next_seq(connection)),
        )
        return _answer(connection.execute("SELECT * FROM answers WHERE key = ?", (key,)).fetchone())


@router.get("")
def pull(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        settings = connection.execute("SELECT * FROM settings WHERE key = ? AND seq > ?", (_ROW, after)).fetchone()
        answers = connection.execute("SELECT * FROM answers WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = max([after, *([settings["seq"]] if settings else []), *(r["seq"] for r in answers)])
    return {
        "settings": _settings(settings) if settings else None,
        "answers": [_answer(r) for r in answers],
        "cursor": cursor,
    }
