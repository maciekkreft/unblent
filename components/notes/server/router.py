"""notes' server module (architecture.md 5): the far end of the replicated notes
fact. Every route needs a signed-in user (require_user) and resolves that user's
own SQLite file, so isolation holds by construction and the code reads as if for a
single user. version is assigned here; a stale base is rejected as a conflict (5)
rather than silently overwritten.
"""

import sqlite3
import time
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from server.user import require_user, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


def _connect(user_id: str) -> sqlite3.Connection:
    connection = sqlite3.connect(user_dir(user_id) / "notes.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    return connection


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
    }


@router.put("/{note_id}")
async def put_note(note_id: str, request: Request, user_id: str = Depends(require_user)):
    payload = await request.json()
    title = payload.get("title", "")
    body = payload.get("body", "")
    base = payload.get("baseVersion")
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if row is None:
            # A new id is an idempotent upsert of the browser's own ULID (5), not a
            # conflict: it continues from the base the client held, or 1.
            version = (base or 0) + 1
            connection.execute(
                "INSERT INTO notes (id, title, body, version, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)",
                (note_id, title, body, version, now, _next_seq(connection)),
            )
            return {"id": note_id, "title": title, "body": body, "version": version, "updatedAt": now}
        # A write must state the version it was based on (5): a mismatch is a
        # conflict carrying the server's copy, so a view can show both.
        if base != row["version"]:
            return JSONResponse({"note": _record(row)}, status_code=409)
        # The same text on the right base is not a change (5, idempotent writes): the
        # current record comes back, no new version, no bump of seq.
        if title == row["title"] and body == row["body"]:
            return _record(row)
        version = row["version"] + 1
        connection.execute(
            "UPDATE notes SET title = ?, body = ?, version = ?, updated_at = ?, seq = ? WHERE id = ?",
            (title, body, version, now, _next_seq(connection), note_id),
        )
        return {"id": note_id, "title": title, "body": body, "version": version, "updatedAt": now}


@router.get("")
def list_notes(since: int = 0, user_id: str = Depends(require_user)):
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM notes WHERE seq > ? ORDER BY seq", (since,)).fetchall()
    cursor = rows[-1]["seq"] if rows else since
    return {"notes": [_record(row) for row in rows], "cursor": cursor}
