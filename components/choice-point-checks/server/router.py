"""choice-point-checks' server module (architecture.md 5): the far end of the replicated
choice-point-checks fact. Every route needs a signed-in user (require_user) and resolves
that user's own SQLite file, so isolation holds by construction and the code reads as if
for a single user. A box's settings are last write wins: a write is never refused for a
stale base, and version is assigned here. An answer is added under its key and never
changed, like a chat's turn: a key the server already holds keeps its first answer, which
is returned so the browser adopts it.

A body is validated against the component's own event schemas: a box as checks.changed
carries one, the answers as lines.checked carries a line's.
"""

import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from jsonschema import Draft202012Validator

from server.user import require_user, user_dir

router = APIRouter()

_HERE = Path(__file__).parent
_SCHEMA = (_HERE / "schema.sql").read_text()

_FIELDS = ("away", "towards", "situation", "thoughts")
_KEY = re.compile(r"^[0-9a-f]{28}$")

_changed = json.loads((_HERE.parent / "events" / "checks.changed.json").read_text())
_checked = json.loads((_HERE.parent / "events" / "lines.checked.json").read_text())
_BOX = Draft202012Validator(_changed["properties"]["settings"]["properties"]["away"])
_ANSWERS = Draft202012Validator(_checked["properties"]["lines"]["items"]["properties"]["answers"])

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# `with connection:` alone leaves the handle open until the cycle collector reaches it,
# which ran the server out of file descriptors on Python 3.14; closing when the block
# ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "choice-point-checks.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    # CREATE IF NOT EXISTS never adds a column to an existing table, so a file from before
    # a box had further evaluators is migrated here (notes/server/router.py does the same).
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(boxes)")}
    if "also" not in columns:
        connection.executescript("ALTER TABLE boxes ADD COLUMN also TEXT")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _box(row: sqlite3.Row) -> dict:
    return {
        "field": row["field"],
        "evaluator": row["evaluator"],
        "questions": json.loads(row["questions"]),
        "also": json.loads(row["also"]) if row["also"] else [],
        "version": row["version"],
    }


def _answer(row: sqlite3.Row) -> dict:
    return {"key": row["key"], "answers": json.loads(row["answers"])}


def _next_seq(connection: sqlite3.Connection) -> int:
    return (
        connection.execute(
            "SELECT MAX(COALESCE((SELECT MAX(seq) FROM boxes), 0), COALESCE((SELECT MAX(seq) FROM answers), 0))"
        ).fetchone()[0]
        + 1
    )


async def _body(request: Request):
    try:
        return await request.json()
    except ValueError:
        return None


@router.put("/boxes/{field}")
async def put_box(field: str, request: Request, user_id: str = Depends(require_user)):
    payload = await _body(request)
    if field not in _FIELDS or not isinstance(payload, dict):
        return JSONResponse(_BAD, status_code=400)
    base = payload.get("baseVersion")
    box = {"evaluator": payload.get("evaluator"), "questions": payload.get("questions"), "also": payload.get("also", [])}
    valid = _BOX.is_valid(box) and (base is None or (isinstance(base, int) and not isinstance(base, bool) and base >= 1))
    if not valid:
        return JSONResponse(_BAD, status_code=400)
    questions = json.dumps(box["questions"], separators=(",", ":"))
    also = json.dumps(box["also"], separators=(",", ":"))
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM boxes WHERE field = ?", (field,)).fetchone()
        if row is None:
            # A first write continues from the base the client held, or 1, so settings
            # made signed out arrive with their history.
            connection.execute(
                "INSERT INTO boxes (field, evaluator, questions, also, version, seq) VALUES (?, ?, ?, ?, ?, ?)",
                (field, box["evaluator"], questions, also, (base or 0) + 1, _next_seq(connection)),
            )
        elif (row["evaluator"], row["questions"], row["also"] or "[]") != (box["evaluator"], questions, also):
            connection.execute(
                "UPDATE boxes SET evaluator = ?, questions = ?, also = ?, version = ?, seq = ? WHERE field = ?",
                (box["evaluator"], questions, also, row["version"] + 1, _next_seq(connection), field),
            )
        # What the server already holds is not a change: no new version and no new seq.
        return _box(connection.execute("SELECT * FROM boxes WHERE field = ?", (field,)).fetchone())


@router.put("/answers/{key}")
async def put_answer(key: str, request: Request, user_id: str = Depends(require_user)):
    payload = await _body(request)
    if not (_KEY.match(key) and isinstance(payload, dict) and _ANSWERS.is_valid(payload.get("answers"))):
        return JSONResponse(_BAD, status_code=400)
    with _connect(user_id) as connection:
        connection.execute(
            "INSERT OR IGNORE INTO answers (key, answers, seq) VALUES (?, ?, ?)",
            (key, json.dumps(payload["answers"], separators=(",", ":")), _next_seq(connection)),
        )
        return _answer(connection.execute("SELECT * FROM answers WHERE key = ?", (key,)).fetchone())


@router.get("")
def pull(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        boxes = connection.execute("SELECT * FROM boxes WHERE seq > ? ORDER BY seq", (after,)).fetchall()
        answers = connection.execute("SELECT * FROM answers WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = max([after, *(r["seq"] for r in boxes), *(r["seq"] for r in answers)])
    return {"boxes": [_box(r) for r in boxes], "answers": [_answer(r) for r in answers], "cursor": cursor}
