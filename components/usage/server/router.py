"""usage's server module (architecture.md 5): the far end of the replicated usage fact.
Every route needs a signed-in user (require_user) and resolves that user's own SQLite
file. Each row is one device's running total for a day and a feature, so a write
replaces the row whole: the last write wins and nothing is refused for being stale (5).

GET /summary adds up the devices per day and feature for the last 182 days. With
who=all it adds up every account's own file, for the admin only and not while viewing
as someone (session_of says no then), and answers totals only, with how many accounts
they come from (12).
"""

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from server.user import DATA, removed, require_user, session_of, user_dir

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

# The features the browser half counts into (machine.js meta.features), in the order a
# summary lists them within a day.
FEATURES = ("journal", "reading", "highlights", "notes", "chats", "evaluators", "choice", "values", "other")

_DAY = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
_DEVICE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
DAYS = 182
# More rows than a device could change between two drains; a bigger body is refused.
_MAX_ROWS = 2000

_BAD = {"error": "bad-request"}


@contextmanager
def _connect(path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(path)
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _valid(row) -> bool:
    if not isinstance(row, dict) or set(row) != {"id", "device", "day", "feature", "ms"}:
        return False
    device, day, feature, ms = row["device"], row["day"], row["feature"], row["ms"]
    return (
        isinstance(device, str)
        and bool(_DEVICE.match(device))
        and isinstance(day, str)
        and bool(_DAY.match(day))
        and feature in FEATURES
        and isinstance(ms, int)
        and not isinstance(ms, bool)
        and ms >= 0
        and row["id"] == f"{device}:{day}:{feature}"
    )


@router.put("")
async def put_totals(request: Request, user_id: str = Depends(require_user)):
    try:
        payload = await request.json()
    except ValueError:
        payload = None
    rows = payload.get("totals") if isinstance(payload, dict) and set(payload) == {"totals"} else None
    if not (isinstance(rows, list) and 0 < len(rows) <= _MAX_ROWS and all(_valid(r) for r in rows)):
        return JSONResponse(_BAD, status_code=400)
    with _connect(user_dir(user_id) / "usage.db") as connection:
        connection.executemany(
            "INSERT OR REPLACE INTO totals (id, device, day, feature, ms) VALUES (?, ?, ?, ?, ?)",
            [(r["id"], r["device"], r["day"], r["feature"], r["ms"]) for r in rows],
        )
    return {"stored": len(rows)}


def _first_day() -> str:
    return (date.today() - timedelta(days=DAYS - 1)).isoformat()


def _sums(path: Path, since: str) -> dict:
    """Totals per (day, feature) in one account's file, read only, so no file is made."""
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            "SELECT day, feature, SUM(ms) FROM totals WHERE day >= ? GROUP BY day, feature", (since,)
        ).fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        connection.close()
    return {(day, feature): ms for day, feature, ms in rows if feature in FEATURES and ms}


def _days(sums: dict) -> list:
    keys = sorted(sums, key=lambda k: (k[0], FEATURES.index(k[1])))
    return [{"day": day, "feature": feature, "ms": int(sums[(day, feature)])} for day, feature in keys]


@router.get("/summary")
def summary(request: Request, who: str = "you", user_id: str = Depends(require_user)):
    if who not in ("you", "all"):
        return JSONResponse(_BAD, status_code=400)
    since = _first_day()
    if who == "you":
        path = DATA / user_id / "usage.db"
        return {"days": _days(_sums(path, since) if path.is_file() else {}), "accounts": 1}
    session = session_of(request)
    if not (session and session["admin"]):
        return JSONResponse({"error": "not-admin"}, status_code=403)
    total: dict = {}
    accounts = 0
    if DATA.is_dir():
        for directory in sorted(DATA.iterdir()):
            # A user directory is a plain name; shared files and dot-directories are not one.
            if directory.name.startswith(".") or not directory.is_dir() or removed(directory.name):
                continue
            path = directory / "usage.db"
            if not path.is_file():
                continue
            sums = _sums(path, since)
            if not sums:
                continue
            accounts += 1
            for key, ms in sums.items():
                total[key] = total.get(key, 0) + ms
    return {"days": _days(total), "accounts": accounts}
