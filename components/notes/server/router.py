"""notes' server module (architecture.md 5): the far end of the replicated notes
fact. Every route needs a signed-in user (require_user) and resolves that user's
own SQLite file, so isolation holds by construction and the code reads as if for a
single user. version is assigned here; a stale base is rejected as a conflict (5)
rather than silently overwritten.
"""

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from server.user import require_user, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


# `with connection:` alone commits or rolls back and leaves the handle open, to be
# closed only when the interpreter's cycle collector gets to it (a cursor and its rows
# keep the connection in a cycle); on Python 3.14 the server ran out of file
# descriptors that way. Closing when the block ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "notes.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    # schema.sql is replayed per connect, but CREATE IF NOT EXISTS never adds a column
    # to an existing table, so a db from before tombstones is migrated here (5).
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(notes)")}
    if "deleted" not in columns:
        connection.executescript("ALTER TABLE notes ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
    if "about" not in columns:
        connection.executescript("ALTER TABLE notes ADD COLUMN about TEXT NOT NULL DEFAULT '[]'")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _next_seq(connection: sqlite3.Connection) -> int:
    # Per-db monotonic order for the pull cursor: a fresh db starts at 1.
    return connection.execute("SELECT COALESCE(MAX(seq), 0) FROM notes").fetchone()[0] + 1


def _record(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "body": row["body"],
        "version": row["version"],
        "updatedAt": row["updated_at"],
        "deleted": bool(row["deleted"]),
        "about": json.loads(row["about"]),
    }


def _reread(connection: sqlite3.Connection, note_id: str) -> dict:
    # The written row read back, so a reply always carries the full record (deleted
    # included) from one place rather than reassembling it at each write site.
    return _record(connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone())


@router.put("/{note_id}")
async def put_note(note_id: str, request: Request, user_id: str = Depends(require_user)):
    payload = await request.json()
    title = payload.get("title", "")
    body = payload.get("body", "")
    base = payload.get("baseVersion")
    deleted = bool(payload.get("deleted", False))
    # about absent leaves the stored links unchanged (D2); present replaces them.
    about = payload.get("about")
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if row is None:
            # A new id is an idempotent upsert of the browser's own ULID (5), not a
            # conflict: it continues from the base the client held, or 1. A tombstone
            # can be born here too, when an anonymous note deleted before its first
            # upload arrives already gone.
            version = (base or 0) + 1
            connection.execute(
                "INSERT INTO notes (id, title, body, version, updated_at, seq, deleted, about) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (note_id, title, body, version, now, _next_seq(connection), int(deleted), json.dumps(about if about is not None else [])),
            )
            return _reread(connection, note_id)
        # A delete always wins (5): it states no base and is not refused for a stale
        # one. A second delete is idempotent, returning the tombstone unchanged.
        if deleted:
            if row["deleted"]:
                return _record(row)
            version = row["version"] + 1
            connection.execute(
                "UPDATE notes SET title = ?, body = ?, version = ?, updated_at = ?, seq = ?, deleted = 1 WHERE id = ?",
                (title, body, version, now, _next_seq(connection), note_id),
            )
            return _reread(connection, note_id)
        # An edit onto a tombstone loses to the delete: the deletion is the newer fact,
        # so it comes back as a conflict carrying the tombstone (5), never a revival.
        if row["deleted"]:
            return JSONResponse({"note": _record(row)}, status_code=409)
        # A write must state the version it was based on (5): a mismatch is a
        # conflict carrying the server's copy, so a view can show both.
        if base != row["version"]:
            return JSONResponse({"note": _record(row)}, status_code=409)
        # The same text and the same links on the right base is not a change (5,
        # idempotent writes): the current record comes back, no new version, no bump of
        # seq. about absent means the links are unchanged (D2).
        existing_about = json.loads(row["about"])
        effective_about = about if about is not None else existing_about
        if title == row["title"] and body == row["body"] and effective_about == existing_about:
            return _record(row)
        version = row["version"] + 1
        connection.execute(
            "UPDATE notes SET title = ?, body = ?, version = ?, updated_at = ?, seq = ?, about = ? WHERE id = ?",
            (title, body, version, now, _next_seq(connection), json.dumps(effective_about), note_id),
        )
        return _reread(connection, note_id)


@router.get("")
def list_notes(since: int = 0, user_id: str = Depends(require_user)):
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM notes WHERE seq > ? ORDER BY seq", (since,)).fetchall()
    cursor = rows[-1]["seq"] if rows else since
    return {"notes": [_record(row) for row in rows], "cursor": cursor}
