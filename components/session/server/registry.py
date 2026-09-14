"""The identity registry's persistence (architecture.md 5): the one shared
`data/session.db`, because it defines the users every per-user database is keyed
by. The router reaches it only through these calls, never SQL of its own.
"""

import sqlite3
import time
from pathlib import Path

from server.user import DATA

DB_PATH = DATA / "session.db"
_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    return connection


def user_count() -> int:
    with _connect() as connection:
        return connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def create_user(*, id: str, handle: bytes, label: str) -> None:
    with _connect() as connection:
        connection.execute(
            "INSERT INTO users (id, handle, label, created_at) VALUES (?, ?, ?, ?)",
            (id, handle, label, int(time.time())),
        )


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
