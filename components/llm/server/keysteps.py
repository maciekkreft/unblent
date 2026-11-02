"""A key change as a step (architecture.md 7.7, 12, Undo), for an account's own keys and
for the guest keys alike. A key never enters the browser or a step, so the server keeps
the key from before and the key from after, still encrypted, under the step's id. Undo
and Redo name only the step and which of the two to bring back; the stored ciphertext is
copied back unchanged, so a later step's "before" is exactly an earlier step's "after"
and several steps undo in a row. Both copies are erased once the step leaves the undo
list (`step.dropped`).

Each function takes an open connection and the names of the two tables, the keys and
their steps, which hold the same columns in llm.db per user and in the shared data/llm.db.
"""

import re
import sqlite3

SIDES = ("before", "after")
_ULID = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def valid_step(value) -> bool:
    return isinstance(value, str) and bool(_ULID.match(value))


def valid_move(body) -> dict | None:
    """An Undo or Redo of a key step as the server accepts it: the step, the side to
    bring back and the side it expects to find, which differ."""
    if not isinstance(body, dict) or set(body) != {"step", "restore", "expect"}:
        return None
    if not valid_step(body["step"]) or body["restore"] not in SIDES or body["expect"] not in SIDES:
        return None
    if body["restore"] == body["expect"]:
        return None
    return body


def _saved(connection: sqlite3.Connection, keys: str, provider: str):
    row = connection.execute(f"SELECT cipher, at FROM {keys} WHERE provider = ?", (provider,)).fetchone()
    return (row["cipher"], row["at"]) if row else (None, None)


def _write(connection: sqlite3.Connection, keys: str, provider: str, cipher, at) -> None:
    if cipher is None:
        connection.execute(f"DELETE FROM {keys} WHERE provider = ?", (provider,))
    else:
        connection.execute(
            f"INSERT INTO {keys} (provider, cipher, at) VALUES (?, ?, ?)"
            " ON CONFLICT(provider) DO UPDATE SET cipher = excluded.cipher, at = excluded.at",
            (provider, cipher, at),
        )


def put(connection: sqlite3.Connection, keys: str, steps: str, provider: str, cipher, at, step) -> None:
    """Save (cipher) or remove (None) one provider's key; with a step id, keep the key
    from before and the one now under it, unless nothing changed."""
    before = _saved(connection, keys, provider)
    _write(connection, keys, provider, cipher, at)
    after = _saved(connection, keys, provider)
    if step and before[0] != after[0]:
        connection.execute(
            f"INSERT OR REPLACE INTO {steps} (step, provider, before_cipher, before_at, after_cipher, after_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (step, provider, before[0], before[1], after[0], after[1]),
        )


def move(connection: sqlite3.Connection, keys: str, steps: str, step: str, restore: str, expect: str) -> bool:
    """Bring back the `restore` side of every key the step changed, only while each key
    is still the `expect` side; False, writing nothing, when one changed since or the
    step is unknown or erased."""
    rows = connection.execute(f"SELECT * FROM {steps} WHERE step = ?", (step,)).fetchall()
    if not rows:
        return False
    if any(_saved(connection, keys, row["provider"])[0] != row[f"{expect}_cipher"] for row in rows):
        return False
    for row in rows:
        _write(connection, keys, row["provider"], row[f"{restore}_cipher"], row[f"{restore}_at"])
    return True


def forget(connection: sqlite3.Connection, steps: str, step: str) -> None:
    """The step left the undo list: the keys it kept are erased for good."""
    connection.execute(f"DELETE FROM {steps} WHERE step = ?", (step,))
