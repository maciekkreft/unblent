"""journal's server module (architecture.md 5): the far end of the replicated journal
fact. Every route needs a signed-in user (require_user) and resolves that user's own
SQLite file, so isolation holds by construction and the code reads as if for a single
user. version is assigned here. A day's text can conflict between devices: a stale
base is rejected as a conflict carrying the server's copy.
"""

import re
import sqlite3
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import NamedTuple

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from server.user import require_user, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

_ULID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "journal.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    _drop_old_tables(connection)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _is_id(value) -> bool:
    return isinstance(value, str) and bool(_ULID.match(value))


def _is_int(value) -> bool:
    # bool is an int in Python, and true is not a time or a version.
    return isinstance(value, int) and not isinstance(value, bool)


# --- The kinds ----------------------------------------------------------------------
# Each kind names its table, the columns that key a record, the columns a write may
# change, a parser from the browser's record to those columns (None when invalid) and
# the record the browser is sent back.


def _day_columns(r: dict) -> dict | None:
    if not (_is_id(r.get("id")) and isinstance(r.get("day"), str) and _DATE.match(r["day"])):
        return None
    if not (isinstance(r.get("text"), str) and _is_int(r.get("editedAt"))):
        return None
    return {"id": r["id"], "day": r["day"], "text": r["text"], "edited_at": r["editedAt"]}


def _day_record(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "day": row["day"], "text": row["text"], "editedAt": row["edited_at"]}


class _Kind(NamedTuple):
    keys: tuple
    fields: tuple
    parse: Callable
    record: Callable
    conflicts: bool


# A day's date is set by its first character and never changes, so `day` is written
# only when the row is born and is not among the fields a later write may change.
_KINDS = {
    "days": _Kind(("id",), ("text", "edited_at"), _day_columns, _day_record, conflicts=True),
}


def _quoted(column: str) -> str:
    return f'"{column}"'


def _full(kind: _Kind, row: sqlite3.Row) -> dict:
    return {**kind.record(row), "version": row["version"], "deleted": bool(row["deleted"])}


# Tables an older journal file may still hold, from the journal's detectors, which
# nothing reads any more. Before they are dropped their highest seq is kept in
# seq_floor, so a new seq still continues past theirs and a device whose cursor
# already passed them still pulls the next day.
_OLD_TABLES = ("projects", "detectors", "answers")


def _drop_old_tables(connection: sqlite3.Connection) -> None:
    present = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    old = [t for t in _OLD_TABLES if t in present]
    if not old:
        return
    union = " UNION ALL ".join(f"SELECT MAX(seq) AS s FROM {table}" for table in old)
    with connection:
        highest = connection.execute(f"SELECT COALESCE(MAX(s), 0) FROM ({union})").fetchone()[0]
        connection.execute(
            "INSERT INTO seq_floor (id, seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET seq = MAX(seq, excluded.seq)",
            (highest,),
        )
        for table in old:
            connection.execute(f"DROP TABLE {table}")


def _next_seq(connection: sqlite3.Connection) -> int:
    # One order across the journal, so a single cursor covers it, never below the floor.
    return connection.execute(
        "SELECT MAX(COALESCE((SELECT MAX(seq) FROM days), 0), COALESCE((SELECT seq FROM seq_floor WHERE id = 1), 0))"
    ).fetchone()[0] + 1


def _where(kind: _Kind) -> str:
    return " AND ".join(f"{_quoted(k)} = ?" for k in kind.keys)


def _write(name: str, kind: _Kind, columns: dict, base: int | None, deleted: bool, connection: sqlite3.Connection):
    key = tuple(columns[k] for k in kind.keys)

    def reread() -> dict:
        return _full(kind, connection.execute(f"SELECT * FROM {name} WHERE {_where(kind)}", key).fetchone())

    def update(version: int, gone: bool) -> dict:
        sets = ", ".join(f"{_quoted(f)} = ?" for f in kind.fields)
        connection.execute(
            f"UPDATE {name} SET {sets}, version = ?, seq = ?, deleted = ? WHERE {_where(kind)}",
            (*(columns[f] for f in kind.fields), version, _next_seq(connection), int(gone), *key),
        )
        return reread()

    row = connection.execute(f"SELECT * FROM {name} WHERE {_where(kind)}", key).fetchone()
    if row is None:
        # A new key is an idempotent upsert of the browser's own record (5): it continues
        # from the base the client held, or 1, so a journal kept signed out arrives with
        # its history. A tombstone can be born here, for a record deleted before upload.
        names = [*columns, "version", "seq", "deleted"]
        values = [*columns.values(), (base or 0) + 1, _next_seq(connection), int(deleted)]
        connection.execute(
            f"INSERT INTO {name} ({', '.join(map(_quoted, names))}) VALUES ({', '.join('?' for _ in names)})",
            values,
        )
        return reread(), 200
    # A delete always wins (5): it is not refused for a stale base, and a second delete
    # returns the tombstone unchanged.
    if deleted:
        return (_full(kind, row), 200) if row["deleted"] else (update(row["version"] + 1, True), 200)
    # A write onto a tombstone loses to the delete, the newer fact: a day's edit comes
    # back as a conflict.
    if row["deleted"]:
        return _full(kind, row), (409 if kind.conflicts else 200)
    # What the server already holds is not a change: no new version and no new seq. It
    # is checked before the base, so a resend of a write already applied is harmless.
    if all(row[f] == columns[f] for f in kind.fields):
        return _full(kind, row), 200
    if kind.conflicts and base != row["version"]:
        return _full(kind, row), 409
    return update(row["version"] + 1, False), 200


@router.put("/{name}")
async def put_record(name: str, request: Request, user_id: str = Depends(require_user)):
    kind = _KINDS.get(name)
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    if kind is None or not isinstance(payload, dict) or not isinstance(payload.get("record"), dict):
        return JSONResponse(_BAD, status_code=400)
    columns = kind.parse(payload["record"])
    base = payload.get("baseVersion")
    deleted = payload.get("deleted", False)
    if columns is None or not (base is None or (_is_int(base) and base >= 1)) or not isinstance(deleted, bool):
        return JSONResponse(_BAD, status_code=400)
    with _connect(user_id) as connection:
        record, status = _write(name, kind, columns, base, deleted, connection)
    return JSONResponse({"record": record}, status_code=status)


@router.get("")
def pull(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    out = {}
    cursor = after
    with _connect(user_id) as connection:
        for name, kind in _KINDS.items():
            rows = connection.execute(f"SELECT * FROM {name} WHERE seq > ? ORDER BY seq", (after,)).fetchall()
            out[name] = [_full(kind, row) for row in rows]
            cursor = max([cursor, *(row["seq"] for row in rows)])
    return {**out, "cursor": cursor}
