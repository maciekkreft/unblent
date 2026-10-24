"""evaluators' server module (architecture.md 5): the far end of the replicated
evaluators fact. Every route needs a signed-in user (require_user) and resolves that
user's own SQLite file, so isolation holds by construction and the code reads as if for
a single user. version is assigned here. The last write wins, so a write is never
refused for a stale base; a delete always wins (5), so a write onto a tombstone comes
back as the tombstone rather than reviving it.

The admin's evaluators may be starters for try pages (8): starterFor names the pages.
Whenever the admin saves one, the shared file data/evaluators.db is rewritten with a
copy of every ticked one (5), and any visitor, account or not, reads a page's starters
from it.
"""

import json
import re
import sqlite3
from datetime import datetime, timezone
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from server.user import DATA, require_user, session_of, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
_STARTERS = (Path(__file__).parent / "starters.sql").read_text()

_ULID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")

# An evaluator's place in the list (5): a fractional-index key the browser computes
# (evaluators/machine.js between), digits and letters, never ending in "0".
_POSITION = re.compile(r"[0-9A-Za-z]{0,199}[1-9A-Za-z]")

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}
# The id books presents the journal under (5).
_JOURNAL = "00000000000000000000000JRN"


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
    # Rows written before updated_at keep NULL, which the editor ranks as the oldest.
    if "updated_at" not in columns:
        connection.executescript("ALTER TABLE evaluators ADD COLUMN updated_at TEXT")
    if "starter_for" not in columns:
        connection.executescript("ALTER TABLE evaluators ADD COLUMN starter_for TEXT NOT NULL DEFAULT '[]'")
    if "position" not in columns:
        connection.executescript("ALTER TABLE evaluators ADD COLUMN position TEXT")
    # "Show in journal" is gone and the journal lists only its own evaluators, so one
    # still ticked moves to the journal, with a new version and seq so every device pulls it.
    for (ticked,) in connection.execute("SELECT id FROM evaluators WHERE journal = 1").fetchall():
        connection.execute(
            "UPDATE evaluators SET book = ?, journal = 0, version = version + 1, seq = ? WHERE id = ?",
            (_JOURNAL, _next_seq(connection), ticked),
        )
    connection.commit()
    try:
        with connection:
            yield connection
    finally:
        connection.close()


@contextmanager
def _shared() -> Iterator[sqlite3.Connection]:
    DATA.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATA / "evaluators.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_STARTERS)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _publish(connection: sqlite3.Connection, user_id: str) -> None:
    """Rewrite the shared copy of the admin's starters (5) from the admin's own file.
    Rows are kept by whose they are, so the throwaway server's many forged admins do
    not undo one another; the product has one admin."""
    rows = connection.execute(
        "SELECT id, name, questions, starter_for FROM evaluators WHERE deleted = 0 AND starter_for != '[]' ORDER BY id"
    ).fetchall()
    with _shared() as shared:
        shared.execute("DELETE FROM starters WHERE owner = ?", (user_id,))
        shared.executemany(
            "INSERT INTO starters (owner, page, id, name, questions) VALUES (?, ?, ?, ?, ?)",
            [(user_id, page, row["id"], row["name"], row["questions"]) for row in rows for page in json.loads(row["starter_for"])],
        )


def _pages(value) -> list[str] | None:
    """starterFor as stored: each page once, in one order; None when it is not a list of names."""
    if not isinstance(value, list) or not all(isinstance(p, str) and p for p in value):
        return None
    return sorted(set(value))


