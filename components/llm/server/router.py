"""llm's server module (architecture.md 3.1, 7.7): the far end of the remote-only
llm fact. A completion can only come from the server, which also holds the account's
model settings and its API key, encrypted at rest and never returned to the browser.
Every route needs a signed-in user (require_user) and resolves that user's own
SQLite file, so isolation holds by construction.

Routes: GET "" returns the account's picture (without signedIn, which the browser
adds); PUT "" changes settings and the keys; POST "/complete" streams one answer as
newline-delimited JSON pieces (6.3); POST "/decide" asks Jev yes/no questions and
returns its answers. A request body that fails validation is answered
with a fixed 400, never echoed, because it may carry the key.
"""

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from server.user import require_user, user_dir

from . import anthropic_adapter, crypto, jev_adapter
from .adapters import complete

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

_PROVIDERS = ("anthropic", "echo")
_EFFORTS = ("default", "low", "medium", "high", "xhigh", "max")
_TTLS = ("5m", "1h")
_DEFAULT_MODEL = "claude-opus-5"

# The models a provider offers, cached per user for ten minutes so a read does not
# call the provider on every mount; cleared for a user when their settings change.
_models_cache: dict[str, tuple[float, list[dict]]] = {}


# `with connection:` alone leaves the handle open until the cycle collector runs; on
# Python 3.14 that ran the server out of descriptors. Closing when the block ends
# keeps one handle per request (as notes' and books' modules do).
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "llm.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _settings(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT provider, model, effort, ttl FROM settings WHERE one = 1").fetchone()
    if row is None:
        return {"provider": "anthropic", "model": "", "effort": "default", "ttl": "1h"}
    return {"provider": row["provider"], "model": row["model"], "effort": row["effort"], "ttl": row["ttl"]}


def _key(connection: sqlite3.Connection, provider: str) -> str | None:
    row = connection.execute("SELECT cipher FROM keys WHERE provider = ?", (provider,)).fetchone()
    return crypto.decrypt(row["cipher"]) if row else None


def _models(user_id: str, provider: str, key: str | None) -> list[dict]:
    if provider == "echo":
        return [{"id": "echo", "label": "Echo"}]
    if not key:
        return []
    cached = _models_cache.get(user_id)
    if cached and time.time() - cached[0] < 600:
        return cached[1]
    try:
        models = anthropic_adapter.list_models(key)
    except Exception:
        # A bad or unreachable key leaves the picture honest: no models to choose.
        return []
    _models_cache[user_id] = (time.time(), models)
    return models


def _pick_default(models: list[dict]) -> str:
    ids = {model["id"] for model in models}
    if _DEFAULT_MODEL in ids:
        return _DEFAULT_MODEL
    return models[0]["id"] if models else ""


def _picture(user_id: str, connection: sqlite3.Connection) -> dict:
    settings = _settings(connection)
    provider = settings["provider"]
    models = _models(user_id, provider, _key(connection, provider))
    ids = {model["id"] for model in models}
    return {
        "provider": provider,
        "providers": [
            {"id": "anthropic", "label": "Anthropic", "keySet": _key(connection, "anthropic") is not None, "needsKey": True},
            {"id": "echo", "label": "Echo", "keySet": True, "needsKey": False},
        ],
        "model": settings["model"] if settings["model"] in ids else _pick_default(models),
        "models": models,
        "effort": settings["effort"],
        "efforts": list(_EFFORTS),
        "ttl": settings["ttl"],
        "jev": {"keySet": _key(connection, "jev") is not None},
    }


@router.get("")
def read(user_id: str = Depends(require_user)) -> dict:
    with _connect(user_id) as connection:
        return _picture(user_id, connection)


@router.put("")
async def edit(request: Request, user_id: str = Depends(require_user)):
    payload = await request.json()
    fields = _valid(payload)
    if fields is None:
        # Never echo the body: it may hold the key (unlike FastAPI's default 422).
        return JSONResponse({"error": "bad-request"}, status_code=400)
    return await run_in_threadpool(_apply, user_id, fields)


def _valid(payload) -> dict | None:
    if not isinstance(payload, dict):
        return None
    provider = payload.get("provider")
    effort = payload.get("effort")
    ttl = payload.get("ttl")
    model = payload.get("model")
    key = payload.get("key")
    jev_key = payload.get("jevKey")
    if jev_key is not None and not isinstance(jev_key, str):
        return None
    if provider is not None and provider not in _PROVIDERS:
        return None
    if effort is not None and effort not in _EFFORTS:
        return None
    if ttl is not None and ttl not in _TTLS:
        return None
    if model is not None and not isinstance(model, str):
        return None
    if key is not None and not isinstance(key, str):
        return None
    return {"provider": provider, "effort": effort, "ttl": ttl, "model": model, "key": key, "jevKey": jev_key}


