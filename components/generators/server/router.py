"""generators' server module (architecture.md 5): the far end of the replicated
generators fact. Every route needs a signed-in user (require_user) and resolves that
user's own SQLite file, so isolation holds by construction and the code reads as if for
a single user. version is assigned here. The last write wins, so a write is never
refused for a stale base, and nothing is deleted (5).

write_result is the one way a result is written, so a script run on the host writes
with the same versioning as the route.
"""

import re
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

_GENERATORS = ("chat-title", "journal-summary", "value-suggestion")
_SOURCE = re.compile(r"^[0-9a-f]{64}$")

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(directory: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(Path(directory) / "generators.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _base(value) -> bool:
    return value is None or (isinstance(value, int) and not isinstance(value, bool) and value >= 1)


def _generator(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "on": bool(row["on"]),
        "model": row["model"],
        "prompt": row["prompt"],
        "version": row["version"],
    }


def _result(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in ("id", "generator", "item", "text", "source", "version")}


def _next_seq(connection: sqlite3.Connection) -> int:
    return (
        connection.execute(
            "SELECT MAX(COALESCE((SELECT MAX(seq) FROM generators), 0), COALESCE((SELECT MAX(seq) FROM results), 0))"
        ).fetchone()[0]
        + 1
    )


def _now() -> int:
    return int(time.time() * 1000)


def _upsert(connection: sqlite3.Connection, table: str, record_id: str, fields: dict, base) -> sqlite3.Row:
    """A new id continues from the base the browser held, or 1, so a record made signed
    out arrives with its history (5). What the server already holds is not a change: no
    new version and no new seq, so a resend of a write already applied is harmless."""
    row = connection.execute(f"SELECT * FROM {table} WHERE id = ?", (record_id,)).fetchone()
    names = list(fields)
    if row is None:
        columns = ", ".join(f'"{name}"' for name in [*names, "id", "version", "seq", "updated_at"])
        marks = ", ".join("?" for _ in range(len(names) + 4))
        connection.execute(
            f"INSERT INTO {table} ({columns}) VALUES ({marks})",
            (*fields.values(), record_id, (base or 0) + 1, _next_seq(connection), _now()),
        )
    elif any(row[name] != value for name, value in fields.items()):
        assignments = ", ".join(f'"{name}" = ?' for name in names)
        connection.execute(
            f"UPDATE {table} SET {assignments}, version = ?, seq = ?, updated_at = ? WHERE id = ?",
            (*fields.values(), row["version"] + 1, _next_seq(connection), _now(), record_id),
        )
    return connection.execute(f"SELECT * FROM {table} WHERE id = ?", (record_id,)).fetchone()


def write_result(directory: Path, result: dict) -> dict:
    """Write one result into the generators.db under `directory` (a user's own directory,
    data/<user>/) and return it as the fact announces it. `result` holds generator, item,
    text and source, and may hold baseVersion. Raises ValueError for anything else."""
    generator, item, text, source = (result.get(key) for key in ("generator", "item", "text", "source"))
    base = result.get("baseVersion")
    valid = (
        generator in _GENERATORS
        and isinstance(item, str)
        and item != ""
        and isinstance(text, str)
        and isinstance(source, str)
        and bool(_SOURCE.match(source))
        and _base(base)
    )
    if not valid:
        raise ValueError("not a result")
    fields = {"generator": generator, "item": item, "text": text, "source": source}
    with _connect(directory) as connection:
        return _result(_upsert(connection, "results", f"{generator}:{item}", fields, base))


async def _body(request: Request):
    try:
        payload = await request.json()
    except ValueError:
        return None
    return payload if isinstance(payload, dict) else None


@router.put("/generators/{generator_id}")
async def put_generator(generator_id: str, request: Request, user_id: str = Depends(require_user)):
    payload = await _body(request)
    if generator_id not in _GENERATORS or payload is None:
        return JSONResponse(_BAD, status_code=400)
    name, on, model, prompt = (payload.get(key) for key in ("name", "on", "model", "prompt"))
    base = payload.get("baseVersion")
    valid = (
        isinstance(name, str)
        and isinstance(on, bool)
        and isinstance(model, str)
        and model != ""
        and isinstance(prompt, str)
        and _base(base)
    )
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    fields = {"name": name, "on": int(on), "model": model, "prompt": prompt}
    with _connect(user_dir(user_id)) as connection:
        return _generator(_upsert(connection, "generators", generator_id, fields, base))


@router.put("/results/{result_id}")
async def put_result(result_id: str, request: Request, user_id: str = Depends(require_user)):
    payload = await _body(request)
    if payload is None or result_id != f"{payload.get('generator')}:{payload.get('item')}":
        return JSONResponse(_BAD, status_code=400)
    try:
        return write_result(user_dir(user_id), payload)
    except ValueError:
        return JSONResponse(_BAD, status_code=400)


@router.get("")
def pull(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_dir(user_id)) as connection:
        generators = connection.execute("SELECT * FROM generators WHERE seq > ? ORDER BY seq", (after,)).fetchall()
        results = connection.execute("SELECT * FROM results WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = max([after, *(row["seq"] for row in generators), *(row["seq"] for row in results)])
    return {
        "generators": [_generator(row) for row in generators],
        "results": [_result(row) for row in results],
        "cursor": cursor,
    }
