"""Jev, typesafe.ai's System One model, behind `llm: decide`. It answers yes/no
questions about one state with the probability of yes, and pick-one questions with the
option it picks and every option's probability; it writes no text. The
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
    return {"state": state, "model": "jev-latest", "questions": asked}


def send(key: str, payload: dict) -> tuple[dict | None, str | None, int]:
    """One POST to Jev: its reply as JSON, or the error code, and the time it took."""
    request = urllib.request.Request(
        _URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
            reply = json.loads(response.read())
    except urllib.error.HTTPError as error:
        return None, _ERRORS.get(error.code, "unavailable"), 0
    except Exception:
        return None, "unavailable", 0
    return reply, None, int((time.monotonic() - started) * 1000)


def decide(key: str, state: dict, questions: list) -> dict:
    reply, error, ms = send(key, body(state, questions))
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
            out.append({
                "id": q["id"],
                "p": next(item["p"] for item in probabilities if item["id"] == choice),
                "choice": choice,
                "probabilities": probabilities,
                "confidence": _probability(answer["confidence"]),
            })
        usage = reply.get("usage") or {}
        tokens = int(usage.get("input_tokens") or 0)
    except (KeyError, TypeError, ValueError, AttributeError):
        return {"error": "unavailable"}
    return {"answers": out, "inputTokens": tokens, "ms": ms}
