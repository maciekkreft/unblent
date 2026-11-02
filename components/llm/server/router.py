"""llm's server module (architecture.md 3.1, 7.7): the far end of the remote-only
llm fact. A completion can only come from the server, which also holds the account's
model settings and its API key, encrypted at rest and never returned to the browser.
Every route needs a signed-in user (require_user) and resolves that user's own
SQLite file, so isolation holds by construction.

Routes: GET "" returns the account's picture (without signedIn, which the browser
adds); PUT "" changes settings and the keys; POST "/complete" streams one answer as
newline-delimited JSON pieces (6.3); POST "/decide" asks Jev yes/no and pick-one
questions and returns its answers, on the account's own Jev key or, in the local edition
with the ollama decider, from kev:0.8b-mlx-bf16 in Ollama on the user's Mac; POST "/generate"
writes one short text in one go on the account's own Anthropic key, whichever
provider the chat uses, and model "echo" answers with Echo; in the local edition it
writes on the chat's provider instead, on the generator's model when that provider
offers it and otherwise on the chat model, so Ollama needs no key. In the local edition (3.4)
the picture also offers Ollama on the user's own Mac, at an address the account keeps,
for chats and, by default, for decisions. A request body that fails validation is answered
with a fixed 400, never echoed, because it may carry the key.

A guest (3.4) spends only on the guest keys, within the limits, counted in
spending.py (7.7): its picture offers only the providers with a guest key and
carries freeUse, and its requests are refused with used-up, paused or blocked.
The admin alone reads what guests spent (GET "/spending"), changes the limits
(PUT "/limits") and the guest keys (PUT "/guestkeys"), blocks or unblocks a guest
(PUT "/blocked") and resets a guest's use, or undoes that (PUT "/reset").

A key change, the account's own or a guest key, is a step (12, Undo): the key from before
stays on the server, still encrypted, under the step's id (keysteps.py). PUT "/keys/step"
and PUT "/guestkeys/step" bring a kept key back for Undo or Redo, answering the error
changed when the key changed since (not a 4xx, which a browser logs as a failure); PUT
"/keys/forget" and PUT "/guestkeys/forget" erase what a step kept once it leaves the
undo list.
"""

import json
import logging
import sqlite3
import time
from urllib.parse import urlparse
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from server.user import local_user, require_user, session_of, user_dir

from . import anthropic_adapter, crypto, echo_adapter, jev_adapter, keysteps, openai_adapter, spending
from .adapters import complete

_log = logging.getLogger("uvicorn.error")


def _log_usage(provider: str, model: str, usage: dict) -> None:
    # One line per answer, for every account, so the owner can read in the server log
    # whether the provider's prompt cache holds across a chat (7.7): a cache read near
    # the whole input means everything before the new message was reused.
    n = lambda field: int(usage.get(field) or 0)  # noqa: E731
    _log.info(
        "llm usage: provider=%s model=%s input=%d cache_read=%d cache_write=%d output=%d",
        provider, model, n("input_tokens"), n("cache_read_input_tokens"), n("cache_creation_input_tokens"), n("output_tokens"),
    )


router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()

_PROVIDERS = ("anthropic", "echo", "ollama")
_EFFORTS = ("default", "low", "medium", "high", "xhigh", "max")
# A model on the user's Mac is offered thinking on or off, never an effort (3.4).
_OLLAMA_EFFORTS = ("on", "off")
_OLLAMA_ADDRESS = "http://localhost:11434"
_TTLS = ("5m", "1h")
_DEFAULT_MODEL = "claude-opus-5"
# The decision model the Mac app asks in Ollama (3.4).
_KEV = "kev:0.8b-mlx-bf16"

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
    _migrate(connection)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _migrate(connection: sqlite3.Connection) -> None:
    # A file made before Ollama was offered (3.4) has no address column yet.
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(settings)")}
    if "address" not in columns:
        connection.executescript("ALTER TABLE settings ADD COLUMN address TEXT")
    # A file made before Ollama could decide has no decider column yet.
    if "decider" not in columns:
        connection.executescript("ALTER TABLE settings ADD COLUMN decider TEXT")
    # A file made before the decision model could be chosen has no decider_model column yet.
    if "decider_model" not in columns:
        connection.executescript("ALTER TABLE settings ADD COLUMN decider_model TEXT")


