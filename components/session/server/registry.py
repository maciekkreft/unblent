"""The identity registry's persistence (architecture.md 5): the one shared
`data/session.db`, because it defines the users every per-user database is keyed
by. The router reaches it only through these calls, never SQL of its own.
"""

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from server.user import DATA

DB_PATH = DATA / "session.db"
_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
_ADDED = (
    ("guest", "INTEGER NOT NULL DEFAULT 0"),
    ("number", "INTEGER"),
    ("first_seen", "INTEGER"),
    ("last_seen", "INTEGER"),
    ("country", "TEXT NOT NULL DEFAULT ''"),
    ("city", "TEXT NOT NULL DEFAULT ''"),
    ("browser", "TEXT NOT NULL DEFAULT ''"),
    ("system", "TEXT NOT NULL DEFAULT ''"),
    ("device", "TEXT NOT NULL DEFAULT 'desk'"),
    ("deleted_at", "INTEGER"),
)
_DETAILS = ("country", "city", "browser", "system", "device")


# `with connection:` alone commits or rolls back and leaves the handle open, to be
# closed only when the interpreter's cycle collector gets to it (a cursor and its rows
# keep the connection in a cycle); on Python 3.14 the server ran out of file
# descriptors that way. Closing when the block ends keeps one handle per request.
@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    # schema.sql is replayed per connect, but CREATE IF NOT EXISTS never adds a column
    # to an existing table, so a registry from before guests is migrated here (5).
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(users)")}
    for name, kind in _ADDED:
        if name not in columns:
            connection.executescript(f"ALTER TABLE users ADD COLUMN {name} {kind}")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _now() -> int:
    return int(time.time() * 1000)


def user_count() -> int:
    """Accounts with a passkey: guests do not count toward MAX_USERS (3.4)."""
    with _connect() as connection:
        return connection.execute("SELECT COUNT(*) FROM users WHERE guest = 0").fetchone()[0]


def create_user(*, id: str, handle: bytes, label: str, details: dict) -> None:
    now = _now()
    with _connect() as connection:
        connection.execute(
            "INSERT INTO users (id, handle, label, created_at, first_seen, last_seen,"
            " country, city, browser, system, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (id, handle, label, now // 1000, now, now, *(details[k] for k in _DETAILS)),
        )


def create_guest(*, id: str, details: dict) -> None:
    """A guest is one row and no credential (3.4). Its number is the next after every
    guest so far, taken in the same transaction so two arriving at once differ."""
    now = _now()
    with _connect() as connection:
        number = connection.execute("SELECT COALESCE(MAX(number), 0) + 1 FROM users WHERE guest = 1").fetchone()[0]
        connection.execute(
            "INSERT INTO users (id, handle, label, created_at, guest, number, first_seen, last_seen,"
            " country, city, browser, system, device) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)",
            (id, bytes.fromhex(id), "Guest", now // 1000, number, now, now, *(details[k] for k in _DETAILS)),
        )


def _admin_id(connection: sqlite3.Connection) -> str | None:
    # The admin is the account registered first with a passkey (3.4).
    row = connection.execute(
        "SELECT id FROM users WHERE guest = 0 ORDER BY created_at, rowid LIMIT 1"
    ).fetchone()
    return row["id"] if row else None


def _name(row: sqlite3.Row, admin_id: str | None) -> str:
    if row["guest"]:
        return f"Guest {row['number']}"
    return "Admin" if row["id"] == admin_id else "Account"


def account(user_id: str) -> dict | None:
    """{"guest", "admin", "name"} for a registered account, or None when the registry
    does not hold it (a cookie forged in a test, or a registry restored without it)."""
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, guest, number FROM users WHERE id = ? AND deleted_at IS NULL", (user_id,)
        ).fetchone()
        if not row:
            return None
        admin_id = _admin_id(connection)
        return {"guest": bool(row["guest"]), "admin": row["id"] == admin_id, "name": _name(row, admin_id)}


def seen(user_id: str, details: dict) -> None:
    """Mark the account seen now, with the visit's details (3.4)."""
    with _connect() as connection:
        connection.execute(
            "UPDATE users SET last_seen = ?, first_seen = COALESCE(first_seen, created_at * 1000),"
            " country = ?, city = ?, browser = ?, system = ?, device = ? WHERE id = ?",
            (_now(), *(details[k] for k in _DETAILS), user_id),
        )


def people() -> list[dict]:
    """Every account, the admin first and then guests newest first (12); any other
    passkey account sits between them. Space is added by the router."""
    with _connect() as connection:
        admin_id = _admin_id(connection)
        rows = connection.execute(
            "SELECT id, guest, number, created_at, first_seen, last_seen, country, city, browser, system, device"
            " FROM users WHERE deleted_at IS NULL ORDER BY guest, number DESC, created_at, rowid"
        ).fetchall()
    result = []
    for row in rows:
        first = row["first_seen"] if row["first_seen"] is not None else row["created_at"] * 1000
        person = {
            "userId": row["id"],
            "name": _name(row, admin_id),
            "guest": bool(row["guest"]),
            "admin": row["id"] == admin_id,
            "firstSeen": first,
            "lastSeen": row["last_seen"] if row["last_seen"] is not None else first,
            "country": row["country"],
            "city": row["city"],
            "browser": row["browser"],
            "system": row["system"],
            "device": row["device"],
        }
        result.append(person)
    result.sort(key=lambda p: not p["admin"])
    return result


def delete_guest(user_id: str) -> bool:
    """Delete a guest (12): the row stays, marked deleted, so create_guest's next number
    still counts it and a cookie naming it is known to be gone. Never the admin or an
    account with a passkey; False when there is no such live guest."""
    with _connect() as connection:
        changed = connection.execute(
            "UPDATE users SET deleted_at = ? WHERE id = ? AND guest = 1 AND deleted_at IS NULL", (_now(), user_id)
        ).rowcount
        return changed == 1


def is_deleted(user_id: str) -> bool:
    with _connect() as connection:
        row = connection.execute("SELECT deleted_at FROM users WHERE id = ?", (user_id,)).fetchone()
        return bool(row and row["deleted_at"] is not None)


def add_credential(*, id: str, user_id: str, public_key: bytes, sign_count: int, transports: str | None) -> None:
    with _connect() as connection:
        connection.execute(
            "INSERT INTO credentials (id, user_id, public_key, sign_count, transports) VALUES (?, ?, ?, ?, ?)",
            (id, user_id, public_key, sign_count, transports),
        )


def get_credential(credential_id: str) -> dict | None:
    with _connect() as connection:
        row = connection.execute(
            "SELECT id, user_id, public_key, sign_count, transports FROM credentials WHERE id = ?",
            (credential_id,),
        ).fetchone()
        return dict(row) if row else None


def update_sign_count(*, credential_id: str, sign_count: int) -> None:
    with _connect() as connection:
        connection.execute(
            "UPDATE credentials SET sign_count = ? WHERE id = ?", (sign_count, credential_id)
        )
