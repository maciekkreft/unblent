"""The server side of ``flags`` (architecture.md 3.1, 3.4): which features are off for
everyone except the admin, in one shared file, data/flags.db, because a flag is the
same for every account.

GET answers anyone, signed out included: ``off``, the features turned off, and
``hidden``, what this request's account does not see, read from the cookie. The admin
sees every feature, except while viewing as someone (12). PUT, the admin alone, turns
one feature on or off and answers the same picture. Hiding is not a lock: no other
server module reads this file.
"""

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from server.user import DATA, session_of

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

# The features that have a flag, in the order the Feature flags tab shows them; the
# browser half of this component holds the same list (machine.js).
FEATURES = ("chats", "evaluators", "choice-points", "highlights")


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    DATA.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATA / "flags.db")
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def off() -> list[str]:
    with _connect() as connection:
        rows = {row[0] for row in connection.execute("SELECT feature FROM off")}
    return [f for f in FEATURES if f in rows]


def switch(feature: str, on: bool) -> None:
    with _connect() as connection:
        if on:
            connection.execute("DELETE FROM off WHERE feature = ?", (feature,))
        else:
            connection.execute(
                "INSERT OR IGNORE INTO off (feature, at) VALUES (?, ?)", (feature, int(time.time() * 1000))
            )


def _admin(request: Request) -> bool:
    session = session_of(request)
    return bool(session and session["admin"])


def _picture(request: Request) -> dict:
    turned_off = off()
    return {"off": turned_off, "hidden": [] if _admin(request) else turned_off}


@router.get("")
async def read(request: Request):
    return await run_in_threadpool(_picture, request)


@router.put("")
async def edit(request: Request):
    if not _admin(request):
        return JSONResponse({"error": "not-admin"}, status_code=403)
    try:
        body = await request.json()
    except ValueError:
        body = None
    if (
        not isinstance(body, dict)
        or set(body) != {"feature", "on"}
        or body["feature"] not in FEATURES
        or not isinstance(body["on"], bool)
    ):
        return JSONResponse({"error": "bad-request"}, status_code=400)
    await run_in_threadpool(switch, body["feature"], body["on"])
    return await run_in_threadpool(_picture, request)
