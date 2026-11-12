"""matrices' server module (architecture.md 5): the far end of the replicated matrices fact.
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
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from server.user import require_user, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

_ULID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_DAY = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_PLACES = ("do", "schedule", "delegate", "drop")
_TASK_KEYS = {"id", "text", "place", "done", "suggested"}

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "matrices.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _is_id(value) -> bool:
    return isinstance(value, str) and bool(_ULID.match(value))


def _is_day(value) -> bool:
    return isinstance(value, str) and bool(_DAY.match(value))


def _is_suggested(value) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"place", "sure"}
        and value["place"] in _PLACES
        and isinstance(value["sure"], bool)
    )


def _is_task(value) -> bool:
    return (
        isinstance(value, dict)
        and {"id", "text", "place", "done"} <= set(value) <= _TASK_KEYS
        and _is_id(value["id"])
        and isinstance(value["text"], str)
        and (value["place"] is None or value["place"] in _PLACES)
        and isinstance(value["done"], bool)
        and ("suggested" not in value or _is_suggested(value["suggested"]))
    )


def _are_tasks(value) -> bool:
    return (
        isinstance(value, list)
        and all(_is_task(task) for task in value)
        and len({task["id"] for task in value}) == len(value)
    )


# One form for what a write brought and what a row holds, so comparing them finds only a
# real change. What cannot be read counts as no task, so one bad row cannot fail a pull.
def _clean_tasks(value) -> list[dict]:
    tasks = value if isinstance(value, list) else []
    cleaned = []
    for task in tasks:
        if not _is_task(task):
            continue
        out = {"id": task["id"], "text": task["text"], "place": task["place"], "done": task["done"]}
        if "suggested" in task:
            out["suggested"] = {"place": task["suggested"]["place"], "sure": task["suggested"]["sure"]}
        cleaned.append(out)
    return cleaned


def _stored_tasks(text: str | None) -> list[dict]:
    try:
        return _clean_tasks(json.loads(text) if text else None)
    except ValueError:
        return []


def _record(row: sqlite3.Row) -> dict:
    record = {
        "id": row["id"],
        "day": row["day"],
        "tasks": _stored_tasks(row["tasks"]),
        "createdAt": row["created_at"],
        "version": row["version"],
        "deleted": bool(row["deleted"]),
    }
    if row["from_day"]:
        record["from"] = row["from_day"]
    return record


def _next_seq(connection: sqlite3.Connection) -> int:
    return connection.execute("SELECT COALESCE(MAX(seq), 0) FROM matrices").fetchone()[0] + 1


def _reread(connection: sqlite3.Connection, matrix_id: str) -> dict:
    return _record(connection.execute("SELECT * FROM matrices WHERE id = ?", (matrix_id,)).fetchone())


def _is_time(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


@router.put("/{matrix_id}")
async def put_matrix(matrix_id: str, request: Request, user_id: str = Depends(require_user)):
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not (_is_id(matrix_id) and isinstance(payload, dict)):
        return JSONResponse(_BAD, status_code=400)
    day, base, deleted = payload.get("day"), payload.get("baseVersion"), payload.get("deleted", False)
    tasks, source, created = payload.get("tasks"), payload.get("from"), payload.get("createdAt")
    valid = (
        _is_day(day)
        and _are_tasks(tasks)
        and (source is None or _is_day(source))
        and (created is None or _is_time(created))
        and (base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1))
        and isinstance(deleted, bool)
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    tasks = _clean_tasks(tasks)
    stored = json.dumps(tasks)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM matrices WHERE id = ?", (matrix_id,)).fetchone()
        if row is None:
            # A new id is an idempotent upsert of the browser's own ULID (5): it continues
            # from the base the client held, or 1, so a matrix made signed out arrives with
            # its history. A tombstone can be born here, for one deleted before upload.
            now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            connection.execute(
                "INSERT INTO matrices (id, day, from_day, tasks, created_at, version, seq, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (matrix_id, day, source, stored, created or now, (base or 0) + 1, _next_seq(connection), int(deleted)),
            )
            return _reread(connection, matrix_id)
        # A restore write (5, Undo in 12) names the tombstone's own version as its base and
        # brings the matrix back as a new version. Any other write onto a tombstone, or a
        # second delete, returns the tombstone unchanged.
        if row["deleted"]:
            if not deleted and base == row["version"]:
                connection.execute(
                    "UPDATE matrices SET tasks = ?, version = ?, seq = ?, deleted = 0 WHERE id = ?",
                    (stored, row["version"] + 1, _next_seq(connection), matrix_id),
                )
                return _reread(connection, matrix_id)
            return _record(row)
        # What the server already holds is not a change: no new version and no new seq,
        # so a resend of a write already applied is harmless.
        if not deleted and _stored_tasks(row["tasks"]) == tasks:
            return _record(row)
        connection.execute(
            "UPDATE matrices SET tasks = ?, version = ?, seq = ?, deleted = ? WHERE id = ?",
            (stored, row["version"] + 1, _next_seq(connection), int(deleted), matrix_id),
        )
        return _reread(connection, matrix_id)


@router.get("")
def list_matrices(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM matrices WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = rows[-1]["seq"] if rows else after
    return {"matrices": [_record(row) for row in rows], "cursor": cursor}
