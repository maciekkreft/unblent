"""conversations' server module (architecture.md 5, 3.1): the far end of the
remote-only chats fact. Every route needs a signed-in user (require_user) and resolves
that user's own SQLite file, so isolation holds by construction. A chat cannot be made
offline, so there is no version and no conflict: a finished turn is added by id and
never rewritten (5), while the chat row, a delete and the tool preferences are last
write wins.
"""

import json
import re
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from server.user import require_user, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

# A chat's place in the list (5): a fractional-index key the browser computes
# (conversations/machine.js between), digits and letters, never ending in "0".
_POSITION = re.compile(r"[0-9A-Za-z]{0,199}[1-9A-Za-z]")


# `with connection:` alone leaves the handle open until the cycle collector runs; on
# Python 3.14 the server ran out of file descriptors that way (books/server/router.py),
# so the block closes the connection when it ends, keeping one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "conversations.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    # CREATE IF NOT EXISTS never adds a column to an existing table, so a file from
    # before comments on an answer is migrated here (notes/server/router.py does the same).
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(conversations)")}
    if "marks" not in columns:
        connection.executescript("ALTER TABLE conversations ADD COLUMN marks TEXT")
    if "position" not in columns:
        connection.executescript("ALTER TABLE conversations ADD COLUMN position TEXT")
    if "highlights" not in columns:
        connection.executescript("ALTER TABLE conversations ADD COLUMN highlights TEXT")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _save_highlights(connection: sqlite3.Connection, conversation_id: str, payload: dict) -> None:
    # The user's highlights on earlier answers are last write wins, and like a place they
    # are not news (5): updated_at stays, so highlighting an old answer never moves the chat
    # or makes it the latest about its subject. A body without the key leaves them; null or
    # an empty list clears them.
    if "highlights" not in payload:
        return
    highlights = payload["highlights"] or None
    connection.execute(
        "UPDATE conversations SET highlights = ? WHERE id = ?",
        (json.dumps(highlights) if highlights is not None else None, conversation_id),
    )


