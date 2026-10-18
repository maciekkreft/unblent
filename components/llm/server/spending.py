"""What guests spend (architecture.md 5, 7.7): the guest keys, the prices, every
guest's running total per provider, the limits, and the refusals. It lives in one
shared file, data/llm.db, because the limit for all guests adds up many accounts;
each account's own settings and keys stay in its own file (router.py).

Every use costs the tokens the provider reports multiplied by that provider's
published price. A request is refused once a limit is reached, before it is sent;
what it then costs is added after, from the usage the provider reports, so the last
request may go a little over. A guest sees only the share of its own allowance left.
"""

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from server.user import DATA

from . import crypto

_SCHEMA = (Path(__file__).parent / "spending.sql").read_text()

# The providers a guest may spend on, each only with a guest key (7.7). Echo costs
# nothing and needs no key, so it is not counted here.
PROVIDERS = (("jev", "Jev by typesafe.ai"), ("anthropic", "Anthropic"))
_IDS = {pid for pid, _ in PROVIDERS}

# Jev, typesafe.ai's System One model: $42 per billion input tokens, from the `usage`
# it returns (the owner's figure, try-links plan decision 4).
JEV_PER_TOKEN = 42 / 1_000_000_000

# Anthropic's published prices in dollars per million tokens: base input, 5-minute
# cache write, 1-hour cache write, cache read, output. Source:
# https://platform.claude.com/docs/en/about-claude/pricing (read 2026-10-17).
# A model is matched by the longest id prefix, so a dated id finds its family.
_ANTHROPIC = {
    "claude-fable-5-1": (10, 12.5, 20, 0.25, 50),
    "claude-mythos-5-1": (10, 12.5, 20, 0.25, 50),
    "claude-fable-5": (10, 12.5, 20, 1, 50),
    "claude-mythos-5": (10, 12.5, 20, 1, 50),
    "claude-opus-5-5": (4, 5, 8, 0.2, 20),
    "claude-opus-5": (5, 6.25, 10, 0.5, 25),
    "claude-opus-4-8": (5, 6.25, 10, 0.5, 25),
    "claude-opus-4-7": (5, 6.25, 10, 0.5, 25),
    "claude-opus-4-6": (5, 6.25, 10, 0.5, 25),
    "claude-opus-4-5": (5, 6.25, 10, 0.5, 25),
    "claude-opus-4-1": (15, 18.75, 30, 1.5, 75),
    "claude-opus-4": (15, 18.75, 30, 1.5, 75),
    "claude-sonnet-5-5": (2, 2.5, 4, 0.1, 10),
    "claude-sonnet-5": (2, 2.5, 4, 0.2, 10),
    "claude-sonnet-4-6": (3, 3.75, 6, 0.3, 15),
    "claude-sonnet-4-5": (3, 3.75, 6, 0.3, 15),
    "claude-sonnet-4": (3, 3.75, 6, 0.3, 15),
    "claude-haiku-5-5": (0.1, 0.125, 0.2, 0.01, 0.5),
    "claude-haiku-4-5": (1, 1.25, 2, 0.1, 5),
    "claude-3-5-haiku": (0.8, 1, 1.6, 0.08, 4),
}
# Claude Haiku 5.5 costs more for a prompt over 100,000 tokens, counting cache reads
# and writes (the same page, "Long context pricing").
_HAIKU_LONG = (0.5, 0.625, 1, 0.05, 2.5)
_HAIKU_THRESHOLD = 100_000
# A model the table does not know is priced at the highest price, so a guest's use is
# never counted as less than it cost.
_UNKNOWN = (10, 12.5, 20, 1, 50)

PRICES = {
    "jev": "$42 per billion tokens read",
    "anthropic": "Each model's published price per million tokens",
}


def jev_cost(input_tokens: int) -> float:
    return max(0, int(input_tokens or 0)) * JEV_PER_TOKEN


def anthropic_cost(model: str, usage: dict | None) -> float:
    usage = usage or {}
    n = lambda field: max(0, int(usage.get(field) or 0))  # noqa: E731
    created = usage.get("cache_creation") or {}
    write_5m = max(0, int(created.get("ephemeral_5m_input_tokens") or 0))
    write_1h = max(0, int(created.get("ephemeral_1h_input_tokens") or 0))
    # Without the breakdown every cache write is priced at the dearer 1-hour rate.
    rest = max(0, n("cache_creation_input_tokens") - write_5m - write_1h)
    write_1h += rest
    read, plain, out = n("cache_read_input_tokens"), n("input_tokens"), n("output_tokens")
    matches = [prefix for prefix in _ANTHROPIC if model.startswith(prefix)]
    price = _ANTHROPIC[max(matches, key=len)] if matches else _UNKNOWN
    if price is _ANTHROPIC["claude-haiku-5-5"] and plain + read + write_5m + write_1h > _HAIKU_THRESHOLD:
        price = _HAIKU_LONG
    base, w5, w1, hit, output = price
    return (plain * base + write_5m * w5 + write_1h * w1 + read * hit + out * output) / 1_000_000