def _apply(user_id: str, fields: dict) -> dict:
    with _connect(user_id) as connection:
        current = _settings(connection)
        provider = fields["provider"] or current["provider"]
        connection.execute(
            "INSERT INTO settings (one, provider, model, effort, ttl) VALUES (1, ?, ?, ?, ?)"
            " ON CONFLICT(one) DO UPDATE SET provider = excluded.provider, model = excluded.model,"
            " effort = excluded.effort, ttl = excluded.ttl",
            (
                provider,
                fields["model"] if fields["model"] is not None else current["model"],
                fields["effort"] or current["effort"],
                fields["ttl"] or current["ttl"],
            ),
        )
        key = fields["key"]
        if key is not None:
            if key == "":  # an empty key removes it (7.7)
                connection.execute("DELETE FROM keys WHERE provider = ?", (provider,))
            else:
                connection.execute(
                    "INSERT INTO keys (provider, cipher, at) VALUES (?, ?, ?)"
                    " ON CONFLICT(provider) DO UPDATE SET cipher = excluded.cipher, at = excluded.at",
                    (provider, crypto.encrypt(key), int(time.time() * 1000)),
                )
        # The Jev key sits in the same table under its own name, independent of the
        # chosen provider, so `keys` needs no new column.
        jev_key = fields["jevKey"]
        if jev_key == "":
            connection.execute("DELETE FROM keys WHERE provider = 'jev'")
        elif jev_key is not None:
            connection.execute(
                "INSERT INTO keys (provider, cipher, at) VALUES ('jev', ?, ?)"
                " ON CONFLICT(provider) DO UPDATE SET cipher = excluded.cipher, at = excluded.at",
                (crypto.encrypt(jev_key), int(time.time() * 1000)),
            )
        _models_cache.pop(user_id, None)
        return _picture(user_id, connection)


def _for_completion(user_id: str) -> tuple[dict, str | None]:
    # The model is resolved the same way the read picture resolves it, so a completion
    # uses the default the account sees rather than an unset stored model.
    with _connect(user_id) as connection:
        settings = _settings(connection)
        key = _key(connection, settings["provider"])
    models = _models(user_id, settings["provider"], key)
    if settings["model"] not in {model["id"] for model in models}:
        settings["model"] = _pick_default(models)
    return settings, key


@router.post("/complete")
async def do_complete(request: Request, user_id: str = Depends(require_user)):
    body = await request.json()
    settings, key = await run_in_threadpool(_for_completion, user_id)
    provider = settings["provider"]

    async def lines():
        try:
            async for piece in complete(provider, settings, key, body):
                if piece["type"] == "end":
                    piece = {**piece, "provider": provider, "model": settings["model"]}
                yield json.dumps(piece) + "\n"
        except Exception:
            # A failure while streaming rides the turn to the chat, not a separate
            # event (architecture.md 12, "Remote-only facts fail offline").
            yield json.dumps({"type": "end", "status": "failed", "error": "unavailable", "provider": provider, "model": settings["model"]}) + "\n"

    # X-Accel-Buffering off so a proxy does not hold the pieces back (6.3).
    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _jev_key(user_id: str) -> str | None:
    with _connect(user_id) as connection:
        return _key(connection, "jev")


def _decide_body(body) -> tuple[dict, list] | None:
    if not isinstance(body, dict) or not isinstance(body.get("state"), dict):
        return None
    questions = body.get("questions")
    if not isinstance(questions, list) or not questions:
        return None
    for q in questions:
        if not isinstance(q, dict) or not isinstance(q.get("id"), str) or not isinstance(q.get("instructions"), str):
            return None
        if not all(isinstance(q.get(side, ""), str) for side in ("yes", "no")):
            return None
    return body["state"], questions


@router.post("/decide")
async def do_decide(request: Request, user_id: str = Depends(require_user)):
    try:
        parsed = _decide_body(await request.json())
    except ValueError:
        parsed = None
    if parsed is None:
        return JSONResponse({"error": "bad-request"}, status_code=400)
    key = await run_in_threadpool(_jev_key, user_id)
    if key is None:
        # The error rides the reply, as complete's does, so the asker shows it.
        return {"error": "no-key"}
    state, questions = parsed
    return await run_in_threadpool(jev_adapter.decide, key, state, questions)
