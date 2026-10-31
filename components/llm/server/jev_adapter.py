"""Jev, typesafe.ai's System One model, behind `llm: decide`. It answers yes/no
questions about one state with the probability of yes, and pick-one questions with the
option it picks and every option's probability; it writes no text. Ollama on the user's
Mac (3.4) answers the same request at its own /v1/systemone with the decision model
kev:0.8b-mlx-bf16, without a key, so `decide_local` reuses everything here. The
standard library's urllib makes the call, because the import check allows only the
standard library and what requirements.txt names (11.2). The key and the body are never
logged: the body may hold the user's own writing.
"""

import json
import os
import time
import urllib.error
import urllib.request

# UNBLENT_JEV_URL points a throwaway server at a local stand-in for Jev, so a guest's
# Run can be tried by hand without spending money or using a real key.
_URL = os.environ.get("UNBLENT_JEV_URL") or "https://api.typesafe.ai/v1/systemone"
# Jev answers in about 300 ms, so a request with no answer after 5 s has stalled; one
# stall is retried once, which keeps the worst wait near 10 s instead of one long hang.
_TIMEOUT = 5
_TRIES = 2

# HTTP statuses Jev answers with, mapped onto the reply's error codes; anything else
# is "unavailable", which is all the user can act on.
_ERRORS = {401: "bad-key", 422: "invalid", 429: "rate-limited", 529: "overloaded"}

# The first request after Ollama starts loads the model into memory, which on a Mac can
# take far longer than Jev's 300 ms; asking again would only load it twice.
_LOCAL_TIMEOUT = 60
_LOCAL_TRIES = 1


def _jev_error(status: int, text: str) -> str:
    return _ERRORS.get(status, "unavailable")


def _local_error(status: int, text: str) -> str:
    # Ollama answers 404 with a message for a model that is not downloaded.
    return "no-model" if status == 404 or "not found" in text.lower() else "unavailable"


def body(state: dict, questions: list, model: str = "jev-latest") -> dict:
    asked = {}
    for q in questions:
        if q.get("kind") == "pick":
            # Jev knows an option by its name, and takes null for an option whose name
            # says enough; criteria itself is required for a choice.
            asked[q["id"]] = {
                "type": "choice",
                "instructions": q["instructions"],
                "criteria": {o["name"]: (o.get("description") or None) for o in q["options"]},
            }
            continue
        item = {"type": "noul", "instructions": q["instructions"]}
        yes, no = q.get("yes") or "", q.get("no") or ""
        # One-sided criteria would describe only half the scale, so criteria go only
        # when both sides are written.
        if yes and no:
            item["criteria"] = {"true": yes, "false": no}
        asked[q["id"]] = item
    return {"state": state, "model": model, "questions": asked}


def _refused(error: Exception) -> bool:
    return isinstance(getattr(error, "reason", error), ConnectionRefusedError)


def send(
    key: str | None,
    payload: dict,
    url: str = _URL,
    timeout: float = _TIMEOUT,
    tries: int = _TRIES,
    errors=_jev_error,
    refused: str = "unavailable",
) -> tuple[dict | None, str | None, int]:
    """One POST: the reply as JSON, or the error code, and the time it took. `refused`
    is the code for nothing listening at the address."""
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    for attempt in range(tries):
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                reply = json.loads(response.read())
        except urllib.error.HTTPError as error:
            # The server answered; asking again would get the same answer.
            try:
                text = error.read().decode(errors="replace")
            except Exception:
                text = ""
            return None, errors(error.code, text), 0
        except (TimeoutError, urllib.error.URLError, ConnectionError) as error:
            if attempt + 1 < tries:
                continue
            return None, refused if _refused(error) else "unavailable", 0
        except Exception:
            return None, "unavailable", 0
        return reply, None, int((time.monotonic() - started) * 1000)


def decide(key: str, state: dict, questions: list) -> dict:
    reply, error, ms = send(key, body(state, questions))
    if error:
        return {"error": error}
    return parse(reply, questions, ms)


def decide_local(address: str, model: str, state: dict, questions: list) -> dict:
    """The same questions asked of `model` in Ollama at `address`, with no key."""
    reply, error, ms = send(
        None, body(state, questions, model), f"{address}/v1/systemone",
        _LOCAL_TIMEOUT, _LOCAL_TRIES, _local_error, "local-off",
    )
    if error:
        return {"error": error}
    return parse(reply, questions, ms)


def _probability(value) -> float:
    p = float(value)
    if not 0 <= p <= 1:
        raise ValueError(p)
    return p


def parse(reply, questions: list, ms: int = 0) -> dict:
    """Jev's reply as our answers, by our question and option ids. Anything that does
    not have the shape Jev documents is "unavailable", never a guess."""
    try:
        answers = reply["answers"]
        out = []
        for q in questions:
            answer = answers[q["id"]]
            if q.get("kind") != "pick":
                out.append({"id": q["id"], "p": _probability(answer["noul"])})
                continue
            by_name = {o["name"]: o["id"] for o in q["options"]}
            spread = answer["probabilities"]
            probabilities = [{"id": by_name[name], "p": _probability(spread[name])} for name in by_name]
            choice = by_name[answer["choice"]]
            picked = {
                "id": q["id"],
                "p": next(item["p"] for item in probabilities if item["id"] == choice),
                "choice": choice,
                "probabilities": probabilities,
            }
            # Ollama's systemone does not document a confidence, so a pick comes
            # without one rather than with a guess.
            if answer.get("confidence") is not None:
                picked["confidence"] = _probability(answer["confidence"])
            out.append(picked)
        usage = reply.get("usage") or {}
        tokens = int(usage.get("input_tokens") or 0)
    except (KeyError, TypeError, ValueError, AttributeError):
        return {"error": "unavailable"}
    return {"answers": out, "inputTokens": tokens, "ms": ms}
