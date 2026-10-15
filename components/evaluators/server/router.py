"""evaluators' server module (architecture.md 5): the far end of the replicated
evaluators fact. Every route needs a signed-in user (require_user) and resolves that
user's own SQLite file, so isolation holds by construction and the code reads as if for
a single user. version is assigned here. The last write wins, so a write is never
refused for a stale base; a delete always wins (5), so a write onto a tombstone comes
back as the tombstone rather than reviving it.
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

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "evaluators.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    # CREATE IF NOT EXISTS never adds a column to an existing table, so a db from before
    # "Show in journal" is migrated here.
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(evaluators)")}
    if "journal" not in columns:
        connection.executescript("ALTER TABLE evaluators ADD COLUMN journal INTEGER NOT NULL DEFAULT 0")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _is_id(value) -> bool:
    return isinstance(value, str) and bool(_ULID.match(value))


def _record(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "book": row["book"],
        "name": row["name"],
        "on": bool(row["on"]),
        "journal": bool(row["journal"]),
        "questions": json.loads(row["questions"]),
        "version": row["version"],
        "deleted": bool(row["deleted"]),
    }


def _next_seq(connection: sqlite3.Connection) -> int:
    return connection.execute("SELECT COALESCE(MAX(seq), 0) FROM evaluators").fetchone()[0] + 1


def _reread(connection: sqlite3.Connection, evaluator_id: str) -> dict:
    return _record(connection.execute("SELECT * FROM evaluators WHERE id = ?", (evaluator_id,)).fetchone())


@router.put("/{evaluator_id}")
async def put_evaluator(evaluator_id: str, request: Request, user_id: str = Depends(require_user)):
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not (_is_id(evaluator_id) and isinstance(payload, dict)):
        return JSONResponse(_BAD, status_code=400)
    book, name, on = payload.get("book"), payload.get("name"), payload.get("on")
    questions, base, deleted = payload.get("questions"), payload.get("baseVersion"), payload.get("deleted", False)
    journal = payload.get("journal")
    valid = (
        _is_id(book)
        and isinstance(name, str)
        and isinstance(on, bool)
        and isinstance(questions, list)
        and all(isinstance(q, dict) for q in questions)
        and (base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1))
        and isinstance(deleted, bool)
        and (journal is None or isinstance(journal, bool))
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    stored = json.dumps(questions)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM evaluators WHERE id = ?", (evaluator_id,)).fetchone()
        if row is None:
            # A new id is an idempotent upsert of the browser's own ULID (5): it continues
            # from the base the client held, or 1, so an evaluator made signed out arrives
            # with its history. A tombstone can be born here, for one deleted before upload.
            connection.execute(
                'INSERT INTO evaluators (id, book, name, "on", journal, questions, version, seq, deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (evaluator_id, book, name, int(on), int(bool(journal)), stored, (base or 0) + 1, _next_seq(connection), int(deleted)),
            )
            return _reread(connection, evaluator_id)
        # A write onto a tombstone, or a second delete, returns the tombstone unchanged.
        if row["deleted"]:
            return _record(row)
        # A write from a browser that predates "Show in journal" leaves it out and keeps it.
        shown = row["journal"] if journal is None else int(journal)
        # What the server already holds is not a change: no new version and no new seq,
        # so a resend of a write already applied is harmless.
        if not deleted and (name, int(on), shown, stored) == (row["name"], row["on"], row["journal"], row["questions"]):
            return _record(row)
        connection.execute(
            'UPDATE evaluators SET name = ?, "on" = ?, journal = ?, questions = ?, version = ?, seq = ?, deleted = ? WHERE id = ?',
            (name, int(on), shown, stored, row["version"] + 1, _next_seq(connection), int(deleted), evaluator_id),
        )
        return _reread(connection, evaluator_id)


@router.get("")
def list_evaluators(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM evaluators WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = rows[-1]["seq"] if rows else after
    return {"evaluators": [_record(row) for row in rows], "cursor": cursor}
