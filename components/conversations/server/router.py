"""conversations' server module (architecture.md 5, 3.1): the far end of the
remote-only chats fact. Every route needs a signed-in user (require_user) and resolves
that user's own SQLite file, so isolation holds by construction. A chat cannot be made
offline, so there is no version and no conflict: a finished turn is added by id and
never rewritten (5), while the chat row, a delete and the tool preferences are last
write wins.
"""

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from server.user import require_user, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


# `with connection:` alone leaves the handle open until the cycle collector runs; on
# Python 3.14 the server ran out of file descriptors that way (books/server/router.py),
# so the block closes the connection when it ends, keeping one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "conversations.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _tools(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT body FROM tools WHERE one = 1").fetchone()
    return json.loads(row["body"]) if row else {"tools": {}, "approval": "auto"}


@router.get("")
def list_conversations(user_id: str = Depends(require_user)):
    # Headings only, newest first (12); the turns are read one chat at a time. pending
    # is browser-only (it depends on the outbox), so it is not returned here.
    with _connect(user_id) as connection:
        rows = connection.execute(
            "SELECT id, title, about, updated_at FROM conversations ORDER BY updated_at DESC, id DESC"
        ).fetchall()
        tools = _tools(connection)
    conversations = [
        {"id": row["id"], "title": row["title"], "about": json.loads(row["about"]), "updatedAt": row["updated_at"]}
        for row in rows
    ]
    return {"conversations": conversations, "tools": tools}


@router.put("/tools")
async def save_tools(request: Request, user_id: str = Depends(require_user)):
    # One value per account, last write wins (7.7): the single row is upserted.
    payload = await request.json()
    value = {"tools": payload.get("tools") or {}, "approval": payload.get("approval") or "auto"}
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        connection.execute(
            "INSERT INTO tools (one, body, at) VALUES (1, ?, ?)"
            " ON CONFLICT(one) DO UPDATE SET body = excluded.body, at = excluded.at",
            (json.dumps(value), now),
        )
    return value


@router.get("/{conversation_id}")
def read_conversation(conversation_id: str, user_id: str = Depends(require_user)):
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404)
        turns = connection.execute(
            "SELECT body FROM turns WHERE conversation_id = ? ORDER BY id", (conversation_id,)
        ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "about": json.loads(row["about"]),
        "start": row["start"],
        "turns": [json.loads(turn["body"]) for turn in turns],
        "updatedAt": row["updated_at"],
    }


@router.put("/{conversation_id}")
async def save_conversation(conversation_id: str, request: Request, user_id: str = Depends(require_user)):
    # Upsert the row and add each finished turn by id (5): a turn already stored is left
    # alone, so a resend or a retry is harmless and a turn is never rewritten. start is
    # written once, when the row is created (12). updated_at bumps only when something
    # actually changed, so a pure resend does not reorder the list.
    payload = await request.json()
    title = str(payload.get("title", ""))
    about = payload.get("about") or []
    start = str(payload.get("start", ""))
    turns = payload.get("turns") or []
    about_json = json.dumps(about)
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        changed = False
        if row is None:
            connection.execute(
                "INSERT INTO conversations (id, title, about, start, updated_at) VALUES (?, ?, ?, ?, ?)",
                (conversation_id, title, about_json, start, now),
            )
            changed = True
        elif row["title"] != title or json.loads(row["about"]) != about:
            connection.execute(
                "UPDATE conversations SET title = ?, about = ? WHERE id = ?", (title, about_json, conversation_id)
            )
            changed = True
        for turn in turns:
            cursor = connection.execute(
                "INSERT OR IGNORE INTO turns (id, conversation_id, body) VALUES (?, ?, ?)",
                (turn["id"], conversation_id, json.dumps(turn)),
            )
            if cursor.rowcount > 0:
                changed = True
        if changed:
            connection.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conversation_id))
            updated_at = now
        else:
            updated_at = row["updated_at"]
    return {"updatedAt": updated_at}


@router.delete("/{conversation_id}")
def delete_conversation(conversation_id: str, user_id: str = Depends(require_user)):
    # A delete removes the chat and its turns (5); it is idempotent, so deleting a chat
    # that is already gone is not an error.
    with _connect(user_id) as connection:
        connection.execute("DELETE FROM turns WHERE conversation_id = ?", (conversation_id,))
        connection.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    return {"deleted": conversation_id}