@contextmanager
def _connect() -> Iterator[sqlite3.Connection]:
    DATA.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATA / "llm.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def guest_key(provider: str) -> str | None:
    with _connect() as connection:
        row = connection.execute("SELECT cipher FROM guest_keys WHERE provider = ?", (provider,)).fetchone()
    return crypto.decrypt(row["cipher"]) if row else None


def _keys_set(connection: sqlite3.Connection) -> set[str]:
    return {row["provider"] for row in connection.execute("SELECT provider FROM guest_keys")}


def _limits(connection: sqlite3.Connection) -> dict:
    rows = {row["name"]: row["dollars"] for row in connection.execute("SELECT name, dollars FROM limits")}
    return {
        "guest": rows.get("guest", 1.0),
        "allGuests": rows.get("allGuests", 10.0),
        "providers": {pid: rows.get(f"provider:{pid}") for pid in _IDS},
    }


def _totals(connection: sqlite3.Connection) -> tuple[float, dict]:
    by_provider = {pid: 0.0 for pid in _IDS}
    for row in connection.execute("SELECT provider, SUM(dollars) AS d FROM spent GROUP BY provider"):
        by_provider[row["provider"]] = by_provider.get(row["provider"], 0.0) + (row["d"] or 0.0)
    return sum(by_provider.values()), by_provider


def _paused(connection: sqlite3.Connection) -> list[str]:
    """The providers no guest may use now: a limit for all guests is reached, or the
    provider has no guest key, so it is not offered to guests (7.7)."""
    limits = _limits(connection)
    total, by_provider = _totals(connection)
    keys = _keys_set(connection)
    out = []
    for pid, _ in PROVIDERS:
        own = limits["providers"][pid]
        if pid not in keys or total >= limits["allGuests"] or (own is not None and by_provider[pid] >= own):
            out.append(pid)
    return out


def _guest_spent(connection: sqlite3.Connection, user_id: str) -> float:
    row = connection.execute("SELECT SUM(dollars) AS d FROM spent WHERE user_id = ?", (user_id,)).fetchone()
    return row["d"] or 0.0


def _blocked(connection: sqlite3.Connection, user_id: str) -> bool:
    return connection.execute("SELECT 1 FROM blocked WHERE user_id = ?", (user_id,)).fetchone() is not None


def free_use(user_id: str) -> dict:
    """The guest's picture (llm: read's freeUse): the share of its own allowance left,
    whether it is blocked, and the providers paused for every guest. Never an amount."""
    with _connect() as connection:
        limit = _limits(connection)["guest"]
        spent = _guest_spent(connection, user_id)
        left = 0.0 if limit <= 0 else max(0.0, min(1.0, 1 - spent / limit))
        return {"left": left, "blocked": _blocked(connection, user_id), "paused": _paused(connection)}


def offered(provider: str) -> bool:
    """Whether a guest may be offered this provider: only with a guest key (7.7)."""
    with _connect() as connection:
        return provider in _keys_set(connection)


def refusal(user_id: str, provider: str) -> str | None:
    """Why a guest's request to this provider is refused, or None (7.7): blocked by the
    admin, its own allowance used up, or paused for every guest."""
    with _connect() as connection:
        if _blocked(connection, user_id):
            return "blocked"
        if _guest_spent(connection, user_id) >= _limits(connection)["guest"]:
            return "used-up"
        if provider in _paused(connection):
            return "paused"
    return None


def add(user_id: str, provider: str, dollars: float) -> None:
    if dollars <= 0:
        return
    with _connect() as connection:
        connection.execute(
            "INSERT INTO spent (user_id, provider, dollars) VALUES (?, ?, ?)"
            " ON CONFLICT(user_id, provider) DO UPDATE SET dollars = dollars + excluded.dollars",
            (user_id, provider, dollars),
        )


def summary() -> dict:
    """The admin's picture (llm: spending): what guests spent since the start, in
    total, per provider and per guest, with the limits and which guest keys are saved."""
    with _connect() as connection:
        limits = _limits(connection)
        total, by_provider = _totals(connection)
        keys = _keys_set(connection)
        guests = {}
        for row in connection.execute("SELECT user_id, SUM(dollars) AS d FROM spent GROUP BY user_id"):
            guests[row["user_id"]] = row["d"] or 0.0
        blocked = {row["user_id"] for row in connection.execute("SELECT user_id FROM blocked")}
        for user_id in blocked:
            guests.setdefault(user_id, 0.0)
        return {
            "allGuests": {"spent": total, "limit": limits["allGuests"]},
            "guest": limits["guest"],
            "providers": [
                {
                    "id": pid,
                    "label": label,
                    "spent": by_provider[pid],
                    "limit": limits["providers"][pid],
                    "guestKeySet": pid in keys,
                    "price": PRICES[pid],
                }
                for pid, label in PROVIDERS
            ],
            "guests": [
                {"userId": user_id, "spent": spent, "blocked": user_id in blocked}
                for user_id, spent in sorted(guests.items())
            ],
        }


