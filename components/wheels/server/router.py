"""wheels' server module (architecture.md 5): the far end of the replicated wheels fact.
Every route needs a signed-in user (require_user) and resolves that user's own SQLite
file, so isolation holds by construction and the code reads as if for a single user.
version is assigned here. The last write wins, so a write is never refused for a stale
base; a delete always wins (5), so a write onto a tombstone comes back as the tombstone
rather than reviving it, except a restore write, which names the tombstone's own version.
"""

import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from server.user import require_user, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

_ULID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_DAY = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_AREAS = 8
_QUESTIONS = ("one", "ten", "lower", "higher", "closer")

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "wheels.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    # schema.sql is replayed per connect, but CREATE IF NOT EXISTS never adds a column to
    # an existing table, so a db from before answers is migrated here (5).
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(wheels)")}
    if "answers" not in columns:
        connection.executescript("ALTER TABLE wheels ADD COLUMN answers TEXT")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _is_id(value) -> bool:
    return isinstance(value, str) and bool(_ULID.match(value))


def _is_score(value) -> bool:
    if value is None:
        return True
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 10


def _are_scores(value) -> bool:
    return isinstance(value, list) and len(value) == _AREAS and all(_is_score(score) for score in value)


def _are_answers(value) -> bool:
    return (
        isinstance(value, list)
        and len(value) == _AREAS
        and all(
            isinstance(area, dict)
            and all(question in _QUESTIONS and isinstance(text, str) for question, text in area.items())
            for area in value
        )
    )


# One form for what a write brought and what a row holds, so comparing them finds only a
# real change. What cannot be read counts as no answer, so one bad row cannot fail a pull.
def _clean_answers(value) -> list[dict]:
    areas = value if isinstance(value, list) else []
    cleaned = []
    for i in range(_AREAS):
        area = areas[i] if i < len(areas) and isinstance(areas[i], dict) else {}
        cleaned.append({q: area[q] for q in _QUESTIONS if isinstance(area.get(q), str) and area[q]})
    return cleaned


def _stored_answers(text: str | None) -> list[dict]:
    try:
        return _clean_answers(json.loads(text) if text else None)
    except ValueError:
        return _clean_answers(None)


def _record(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "day": row["day"],
        "actual": json.loads(row["actual"]),
        "wanted": json.loads(row["wanted"]),
        "answers": _stored_answers(row["answers"]),
        "version": row["version"],
        "deleted": bool(row["deleted"]),
    }


def _next_seq(connection: sqlite3.Connection) -> int:
    return connection.execute("SELECT COALESCE(MAX(seq), 0) FROM wheels").fetchone()[0] + 1


def _reread(connection: sqlite3.Connection, wheel_id: str) -> dict:
    return _record(connection.execute("SELECT * FROM wheels WHERE id = ?", (wheel_id,)).fetchone())


@router.put("/{wheel_id}")
async def put_wheel(wheel_id: str, request: Request, user_id: str = Depends(require_user)):
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not (_is_id(wheel_id) and isinstance(payload, dict)):
        return JSONResponse(_BAD, status_code=400)
    day, base, deleted = payload.get("day"), payload.get("baseVersion"), payload.get("deleted", False)
    actual, wanted = payload.get("actual"), payload.get("wanted")
    valid = (
        isinstance(day, str)
        and bool(_DAY.match(day))
        and _are_scores(actual)
        and _are_scores(wanted)
        and (base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1))
        and isinstance(deleted, bool)
        and ("answers" not in payload or _are_answers(payload["answers"]))
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    scores = (json.dumps(actual), json.dumps(wanted))
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM wheels WHERE id = ?", (wheel_id,)).fetchone()
        # A write without answers keeps what is held: an outbox row or a Mac from before
        # answers must not erase those written elsewhere.
        held = _stored_answers(row["answers"] if row else None)
        answers = _clean_answers(payload["answers"]) if "answers" in payload else held
        if row is None:
            # A new id is an idempotent upsert of the browser's own ULID (5): it continues
            # from the base the client held, or 1, so a wheel made signed out arrives with
            # its history. A tombstone can be born here, for one deleted before upload.
            connection.execute(
                "INSERT INTO wheels (id, day, actual, wanted, answers, version, seq, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (wheel_id, day, *scores, json.dumps(answers), (base or 0) + 1, _next_seq(connection), int(deleted)),
            )
            return _reread(connection, wheel_id)
        # A restore write (5, Undo in 12) names the tombstone's own version as its base and
        # brings the wheel back as a new version. Any other write onto a tombstone, or a
        # second delete, returns the tombstone unchanged.
        if row["deleted"]:
            if not deleted and base == row["version"]:
                connection.execute(
                    "UPDATE wheels SET actual = ?, wanted = ?, answers = ?, version = ?, seq = ?, deleted = 0 WHERE id = ?",
                    (*scores, json.dumps(answers), row["version"] + 1, _next_seq(connection), wheel_id),
                )
                return _reread(connection, wheel_id)
            return _record(row)
        # What the server already holds is not a change: no new version and no new seq,
        # so a resend of a write already applied is harmless.
        if not deleted and json.loads(row["actual"]) == actual and json.loads(row["wanted"]) == wanted and held == answers:
            return _record(row)
        connection.execute(
            "UPDATE wheels SET actual = ?, wanted = ?, answers = ?, version = ?, seq = ?, deleted = ? WHERE id = ?",
            (*scores, json.dumps(answers), row["version"] + 1, _next_seq(connection), int(deleted), wheel_id),
        )
        return _reread(connection, wheel_id)


@router.get("")
def list_wheels(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM wheels WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = rows[-1]["seq"] if rows else after
    return {"wheels": [_record(row) for row in rows], "cursor": cursor}
