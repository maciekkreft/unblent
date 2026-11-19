"""prompt-sets' server module (architecture.md 5): the far end of the replicated
prompt-sets fact. Every route needs a signed-in user (require_user) and resolves that
user's own SQLite file, so isolation holds by construction and the code reads as if for
a single user. version is assigned here. The last write wins, so a write is never
refused for a stale base; a delete always wins (5), so a write onto a tombstone comes
back as the tombstone rather than reviving it, except a restore write, which names the
tombstone's own version. A starter write adds a starter set only when no record of its
id is held, live or deleted, and otherwise returns what is held, so the starter sets
are written once per account however many devices write them.
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
_TEXTS = ("name", "occasion", "basedOn", "position")

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "prompt-sets.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
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
        "name": row["name"],
        "occasion": row["occasion"],
        "basedOn": row["based_on"],
        "prompts": json.loads(row["prompts"]),
        "position": row["position"],
        "version": row["version"],
        "deleted": bool(row["deleted"]),
    }


def _next_seq(connection: sqlite3.Connection) -> int:
    return connection.execute("SELECT COALESCE(MAX(seq), 0) FROM prompt_sets").fetchone()[0] + 1


def _reread(connection: sqlite3.Connection, set_id: str) -> dict:
    return _record(connection.execute("SELECT * FROM prompt_sets WHERE id = ?", (set_id,)).fetchone())


@router.put("/{set_id}")
async def put_prompt_set(set_id: str, request: Request, user_id: str = Depends(require_user)):
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if not (_is_id(set_id) and isinstance(payload, dict)):
        return JSONResponse(_BAD, status_code=400)
    base = payload.get("baseVersion")
    deleted, starter = payload.get("deleted", False), payload.get("starter", False)
    name, occasion, based_on, position = (payload.get(key) for key in _TEXTS)
    prompts = payload.get("prompts")
    valid = (
        all(isinstance(text, str) for text in (name, occasion, based_on, position))
        and isinstance(prompts, list)
        and all(isinstance(prompt, str) for prompt in prompts)
        and (base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1))
        and isinstance(deleted, bool)
        and isinstance(starter, bool)
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    fields = (name, occasion, based_on, json.dumps(prompts), position)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM prompt_sets WHERE id = ?", (set_id,)).fetchone()
        if row is None:
            # A new id is an idempotent upsert of the browser's own ULID (5): it continues
            # from the base the client held, or 1, so a set made signed out arrives with its
            # history. A tombstone can be born here, for one deleted before upload.
            connection.execute(
                "INSERT INTO prompt_sets (id, name, occasion, based_on, prompts, position, version, seq, deleted)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (set_id, *fields, (base or 0) + 1, _next_seq(connection), int(deleted)),
            )
            return _reread(connection, set_id)
        if starter:
            return _record(row)
        # A restore write (5, Undo in 12) names the tombstone's own version as its base and
        # brings the set back as a new version. Any other write onto a tombstone, or a
        # second delete, returns the tombstone unchanged.
        if row["deleted"]:
            if not deleted and base == row["version"]:
                connection.execute(
                    "UPDATE prompt_sets SET name = ?, occasion = ?, based_on = ?, prompts = ?, position = ?,"
                    " version = ?, seq = ?, deleted = 0 WHERE id = ?",
                    (*fields, row["version"] + 1, _next_seq(connection), set_id),
                )
                return _reread(connection, set_id)
            return _record(row)
        # What the server already holds is not a change: no new version and no new seq,
        # so a resend of a write already applied is harmless.
        held = (row["name"], row["occasion"], row["based_on"], json.dumps(json.loads(row["prompts"])), row["position"])
        if not deleted and fields == held:
            return _record(row)
        connection.execute(
            "UPDATE prompt_sets SET name = ?, occasion = ?, based_on = ?, prompts = ?, position = ?,"
            " version = ?, seq = ?, deleted = ? WHERE id = ?",
            (*fields, row["version"] + 1, _next_seq(connection), int(deleted), set_id),
        )
        return _reread(connection, set_id)


@router.get("")
def list_prompt_sets(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM prompt_sets WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = rows[-1]["seq"] if rows else after
    return {"sets": [_record(row) for row in rows], "cursor": cursor}
