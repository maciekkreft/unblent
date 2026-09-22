"""The provider-neutral interface and the shared layer above the adapters
(architecture.md 10, 7.7). Our contract is provider-neutral: each provider is one
adapter file behind this interface. The shared layer runs once per completion; it
maps our "target: name" tools to what a provider allows and back, and validates
every tool input a model proposes against the query's own payload schema before it
reaches the browser (7.7), because a model's proposed input is untrusted.

An adapter is an async generator yielding neutral pieces, one per line of the
streamed reply (6.3):
  {"type": "text", "text": delta}        a piece of the answer text
  {"type": "thinking", "text": delta}    a piece of the readable thinking, if any
  {"type": "call", "id", "name", "payload"}   a tool call in provider name space
  {"type": "end", "status", "raw"?, "usage"?, "error"?}   how it ended; raw only on done
The shared layer turns each provider-named call into {target, name, payload} and
adds "invalid" when the payload does not match the tool's schema.
"""

from collections.abc import AsyncIterator

from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

from . import anthropic_adapter, echo_adapter


def provider_tool_name(target: str, name: str) -> str:
    """Our "target: name" as one token a provider accepts, e.g. books__chapter for
    books: chapter. Mapped back the same way, per request, never parsed by guess."""
    return f"{target}__{name}"


async def complete(provider: str, settings: dict, key: str | None, request: dict) -> AsyncIterator[dict]:
    tools = request.get("tools") or []
    forward = []  # the tool definitions a provider is given, in its name space
    back = {}  # provider name -> our neutral tool
    validators = {}
    for tool in tools:
        pname = provider_tool_name(tool["target"], tool["name"])
        forward.append({"name": pname, "description": tool.get("description", ""), "input_schema": tool["payload"]})
        back[pname] = tool
        validators[pname] = Draft202012Validator(tool["payload"])
    stream = echo_adapter.stream if provider == "echo" else anthropic_adapter.stream
    # The adapter maps a replayed call back to the provider's tool name; give it the
    # mapping, since this module imports the adapter and the adapter cannot import back.
    async for piece in stream(settings, key, request, forward, provider_tool_name):
        yield _named(piece, back, validators) if piece["type"] == "call" else piece


def _named(piece: dict, back: dict, validators: dict) -> dict:
    pname = piece["name"]
    tool = back.get(pname)
    payload = piece.get("payload", {})
    if tool is None:
        # A name we never offered: name it back as best we can and mark it, so the
        # loop answers with an error result rather than asking an unknown query.
        target, _, name = pname.partition("__")
        return {"type": "call", "id": piece["id"], "target": target, "name": name, "payload": payload, "invalid": "unknown tool"}
    call = {"type": "call", "id": piece["id"], "target": tool["target"], "name": tool["name"], "payload": payload}
    error = best_match(validators[pname].iter_errors(payload))
    if error is not None:
        call["invalid"] = error.message
    return call
