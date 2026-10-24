"""values' server module (architecture.md 5): the far end of the replicated values fact.
Every route needs a signed-in user (require_user) and resolves that user's own SQLite
file, so isolation holds by construction and the code reads as if for a single user. A
record is one day's version of the values, keyed by the day. version is assigned here.
The last write wins, so a write is never refused for a stale base, and nothing is
deleted. Which day may still be written is the browser's to decide, since only it knows
the user's local date.
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

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "values.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _is_value(value) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"id", "name", "meaning"}
        and isinstance(value["id"], str)
        and bool(_ULID.match(value["id"]))
        and isinstance(value["name"], str)
        and isinstance(value["meaning"], str)
    )


def _record(row: sqlite3.Row) -> dict:
    return {"day": row["day"], "values": json.loads(row["list"]), "version": row["version"]}


def _next_seq(connection: sqlite3.Connection) -> int:
    return connection.execute("SELECT COALESCE(MAX(seq), 0) FROM versions").fetchone()[0] + 1


@router.put("/{day}")
async def put_version(day: str, request: Request, user_id: str = Depends(require_user)):
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not (_DAY.match(day) and isinstance(payload, dict)):
        return JSONResponse(_BAD, status_code=400)
    values, base = payload.get("values"), payload.get("baseVersion")
    valid = (
        isinstance(values, list)
        and all(_is_value(value) for value in values)
        and (base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1))
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    listed = json.dumps([{"id": v["id"], "name": v["name"], "meaning": v["meaning"]} for v in values])
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM versions WHERE day = ?", (day,)).fetchone()
        if row is None:
            # A new day is an idempotent upsert (5): it continues from the base the client
            # held, or 1, so a version written signed out arrives with its history.
            connection.execute(
                "INSERT INTO versions (day, list, version, seq) VALUES (?, ?, ?, ?)",
                (day, listed, (base or 0) + 1, _next_seq(connection)),
            )
        elif row["list"] != listed:
            connection.execute(
                "UPDATE versions SET list = ?, version = ?, seq = ? WHERE day = ?",
                (listed, row["version"] + 1, _next_seq(connection), day),
            )
        # What the server already holds is not a change: no new version and no new seq,
        # so a resend of a write already applied is harmless.
        return _record(connection.execute("SELECT * FROM versions WHERE day = ?", (day,)).fetchone())


@router.get("")
def list_versions(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM versions WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = rows[-1]["seq"] if rows else after
    return {"versions": [_record(row) for row in rows], "cursor": cursor}
