"""The server side of ``flags`` (architecture.md 3.1, 3.4, 5): two switches per feature.
Release, whether the feature is given to people at all, is set by the admin on the
website and kept in one shared file, data/flags.db. Show, whether one account wants to
see it, is set by that account and kept in its own data/<user>/flags.db.

GET answers anyone, signed out included: ``released`` and ``shown``, the features whose
switches are on; ``off``, the features not released; and ``hidden``, what this request's
account does not see. PUT ``{feature, on, column}`` changes one switch and answers the
same picture: Release only for the admin on the website, Show for any signed-in account.
Hiding is not a lock: no other server module reads these files.
"""

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from server.user import DATA, local_user, session_of, user_dir

router = APIRouter()

_HERE = Path(__file__).parent
_RELEASE = (_HERE / "schema.sql").read_text()
_SHOW = (_HERE / "show.sql").read_text()

# The Release a Mac that is not connected reads (3.1): copied from the website's
# Release switches by mac/freeze.sh when the version is built, and not in the repository.
FROZEN = _HERE / "released.json"

# The features that have a flag, in the order the Features tab shows them; the
# browser half of this component holds the same list (machine.js).
FEATURES = ("choice-points",)

COLUMNS = ("release", "show")


@contextmanager
def _connect(path: Path, schema: str) -> Iterator[sqlite3.Connection]:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript(schema)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def released() -> list[str]:
    if local_user():
        try:
            frozen = json.loads(FROZEN.read_text()).get("released")
        except (OSError, ValueError, AttributeError):
            frozen = None
        # Without the frozen list every feature counts as released (3.1).
        return [f for f in FEATURES if not isinstance(frozen, list) or f in frozen]
    with _connect(DATA / "flags.db", _RELEASE) as connection:
        held = {row[0] for row in connection.execute("SELECT feature FROM off")}
    return [f for f in FEATURES if f not in held]


def release(feature: str, on: bool) -> None:
    with _connect(DATA / "flags.db", _RELEASE) as connection:
        now = int(time.time() * 1000)
        if on:
            connection.execute("DELETE FROM off WHERE feature = ?", (feature,))
        else:
            connection.execute("INSERT OR IGNORE INTO off (feature, at) VALUES (?, ?)", (feature, now))


def shown(user_id: str | None) -> list[str]:
    if not user_id:
        return list(FEATURES)
    with _connect(user_dir(user_id) / "flags.db", _SHOW) as connection:
        hidden = {row[0] for row in connection.execute("SELECT feature FROM hidden")}
    return [f for f in FEATURES if f not in hidden]


def show(user_id: str, feature: str, on: bool) -> None:
    with _connect(user_dir(user_id) / "flags.db", _SHOW) as connection:
        if on:
            connection.execute("DELETE FROM hidden WHERE feature = ?", (feature,))
        else:
            connection.execute(
                "INSERT OR IGNORE INTO hidden (feature, at) VALUES (?, ?)", (feature, int(time.time() * 1000))
            )


def _on_website_as_admin(session: dict | None) -> bool:
    """The admin on the website, not viewing as someone (session_of already says no
    then), not on a Mac: the one person a feature that is not released still shows to,
    and the one who may release it (3.1, 12)."""
    return bool(session and session["admin"] and not session["device"] and not local_user())


def _picture(session: dict | None) -> dict:
    given = released()
    mine = shown(session["userId"] if session else None)
    admin = _on_website_as_admin(session)
    return {
        "off": [f for f in FEATURES if f not in given],
        "hidden": [f for f in FEATURES if (f not in given and not admin) or f not in mine],
        "released": given,
        "shown": mine,
    }


@router.get("")
async def read(request: Request):
    return await run_in_threadpool(_picture, session_of(request))


@router.put("")
async def edit(request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = None
    # A body without `column` is a Release switch, as the tab sent before Show existed.
    if (
        not isinstance(body, dict)
        or not {"feature", "on"} <= set(body) <= {"feature", "on", "column"}
        or body["feature"] not in FEATURES
        or not isinstance(body["on"], bool)
        or body.get("column", "release") not in COLUMNS
    ):
        return JSONResponse({"error": "bad-request"}, status_code=400)
    session = session_of(request)
    if body.get("column", "release") == "release":
        if not _on_website_as_admin(session):
            return JSONResponse({"error": "not-admin"}, status_code=403)
        await run_in_threadpool(release, body["feature"], body["on"])
    else:
        if not session:
            return JSONResponse({"error": "signed-out"}, status_code=401)
        await run_in_threadpool(show, session["userId"], body["feature"], body["on"])
    return await run_in_threadpool(_picture, session)