def _deciders() -> list[str]:
    # Ollama runs on the user's own Mac, so only the local edition offers it (3.4), and
    # there it comes first because it needs no key and costs nothing.
    return ["ollama", "jev"] if local_user() else ["jev"]


def _decider(stored) -> str:
    # NULL, or a choice this edition does not offer, reads as the edition's default.
    deciders = _deciders()
    return stored if stored in deciders else deciders[0]


def _settings(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT provider, model, effort, ttl, address, decider, decider_model FROM settings WHERE one = 1").fetchone()
    if row is None:
        # The Mac app answers from Ollama on the user's own Mac unless they choose
        # otherwise (3.4); the website from Anthropic.
        provider = "ollama" if local_user() else "anthropic"
        return {
            "provider": provider, "model": "", "effort": "default", "ttl": "1h", "address": _OLLAMA_ADDRESS,
            "decider": _decider(None), "deciderSet": False, "deciderModel": None,
        }
    return {
        "provider": row["provider"], "model": row["model"], "effort": row["effort"], "ttl": row["ttl"],
        "address": row["address"] or _OLLAMA_ADDRESS,
        "decider": _decider(row["decider"]), "deciderSet": row["decider"] is not None,
        "deciderModel": row["decider_model"],
    }


def _efforts(provider: str) -> tuple:
    return _OLLAMA_EFFORTS if provider == "ollama" else _EFFORTS


def _effort(provider: str, effort: str) -> str:
    # One stored effort serves every provider; one the provider does not offer reads as
    # that provider's first (thinking on for Ollama, the model's default for Anthropic).
    efforts = _efforts(provider)
    return effort if effort in efforts else efforts[0]


def _ollama_models(address: str) -> list[dict] | None:
    """The models downloaded in Ollama, or None when it does not answer. Never cached,
    so a model pulled a moment ago shows on the next read."""
    try:
        return openai_adapter.list_models(f"{address}/v1", "ollama")
    except Exception:
        return None


def _kev(models: list[dict] | None) -> str | None:
    """The id of kev:0.8b-mlx-bf16 among Ollama's downloaded models, or None."""
    return next((m["id"] for m in models or [] if m["id"] == _KEV), None)


def _decision_model(models: list[dict] | None, chosen: str | None) -> str | None:
    """The model the checks use: the one the user chose while it is downloaded, else Kev
    while it is, else None."""
    if chosen and any(m["id"] == chosen for m in models or []):
        return chosen
    return _kev(models)


def _decision_models(models: list[dict] | None) -> list[dict]:
    """Every model downloaded in Ollama, Kev first: Ollama does not say which can make
    checks, so the user picks among all of them and Kev is the one that surely can."""
    listed = [{"id": m["id"], "label": m["id"]} for m in models or []]
    return sorted(listed, key=lambda m: m["id"] != _KEV)


def _key(connection: sqlite3.Connection, provider: str) -> str | None:
    row = connection.execute("SELECT cipher FROM keys WHERE provider = ?", (provider,)).fetchone()
    return crypto.decrypt(row["cipher"]) if row else None


def _models(user_id: str, provider: str, key: str | None, address: str = _OLLAMA_ADDRESS) -> list[dict]:
    if provider == "echo":
        return [{"id": "echo", "label": "Echo"}]
    if provider == "ollama":
        return _ollama_models(address) or []
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
    # gemma4:e4b-mlx is the model the Mac app is made for (3.4), under any tag Ollama gives it.
    for model in models:
        if model["id"].startswith("gemma4:e4b-mlx"):
            return model["id"]
    return models[0]["id"] if models else ""


def _key_for(connection: sqlite3.Connection, provider: str, guest: bool) -> str | None:
    # A guest spends only on the guest key; the admin's own keys are never spent on a
    # guest (7.7).
    return spending.guest_key(provider) if guest else _key(connection, provider)


def _picture(user_id: str, connection: sqlite3.Connection, guest: bool = False) -> dict:
    settings = _settings(connection)
    local = bool(local_user())
    providers = [
        {"id": "anthropic", "label": "Anthropic", "keySet": _key_for(connection, "anthropic", guest) is not None, "needsKey": True},
        {"id": "echo", "label": "Echo", "keySet": True, "needsKey": False},
    ]
    if local:
        # Ollama runs on the user's own Mac, so only the Mac app offers it (3.4).
        providers.insert(0, {"id": "ollama", "label": "Ollama", "keySet": True, "needsKey": False})
    if guest:
        # A provider without a guest key is not offered to guests (7.7).
        providers = [p for p in providers if p["keySet"] and p["id"] != "ollama"]
    provider = settings["provider"] if any(p["id"] == settings["provider"] for p in providers) else providers[0]["id"]
    ollama = _ollama_models(settings["address"]) if local else None
    if provider == "ollama":
        models = ollama or []
    else:
        models = _models(user_id, provider, _key_for(connection, provider, guest))
    ids = {model["id"] for model in models}
    picture = {
        "provider": provider,
        "providers": providers,
        "model": settings["model"] if settings["model"] in ids else _pick_default(models),
        "models": models,
        "effort": _effort(provider, settings["effort"]),
        "efforts": list(_efforts(provider)),
        "ttl": settings["ttl"],
    }
    jev_set = _key_for(connection, "jev", guest) is not None
    picture["jev"] = {"keySet": jev_set}
    if local:
        picture["ollama"] = {"address": settings["address"], "running": ollama is not None}
    if settings["decider"] == "ollama":
        chosen = _decision_model(ollama, settings["deciderModel"])
        picture["decider"] = {
            "provider": "ollama", "model": chosen or settings["deciderModel"] or _KEV, "ready": chosen is not None,
            "models": _decision_models(ollama),
        }
    else:
        picture["decider"] = {"provider": "jev", "model": "jev-latest", "ready": jev_set, "models": [{"id": "jev-latest", "label": "Jev"}]}
    picture["deciders"] = _deciders()
    if guest:
        picture["freeUse"] = spending.free_use(user_id)
    return picture


def _guest(request: Request) -> bool:
    session = session_of(request)
    return bool(session and session["guest"])


def _admin(request: Request) -> bool:
    session = session_of(request)
    return bool(session and session["admin"])


@router.get("")
def read(request: Request, user_id: str = Depends(require_user)) -> dict:
    with _connect(user_id) as connection:
        return _picture(user_id, connection, _guest(request))


@router.put("")
async def edit(request: Request, user_id: str = Depends(require_user)):
    payload = await request.json()
    fields = _valid(payload)
    if fields is None:
        # Never echo the body: it may hold the key (unlike FastAPI's default 422).
        return JSONResponse({"error": "bad-request"}, status_code=400)
    guest = _guest(request)
    if guest and (fields["key"] is not None or fields["jevKey"] is not None):
        # A guest has no keys of its own; it spends on the guest keys (7.7).
        return JSONResponse({"error": "guest"}, status_code=403)
    return await run_in_threadpool(_apply, user_id, fields, guest)


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
    if provider is not None and (provider not in _PROVIDERS or (provider == "ollama" and not local_user())):
        return None
    if effort is not None and effort not in _EFFORTS + _OLLAMA_EFFORTS:
        return None
    address = payload.get("address")
    if address is not None and _address(address) is None:
        return None
    decider = payload.get("decider")
    if decider is not None and decider not in _deciders():
        return None
    decider_model = payload.get("deciderModel")
    if decider_model is not None and (not isinstance(decider_model, str) or len(decider_model) > 200):
        return None
    if ttl is not None and ttl not in _TTLS:
        return None
    if model is not None and not isinstance(model, str):
        return None
    if key is not None and not isinstance(key, str):
        return None
    step = payload.get("step")
    if step is not None and not keysteps.valid_step(step):
        return None
    return {
        "provider": provider, "effort": effort, "ttl": ttl, "model": model, "key": key, "jevKey": jev_key,
        "address": None if address is None else _address(address),
        "decider": decider,
        "deciderModel": decider_model,
        "step": step,
    }


def _address(value) -> str | None:
    """Ollama's address as stored: "" brings back the default; otherwise an http or
    https URL with a host, without a trailing slash. None when it is not one."""
    if not isinstance(value, str) or len(value) > 500:
        return None
    value = value.strip().rstrip("/")
    if value == "":
        return ""
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.query or parsed.fragment:
        return None
    return value


def _apply(user_id: str, fields: dict, guest: bool = False) -> dict:
    with _connect(user_id) as connection:
        current = _settings(connection)
        provider = fields["provider"] or current["provider"]
        connection.execute(
            "INSERT INTO settings (one, provider, model, effort, ttl, address, decider, decider_model) VALUES (1, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(one) DO UPDATE SET provider = excluded.provider, model = excluded.model,"
            " effort = excluded.effort, ttl = excluded.ttl, address = excluded.address, decider = excluded.decider,"
            " decider_model = excluded.decider_model",
            (
                provider,
                fields["model"] if fields["model"] is not None else current["model"],
                fields["effort"] or current["effort"],
                fields["ttl"] or current["ttl"],
                # NULL is the default address, so a later change of default reaches it.
                (fields["address"] or None) if fields["address"] is not None else (None if current["address"] == _OLLAMA_ADDRESS else current["address"]),
                # NULL is the edition's default decider, until the user chooses one.
                fields["decider"] or (current["decider"] if current["deciderSet"] else None),
                # NULL is Kev, until the user chooses another downloaded model.
                (fields["deciderModel"] or None) if fields["deciderModel"] is not None else current["deciderModel"],
            ),
        )
        # A key change is a step (12, Undo): with the step's id, the key from before is
        # kept aside, still encrypted, so Undo can bring it back (keysteps.py). An empty
        # key removes it (7.7). The Jev key sits in the same table under its own name,
        # independent of the chosen provider, so `keys` needs no new column.
        now = int(time.time() * 1000)
        for name, value in ((provider, fields["key"]), ("jev", fields["jevKey"])):
            if value is not None:
                cipher = crypto.encrypt(value) if value else None
                keysteps.put(connection, "keys", "key_steps", name, cipher, now, fields["step"])
        _models_cache.pop(user_id, None)
        return _picture(user_id, connection, guest)


def _move_key(user_id: str, body: dict) -> dict | None:
    with _connect(user_id) as connection:
        if not keysteps.move(connection, "keys", "key_steps", body["step"], body["restore"], body["expect"]):
            return None
        _models_cache.pop(user_id, None)
        return _picture(user_id, connection)


def _forget_key(user_id: str, step: str) -> None:
    with _connect(user_id) as connection:
        keysteps.forget(connection, "key_steps", step)


async def _body(request: Request):
    try:
        return await request.json()
    except ValueError:
        return None


@router.put("/keys/step")
async def step_key(request: Request, user_id: str = Depends(require_user)):
    # Undo or Redo of a key step (12): the key comes back from the server's own copy and
    # never travels; a key changed since refuses it.
    body = keysteps.valid_move(await _body(request))
    if body is None:
        return JSONResponse({"error": "bad-request"}, status_code=400)
    if _guest(request):
        return JSONResponse({"error": "guest"}, status_code=403)
    picture = await run_in_threadpool(_move_key, user_id, body)
    if picture is None:
        return {"error": "changed"}
    return picture


@router.put("/keys/forget")
async def forget_key(request: Request, user_id: str = Depends(require_user)):
    # The step left the undo list (step.dropped): the keys it kept go for good.
    body = await _body(request)
    if not isinstance(body, dict) or set(body) != {"step"} or not keysteps.valid_step(body["step"]):
        return JSONResponse({"error": "bad-request"}, status_code=400)
    await run_in_threadpool(_forget_key, user_id, body["step"])
    return {"ok": True}


def _for_completion(user_id: str, guest: bool = False) -> tuple[dict, str | None]:
    # The model is resolved the same way the read picture resolves it, so a completion
    # uses the default the account sees rather than an unset stored model.
    with _connect(user_id) as connection:
        settings = _settings(connection)
        if settings["provider"] == "ollama" and not local_user():
            # Only the Mac app reaches Ollama (3.4); the website answers as its picture does.
            settings["provider"] = "anthropic"
        key = _key_for(connection, settings["provider"], guest)
    if settings["provider"] == "ollama":
        key = "ollama"
        settings["base_url"] = f"{settings['address']}/v1"
    settings["effort"] = _effort(settings["provider"], settings["effort"])
    models = _models(user_id, settings["provider"], key, settings["address"])
    if settings["model"] not in {model["id"] for model in models}:
        settings["model"] = _pick_default(models)
    return settings, key


@router.post("/complete")
async def do_complete(request: Request, user_id: str = Depends(require_user)):
    body = await request.json()
    guest = _guest(request)
    settings, key = await run_in_threadpool(_for_completion, user_id, guest)
    provider = settings["provider"]
    # A guest's request is refused before it is sent once a limit is reached (7.7);
    # Echo costs nothing and needs no key, so it is never refused.
    refused = guest and provider != "echo" and await run_in_threadpool(spending.refusal, user_id, provider)

    async def lines():
        if refused:
            yield json.dumps({"type": "end", "status": "failed", "error": refused, "provider": provider, "model": settings["model"]}) + "\n"
            return
        try:
            async for piece in complete(provider, settings, key, body):
                if piece["type"] == "end":
                    piece = {**piece, "provider": provider, "model": settings["model"]}
                    if isinstance(piece.get("usage"), dict):
                        _log_usage(provider, settings["model"], piece["usage"])
                    if guest and provider == "anthropic":
                        cost = spending.anthropic_cost(settings["model"], piece.get("usage"))
                        await run_in_threadpool(spending.add, user_id, provider, cost)
                yield json.dumps(piece) + "\n"
        except Exception:
            # A failure while streaming rides the turn to the chat, not a separate
            # event (architecture.md 12, "Remote-only facts fail offline").
            yield json.dumps({"type": "end", "status": "failed", "error": "unavailable", "provider": provider, "model": settings["model"]}) + "\n"

    # X-Accel-Buffering off so a proxy does not hold the pieces back (6.3).
    return StreamingResponse(lines(), media_type="application/x-ndjson", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _decide(user_id: str, state: dict, questions: list, guest: bool = False) -> dict:
    if guest:
        refused = spending.refusal(user_id, "jev")
        if refused:
            return {"error": refused}
        key = spending.guest_key("jev")
        if key is None:
            # A guest key that cannot be read (a rotated secret) is no guest key.
            return {"error": "paused"}
        reply = jev_adapter.decide(key, state, questions)
        if "answers" in reply:
            spending.add(user_id, "jev", spending.jev_cost(reply["inputTokens"]))
        return reply
    with _connect(user_id) as connection:
        settings = _settings(connection)
        key = _key(connection, "jev")
    if settings["decider"] == "ollama":
        return _decide_local(settings["address"], settings["deciderModel"], state, questions)
    if key is None:
        # The error rides the reply, as complete's does, so the asker shows it.
        return {"error": "no-key"}
    return jev_adapter.decide(key, state, questions)


def _decide_local(address: str, chosen: str | None, state: dict, questions: list) -> dict:
    # A model on the user's own Mac needs no key, costs nothing and is not counted
    # (3.4, 7.7). Asking Ollama for its models first tells "not running" from "not
    # downloaded".
    models = _ollama_models(address)
    if models is None:
        return {"error": "local-off"}
    model = _decision_model(models, chosen)
    if model is None:
        return {"error": "no-model"}
    return jev_adapter.decide_local(address, model, state, questions)


def _options_ok(options) -> bool:
    # Jev takes at most 255 options and knows each by its name, so names must be
    # non-empty and differ within a question (decide.json).
    if not isinstance(options, list) or not 2 <= len(options) <= 255:
        return False
    names = set()
    for o in options:
        if not isinstance(o, dict) or not isinstance(o.get("id"), str):
            return False
        name, description = o.get("name"), o.get("description", "")
        if not isinstance(name, str) or not name or name in names or not isinstance(description, str):
            return False
        names.add(name)
    return True


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
        kind = q.get("kind", "yesno")
        if kind == "pick":
            if not _options_ok(q.get("options")):
                return None
        elif kind != "yesno" or "options" in q:
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
    state, questions = parsed
    return await run_in_threadpool(_decide, user_id, state, questions, _guest(request))


def _generate(user_id: str, model: str, prompt: str, text: str) -> dict:
    # Echo needs no key and calls nothing, for any signed-in account (12).
    if model == "echo":
        reply = echo_adapter.generate(text)
        _log_usage("echo", model, reply["usage"])
        return {"text": reply["text"]}
    if local_user():
        return _generate_local(user_id, model, prompt, text)
    # The account's own Anthropic key, independent of the chat's provider: a generator
    # runs on the model it names.
    with _connect(user_id) as connection:
        key = _key(connection, "anthropic")
    if key is None:
        return {"error": "no-key"}
    if model not in {m["id"] for m in _models(user_id, "anthropic", key)}:
        # A model the key does not offer (renamed, retired, or a list that failed).
        return {"error": "unavailable"}
    return _generate_anthropic(key, model, prompt, text)


def _generate_anthropic(key: str, model: str, prompt: str, text: str) -> dict:
    reply = anthropic_adapter.generate(key, model, prompt, text)
    if "error" in reply:
        return {"error": reply["error"]}
    _log_usage("anthropic", model, reply["usage"])
    return {"text": reply["text"]}


def _generate_local(user_id: str, model: str, prompt: str, text: str) -> dict:
    # On the Mac a generator runs on the chat's provider (3.4): on the model it names
    # when that provider offers it, otherwise on the chat model, so a generator left at
    # the website's default runs on Gemma in Ollama, with no key and no cost (7.7).
    settings, key = _for_completion(user_id)
    provider = settings["provider"]
    models = {m["id"] for m in _models(user_id, provider, key, settings["address"])}
    chosen = model if model in models else settings["model"]
    if not chosen:
        # Ollama is not running, or has no model downloaded; Anthropic without a key.
        return {"error": "unavailable" if provider == "ollama" else "no-key"}
    if provider == "echo":
        return _generate(user_id, "echo", prompt, text)
    if provider == "ollama":
        reply = openai_adapter.generate(settings["base_url"], key, chosen, prompt, text)
        if "error" in reply:
            return {"error": reply["error"]}
        _log_usage("ollama", chosen, reply["usage"])
        return {"text": reply["text"]}
    return _generate_anthropic(key, chosen, prompt, text)


@router.post("/generate")
async def do_generate(request: Request, user_id: str = Depends(require_user)):
    try:
        body = await request.json()
    except ValueError:
        body = None
    fields = ("model", "prompt", "text")
    if (
        not isinstance(body, dict)
        or set(body) != set(fields)
        or not all(isinstance(body[f], str) for f in fields)
        or not body["model"]
        or not body["prompt"]
    ):
        return JSONResponse({"error": "bad-request"}, status_code=400)
    # Generators belong to an account with a passkey; a guest spends only through the
    # tools a try page offers (7.7), so it is refused as not signed in.
    if _guest(request):
        return {"error": "signed-out"}
    return await run_in_threadpool(_generate, user_id, body["model"], body["prompt"], body["text"])


@router.get("/spending")
async def read_spending(request: Request, user_id: str = Depends(require_user)):
    # Only the admin sees what guests spent (12); anyone else is told so in the reply.
    if not _admin(request):
        return {"error": "not-admin"}
    return await run_in_threadpool(spending.summary)


async def _admin_edit(request: Request, valid, apply):
    if not _admin(request):
        return JSONResponse({"error": "not-admin"}, status_code=403)
    try:
        body = valid(await request.json())
    except ValueError:
        body = None
    if body is None:
        # Never echoed: a guest key may be in it.
        return JSONResponse({"error": "bad-request"}, status_code=400)
    await run_in_threadpool(apply, body)
    return await run_in_threadpool(spending.summary)


@router.put("/limits")
async def edit_limits(request: Request, user_id: str = Depends(require_user)):
    return await _admin_edit(request, spending.valid_limits, spending.set_limits)


@router.put("/guestkeys")
async def edit_guest_keys(request: Request, user_id: str = Depends(require_user)):
    return await _admin_edit(request, spending.valid_keys, spending.set_keys)


@router.put("/guestkeys/step")
async def step_guest_keys(request: Request, user_id: str = Depends(require_user)):
    # Undo or Redo of a guest key step (12), refused when a key changed since.
    if not _admin(request):
        return JSONResponse({"error": "not-admin"}, status_code=403)
    body = keysteps.valid_move(await _body(request))
    if body is None:
        return JSONResponse({"error": "bad-request"}, status_code=400)
    if not await run_in_threadpool(spending.move_keys, body):
        return {"error": "changed"}
    return await run_in_threadpool(spending.summary)


@router.put("/guestkeys/forget")
async def forget_guest_keys(request: Request, user_id: str = Depends(require_user)):
    return await _admin_edit(request, spending.valid_forget_keys, spending.forget_keys)


@router.put("/blocked")
async def edit_blocked(request: Request, user_id: str = Depends(require_user)):
    return await _admin_edit(request, spending.valid_block, spending.set_blocked)


@router.put("/forget")
async def edit_forget(request: Request, user_id: str = Depends(require_user)):
    return await _admin_edit(request, spending.valid_forget, spending.forget)


@router.put("/reset")
async def edit_reset(request: Request, user_id: str = Depends(require_user)):
    return await _admin_edit(request, spending.valid_reset, spending.reset)
