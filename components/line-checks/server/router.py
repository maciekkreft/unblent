"""line-checks' server module (architecture.md 5): the far end of the replicated
line-checks fact. Every route needs a signed-in user (require_user) and resolves that
user's own SQLite file, so isolation holds by construction and the code reads as if for
a single user. An answer is added under its key and never changed, like a chat's turn: a
key the server already holds keeps its first answer, which is returned so the browser
adopts it.
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

_KEY = re.compile(r"^[0-9a-f]{28}$")

# One key's answers as the machine keeps them (answerRecord in machine.js): per question,
# the option picked or the side of a yes / no, its name and how likely Jev holds it.
_ANSWERS = Draft202012Validator(
    {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "question": {"type": "string", "pattern": "^[0-9A-HJKMNP-TV-Z]{26}$"},
                "option": {"type": "string", "pattern": "^([0-9A-HJKMNP-TV-Z]{26}|yes|no)$"},
                "name": {"type": "string"},
                "p": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["question", "option", "name", "p"],
            "additionalProperties": False,
        },
    }
)

# A body that is not what the route takes is refused with this fixed reply rather than
# FastAPI's 422, which would echo the body back.
_BAD = {"error": "bad-request"}


# Closing when the block ends keeps one handle per request (choice-point-checks' router
# says why).
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "line-checks.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _answer(row: sqlite3.Row) -> dict:
    return {"key": row["key"], "answers": json.loads(row["answers"])}


async def _body(request: Request):
    try:
        return await request.json()
    except ValueError:
        return None


@router.put("/answers/{key}")
async def put_answer(key: str, request: Request, user_id: str = Depends(require_user)):
    payload = await _body(request)
    if not (_KEY.match(key) and isinstance(payload, dict) and _ANSWERS.is_valid(payload.get("answers"))):
        return JSONResponse(_BAD, status_code=400)
    with _connect(user_id) as connection:
        seq = connection.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM answers").fetchone()[0]
        connection.execute(
            "INSERT OR IGNORE INTO answers (key, answers, seq) VALUES (?, ?, ?)",
            (key, json.dumps(payload["answers"], separators=(",", ":")), seq),
        )
        return _answer(connection.execute("SELECT * FROM answers WHERE key = ?", (key,)).fetchone())


@router.get("")
def pull(since: str = "0", user_id: str = Depends(require_user)):
    if not since.isdigit():
        return JSONResponse(_BAD, status_code=400)
    after = int(since)
    with _connect(user_id) as connection:
        answers = connection.execute("SELECT * FROM answers WHERE seq > ? ORDER BY seq", (after,)).fetchall()
    cursor = max([after, *(r["seq"] for r in answers)])
    return {"answers": [_answer(r) for r in answers], "cursor": cursor}