def _tools(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT body FROM tools WHERE one = 1").fetchone()
    return json.loads(row["body"]) if row else {"tools": {}, "approval": "auto"}


@router.get("")
def list_conversations(user_id: str = Depends(require_user)):
    # Headings only, newest first (12), each with its place when it has one (the browser
    # orders by place, 5); the turns are read one chat at a time. pending
    # is browser-only (it depends on the outbox), so it is not returned here. answer is
    # the start of the latest answer that has text, cut to size: the browser derives the
    # row's second line from it, so that rule lives in one place (machine.js subtitleOf).
    with _connect(user_id) as connection:
        rows = connection.execute(
            """
            SELECT c.id, c.title, c.about, c.updated_at, c.position,
                   (SELECT substr(ltrim(json_extract(t.body, '$.text'), char(9, 10, 13, 32)), 1, 400)
                      FROM turns t
                     WHERE t.conversation_id = c.id
                       AND json_extract(t.body, '$.role') = 'assistant'
                       AND trim(json_extract(t.body, '$.text'), char(9, 10, 13, 32)) <> ''
                     ORDER BY t.id DESC LIMIT 1) AS answer
              FROM conversations c
             ORDER BY c.updated_at DESC, c.id DESC
            """
        ).fetchall()
        tools = _tools(connection)
    conversations = [
        {
            "id": row["id"],
            "title": row["title"],
            "about": json.loads(row["about"]),
            "updatedAt": row["updated_at"],
            "answer": row["answer"] or "",
            **({"position": row["position"]} if row["position"] is not None else {}),
        }
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
        # Turns sort by when they were saved, not by id: a question is always saved
        # before its answer, so save order is the true order, while two turns minted in
        # the same millisecond by different components (the input box and this fact) can
        # have ids that sort the wrong way.
        turns = connection.execute(
            "SELECT body FROM turns WHERE conversation_id = ? ORDER BY rowid", (conversation_id,)
        ).fetchall()
    conversation = {
        "id": row["id"],
        "title": row["title"],
        "about": json.loads(row["about"]),
        "start": row["start"],
        "turns": [json.loads(turn["body"]) for turn in turns],
        "updatedAt": row["updated_at"],
    }
    if row["position"] is not None:
        conversation["position"] = row["position"]
    # Absent rather than null when there are none, so the reply keeps to read.json.
    if row["marks"] is not None:
        conversation["marks"] = json.loads(row["marks"])
    if row["highlights"] is not None:
        conversation["highlights"] = json.loads(row["highlights"])
    return conversation


@router.put("/{conversation_id}")
async def save_conversation(conversation_id: str, request: Request, user_id: str = Depends(require_user)):
    # Upsert the row and add each finished turn by id (5): a turn already stored is left
    # alone, so a resend or a retry is harmless and a turn is never rewritten. start is
    # written once, when the row is created (12). updated_at bumps only when something
    # actually changed, so a pure resend does not reorder the list. marks, the unsent
    # comments on the last answer, are last write wins like the title; a body without
    # the key leaves them as they are, and null clears them.
    payload = await request.json()
    # A place is last write wins (5): saved whatever else the body holds, and it does not
    # bump updated_at, so a move never reads as news. A body without a title only moves
    # the chat or sets its highlights; for a chat the server does not have, there is nothing to change.
    position = payload.get("position")
    if position is not None and not (isinstance(position, str) and _POSITION.fullmatch(position)):
        return JSONResponse({"error": "invalid-position"}, status_code=422)
    # A rename (a generator's title or the user's) and a relink (the chat's chapter label)
    # are last write wins like a place: each writes the title and the links only when the
    # body carries them, so a chat never loses its links to a rename nor its title to a
    # relink, and like a move neither is news, so updated_at stays.
    if payload.get("rename") is True:
        with _connect(user_id) as connection:
            row = connection.execute("SELECT updated_at FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if row is None:
                return {"missing": True}
            if "title" in payload:
                connection.execute(
                    "UPDATE conversations SET title = ? WHERE id = ?", (str(payload["title"]), conversation_id)
                )
            if isinstance(payload.get("about"), list):
                connection.execute(
                    "UPDATE conversations SET about = ? WHERE id = ?", (json.dumps(payload["about"]), conversation_id)
                )
        return {"updatedAt": row["updated_at"]}
    if "title" not in payload:
        with _connect(user_id) as connection:
            row = connection.execute("SELECT updated_at FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
            if row is None:
                return {"missing": True}
            if position is not None:
                connection.execute("UPDATE conversations SET position = ? WHERE id = ?", (position, conversation_id))
            _save_highlights(connection, conversation_id, payload)
        return {"updatedAt": row["updated_at"]}
    title = str(payload.get("title", ""))
    about = payload.get("about") or []
    start = str(payload.get("start", ""))
    turns = payload.get("turns") or []
    about_json = json.dumps(about)
    has_marks = "marks" in payload
    marks = payload.get("marks") or None
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        changed = False
        if row is None:
            connection.execute(
                "INSERT INTO conversations (id, title, about, start, updated_at, position) VALUES (?, ?, ?, ?, ?, ?)",
                (conversation_id, title, about_json, start, now, position),
            )
            changed = True
        elif row["title"] != title or json.loads(row["about"]) != about:
            connection.execute(
                "UPDATE conversations SET title = ?, about = ? WHERE id = ?", (title, about_json, conversation_id)
            )
            changed = True
        if row is not None and position is not None and row["position"] != position:
            connection.execute("UPDATE conversations SET position = ? WHERE id = ?", (position, conversation_id))
        stored_marks = json.loads(row["marks"]) if row is not None and row["marks"] is not None else None
        if has_marks and marks != stored_marks:
            connection.execute(
                "UPDATE conversations SET marks = ? WHERE id = ?",
                (json.dumps(marks) if marks is not None else None, conversation_id),
            )
            changed = True
        _save_highlights(connection, conversation_id, payload)
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