def valid_limits(body) -> dict | None:
    """limits.edited as the server accepts it: only the fields that changed, each a
    non-negative number of dollars; a provider's own limit may be null for none."""
    if not isinstance(body, dict) or set(body) - {"guest", "allGuests", "providers"}:
        return None
    number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0  # noqa: E731
    for field in ("guest", "allGuests"):
        if field in body and not number(body[field]):
            return None
    providers = body.get("providers", {})
    if not isinstance(providers, dict) or set(providers) - _IDS:
        return None
    if not all(v is None or number(v) for v in providers.values()):
        return None
    return body


def set_limits(body: dict) -> None:
    with _connect() as connection:
        for field in ("guest", "allGuests"):
            if field in body:
                connection.execute(
                    "INSERT INTO limits (name, dollars) VALUES (?, ?)"
                    " ON CONFLICT(name) DO UPDATE SET dollars = excluded.dollars",
                    (field, float(body[field])),
                )
        for pid, dollars in body.get("providers", {}).items():
            if dollars is None:
                connection.execute("DELETE FROM limits WHERE name = ?", (f"provider:{pid}",))
            else:
                connection.execute(
                    "INSERT INTO limits (name, dollars) VALUES (?, ?)"
                    " ON CONFLICT(name) DO UPDATE SET dollars = excluded.dollars",
                    (f"provider:{pid}", float(dollars)),
                )


def valid_keys(body) -> dict | None:
    """guestkeys.edited as the server accepts it: only the keys that changed, each a
    string, where an empty one removes that key."""
    if not isinstance(body, dict) or set(body) - _IDS:
        return None
    if not all(isinstance(v, str) for v in body.values()):
        return None
    return body


def set_keys(body: dict) -> None:
    with _connect() as connection:
        for pid, key in body.items():
            if key == "":
                connection.execute("DELETE FROM guest_keys WHERE provider = ?", (pid,))
            else:
                connection.execute(
                    "INSERT INTO guest_keys (provider, cipher, at) VALUES (?, ?, ?)"
                    " ON CONFLICT(provider) DO UPDATE SET cipher = excluded.cipher, at = excluded.at",
                    (pid, crypto.encrypt(key), int(time.time() * 1000)),
                )


def valid_block(body) -> dict | None:
    """guest.blocked as the server accepts it: a user and whether it is blocked."""
    if not isinstance(body, dict) or set(body) != {"user", "blocked"}:
        return None
    if not isinstance(body["user"], str) or not body["user"] or not isinstance(body["blocked"], bool):
        return None
    return body


def set_blocked(body: dict) -> None:
    """Block or unblock a guest (12): a blocked guest's paid tools are refused (7.7)."""
    with _connect() as connection:
        if body["blocked"]:
            connection.execute(
                "INSERT OR IGNORE INTO blocked (user_id, at) VALUES (?, ?)", (body["user"], int(time.time() * 1000))
            )
        else:
            connection.execute("DELETE FROM blocked WHERE user_id = ?", (body["user"],))


def valid_reset(body) -> dict | None:
    """use.reset as the server accepts it: a user, and undone when the admin pressed Undo."""
    if not isinstance(body, dict) or "user" not in body or set(body) - {"user", "undone"}:
        return None
    if not isinstance(body["user"], str) or not body["user"] or not isinstance(body.get("undone", False), bool):
        return None
    return body


def valid_forget(body) -> dict | None:
    """A deleted guest as the server accepts it: the user alone."""
    if not isinstance(body, dict) or set(body) != {"user"} or not isinstance(body["user"], str) or not body["user"]:
        return None
    return body


def forget(body: dict) -> None:
    """Delete on a guest (12): what it spent stops counting toward any limit, and its
    block and a kept Reset use go with it."""
    with _connect() as connection:
        for table in ("spent", "blocked", "before_reset"):
            connection.execute(f"DELETE FROM {table} WHERE user_id = ?", (body["user"],))


def reset(body: dict) -> None:
    """Reset use (12): the guest's totals go back to $0 and are kept aside, so Undo adds
    them back to whatever the guest spent since."""
    user_id = body["user"]
    with _connect() as connection:
        if body.get("undone"):
            connection.execute(
                "INSERT INTO spent (user_id, provider, dollars)"
                " SELECT user_id, provider, dollars FROM before_reset WHERE user_id = ? AND true"
                " ON CONFLICT(user_id, provider) DO UPDATE SET dollars = dollars + excluded.dollars",
                (user_id,),
            )
            connection.execute("DELETE FROM before_reset WHERE user_id = ?", (user_id,))
            return
        connection.execute("DELETE FROM before_reset WHERE user_id = ?", (user_id,))
        connection.execute(
            "INSERT INTO before_reset (user_id, provider, dollars)"
            " SELECT user_id, provider, dollars FROM spent WHERE user_id = ?",
            (user_id,),
        )
        connection.execute("DELETE FROM spent WHERE user_id = ?", (user_id,))
