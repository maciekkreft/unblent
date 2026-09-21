"""The Echo provider: a stand-in for a real model that needs no key and no network
call, so tests and by-hand checks never spend money (architecture.md 12, "Echo is a
test provider"). It streams in small pieces with short pauses and answers from the
last user turn: it repeats the text; on lines of the form "/tool <target>: <name>
<json>" it asks for those calls exactly as a model would; and when a round's results
come back it repeats them, so the markdown a real model would receive can be read on
screen. The commands /think, /slow, /fail and /long drive the thinking record, Stop,
"Try again" and scrolling.
"""

import asyncio
import json
import re

_PIECE = 0.01  # a pause between pieces, so the browser sees the answer grow
_SLOW = 0.3  # /slow: long enough to Stop mid-answer
_TOOL = re.compile(r"([^:]+):\s*(\S+)\s*(.*)")


async def stream(settings, key, request, forward):
    turns = request.get("turns") or []
    last = _last_user(turns)
    text = (last.get("text") if last else "") or ""
    results = last.get("results") if last else None

    # A round returned: repeat the results, so what a model would read is on screen.
    if results:
        combined = "\n\n".join(r.get("content", "") for r in results)
        async for piece in _text(combined, _PIECE):
            yield piece
        yield _done(combined)
        return

    lines = text.splitlines()
    tool_lines = [line for line in lines if line.startswith("/tool ")]
    if tool_lines:
        for index, line in enumerate(tool_lines):
            call = _call(line, index)
            if call:
                yield call
        yield {"type": "end", "status": "done", "raw": [{"type": "text", "text": ""}], "usage": _usage(text)}
        return

    command = lines[0].split()[0] if lines and lines[0].startswith("/") else ""
    if command == "/fail":
        yield {"type": "end", "status": "failed", "error": "echo-failure"}
        return

    if command == "/think":
        for thought in ("Considering the question", " and how to answer it", "…"):
            await asyncio.sleep(_PIECE)
            yield {"type": "thinking", "text": thought}

    body = "Echo. " * 200 if command == "/long" else text
    pause = _SLOW if command == "/slow" else _PIECE
    async for piece in _text(body, pause):
        yield piece
    yield _done(body)


async def _text(text, pause):
    for start in range(0, len(text), 12):
        await asyncio.sleep(pause)
        yield {"type": "text", "text": text[start : start + 12]}


def _done(full):
    return {"type": "end", "status": "done", "raw": [{"type": "text", "text": full}], "usage": _usage(full)}


def _usage(text):
    # Made-up figures, including a cache read, so the by-hand run shows cache reads.
    return {"input_tokens": 24, "output_tokens": max(1, len(text) // 4), "cache_read_input_tokens": 8, "cache_creation_input_tokens": 0}


def _call(line, index):
    match = _TOOL.match(line[len("/tool ") :].strip())
    if not match:
        return None
    target, name, payload_text = match.group(1).strip(), match.group(2).strip(), (match.group(3).strip() or "{}")
    try:
        payload = json.loads(payload_text)
    except ValueError:
        payload = {}
    return {"type": "call", "id": f"echo-call-{index}", "name": f"{target}__{name}", "payload": payload}


def _last_user(turns):
    for turn in reversed(turns):
        if turn.get("role") == "user":
            return turn
    return None
