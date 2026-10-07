"""Jev, typesafe.ai's System One model, behind `llm: decide` (plan: Gauge). It answers
yes/no questions about one state with the probability of yes, and writes no text. The
standard library's urllib makes the call, because the import check allows only the
standard library and what requirements.txt names (11.2). The key and the body are never
logged: the body may hold the user's own writing.
"""

import json
import time
import urllib.error
import urllib.request

_URL = "https://api.typesafe.ai/v1/systemone"
_TIMEOUT = 20

# HTTP statuses Jev answers with, mapped onto the reply's error codes; anything else
# is "unavailable", which is all the user can act on.
_ERRORS = {401: "bad-key", 422: "invalid", 429: "rate-limited", 529: "overloaded"}


def body(state: dict, questions: list) -> dict:
    asked = {}
    for q in questions:
        item = {"type": "noul", "instructions": q["instructions"]}
        yes, no = q.get("yes") or "", q.get("no") or ""
        # One-sided criteria would describe only half the scale, so criteria go only
        # when both sides are written.
        if yes and no:
            item["criteria"] = {"true": yes, "false": no}
        asked[q["id"]] = item
    return {"state": state, "model": "jev-latest", "questions": asked}


def decide(key: str, state: dict, questions: list) -> dict:
    request = urllib.request.Request(
        _URL,
        data=json.dumps(body(state, questions)).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            reply = json.loads(response.read())
    except urllib.error.HTTPError as error:
        return {"error": _ERRORS.get(error.code, "unavailable")}
    except Exception:
        return {"error": "unavailable"}
    ms = int((time.monotonic() - started) * 1000)
    try:
        answers = reply["answers"]
        out = [{"id": q["id"], "p": float(answers[q["id"]]["noul"])} for q in questions]
    except (KeyError, TypeError, ValueError):
        return {"error": "unavailable"}
    usage = reply.get("usage") or {}
    return {"answers": out, "inputTokens": int(usage.get("input_tokens") or 0), "ms": ms}
