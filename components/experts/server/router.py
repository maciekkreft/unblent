"""experts' server module (architecture.md 5): the far end of the replicated experts
fact. Every route needs a signed-in user (require_user) and resolves that user's own
SQLite file, so isolation holds by construction and the code reads as if for a single
user. version is assigned here. The last write wins, so a write is never refused for a
stale base, and nothing is deleted (5).
"""

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

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(directory: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(Path(directory) / "experts.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _base(value) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 1)


def _expert(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "prompt": row["prompt"], "on": bool(row["on"]), "version": row["version"]}


def _now() -> int:
    return int(time.time() * 1000)


async def _body(request: Request):
    try:
        payload = await request.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


@router.put("/{expert_id}")
async def put_expert(expert_id: str, request: Request, user_id: str = Depends(require_user)):
    """A new id continues from the base the browser held, or 1, so an expert written
    signed out arrives with its history (5). What the server already holds is not a
    change: no new version and no new seq, so a resend of a write already applied is
    harmless."""
    payload = await _body(request)
    if expert_id == "" or payload is None:
        return JSONResponse(_BAD, status_code=400)
    prompt, on, base = payload.get("prompt"), payload.get("on"), payload.get("baseVersion")
    if not (isinstance(prompt, str) and isinstance(on, bool) and _base(base)):
        return JSONResponse(_BAD, status_code=400)
    with _connect(user_dir(user_id)) as connection:
        row = connection.execute("SELECT * FROM experts WHERE id = ?", (expert_id,)).fetchone()
        seq = connection.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM experts").fetchone()[0]
        if row is None:
            connection.execute(
                'INSERT INTO experts (id, prompt, "on", version, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
                (expert_id, prompt, int(on), (base or 0) + 1, seq, _now()),
            )
        elif row["prompt"] != prompt or bool(row["on"]) != on:
            connection.execute(
                'UPDATE experts SET prompt = ?, "on" = ?, version = ?, seq = ?, updated_at = ? WHERE id = ?',
                (prompt, int(on), row["version"] + 1, seq, _now(), expert_id),
            )
        return _expert(connection.execute("SELECT * FROM experts WHERE id = ?", (expert_id,)).fetchone())


@router.get("")
def pull(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_dir(user_id)) as connection:
        rows = connection.execute("SELECT * FROM experts WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    return {"experts": [_expert(row) for row in rows], "cursor": max([after, *(row["seq"] for row in rows)])}