def _is_time(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
        "updatedAt": row["updated_at"],
        "deleted": bool(row["deleted"]),
        "position": row["position"],
        # Only an evaluator that is a starter somewhere carries it, as on the bus.
        **({"starterFor": pages} if (pages := json.loads(row["starter_for"])) else {}),
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
    # A place is last write wins (5): it is saved whatever the base, bumps no version (so
    # the list's answers kept by what an evaluator asks stay), and bumps seq so a pull
    # brings it to other devices. A write without a name only moves the evaluator.
    position = payload.get("position")
    if position is not None and not (isinstance(position, str) and _POSITION.fullmatch(position)):
        return JSONResponse(_BAD, status_code=400)
    if "name" not in payload and not payload.get("deleted", False):
        if position is None:
            return JSONResponse(_BAD, status_code=400)
        with _connect(user_id) as connection:
            if connection.execute("SELECT 1 FROM evaluators WHERE id = ?", (evaluator_id,)).fetchone() is None:
                # Nothing here to move: the browser drops the row.
                return {"id": evaluator_id, "missing": True}
            return _place(connection, evaluator_id, position)
    book, name, on = payload.get("book"), payload.get("name"), payload.get("on")
    questions, base, deleted = payload.get("questions"), payload.get("baseVersion"), payload.get("deleted", False)
    journal, updated = payload.get("journal"), payload.get("updatedAt")
    starter_for = payload.get("starterFor")
    valid = (
        _is_id(book)
        and isinstance(name, str)
        and isinstance(on, bool)
        and isinstance(questions, list)
        and all(isinstance(q, dict) for q in questions)
        and (base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1))
        and isinstance(deleted, bool)
        and (journal is None or isinstance(journal, bool))
        and (updated is None or _is_time(updated))
        and (starter_for is None or _pages(starter_for) is not None)
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    stored = json.dumps(questions)
    # The browser's stamp is kept when it sends one, so an edit made signed out or offline
    # ranks by when it was made, not by when it arrived.
    updated = updated or _now()
    # Only the admin's evaluators are starters (8); anyone else's write keeps none. A
    # write that leaves starterFor out, from a tab older than it, keeps what is held.
    admin = bool((session_of(request) or {}).get("admin"))
    with _connect(user_id) as connection:
        pages = _pages(starter_for) if admin and starter_for is not None else None
        result = _write(connection, evaluator_id, book, name, on, journal, stored, base, deleted, updated, pages)
        if position is not None:
            result = _place(connection, evaluator_id, position)
        if admin:
            _publish(connection, user_id)
        return result


def _write(connection, evaluator_id, book, name, on, journal, stored, base, deleted, updated, pages) -> dict:
    """One write onto the user's own file; pages is the new starterFor, None to keep it."""
    row = connection.execute("SELECT * FROM evaluators WHERE id = ?", (evaluator_id,)).fetchone()
    if row is None:
        # A new id is an idempotent upsert of the browser's own ULID (5): it continues
        # from the base the client held, or 1, so an evaluator made signed out arrives
        # with its history. A tombstone can be born here, for one deleted before upload.
        connection.execute(
            'INSERT INTO evaluators (id, book, name, "on", journal, questions, version, seq, deleted, updated_at, starter_for) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (evaluator_id, book, name, int(on), int(bool(journal)), stored, (base or 0) + 1, _next_seq(connection), int(deleted), updated, json.dumps(pages or [])),
        )
        return _reread(connection, evaluator_id)
    # A write onto a tombstone, or a second delete, returns the tombstone unchanged.
    if row["deleted"]:
        return _record(row)
    # A write from a browser that predates "Show in journal" leaves it out and keeps it.
    shown = row["journal"] if journal is None else int(journal)
    ticks = row["starter_for"] if pages is None else json.dumps(pages)
    # What the server already holds is not a change: no new version and no new seq,
    # so a resend of a write already applied is harmless.
    if not deleted and (name, int(on), shown, stored, ticks) == (row["name"], row["on"], row["journal"], row["questions"], row["starter_for"]):
        return _record(row)
    connection.execute(
        'UPDATE evaluators SET name = ?, "on" = ?, journal = ?, questions = ?, version = ?, seq = ?, deleted = ?, updated_at = ?, starter_for = ? WHERE id = ?',
        (name, int(on), shown, stored, row["version"] + 1, _next_seq(connection), int(deleted), updated, ticks, evaluator_id),
    )
    return _reread(connection, evaluator_id)


def _place(connection: sqlite3.Connection, evaluator_id: str, position: str) -> dict:
    """Set a live evaluator's place in the list; a tombstone keeps what it had."""
    row = connection.execute("SELECT * FROM evaluators WHERE id = ?", (evaluator_id,)).fetchone()
    if row["deleted"] or row["position"] == position:
        return _record(row)
    connection.execute("UPDATE evaluators SET position = ?, seq = ? WHERE id = ?", (position, _next_seq(connection), evaluator_id))
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


@router.get("/starters/{page}")
def starters(page: str):
    """A try page's starters (8), for anyone: each ticked evaluator's name and questions,
    oldest first. Nothing of the admin's but what they ticked leaves the server."""
    with _shared() as shared:
        rows = shared.execute("SELECT name, questions FROM starters WHERE page = ? ORDER BY id", (page,)).fetchall()
    return {"evaluators": [{"name": row["name"], "questions": json.loads(row["questions"])} for row in rows]}
