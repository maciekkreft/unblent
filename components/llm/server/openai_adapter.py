"""An OpenAI-compatible provider (architecture.md 10): the official `openai` client
behind our neutral interface, used for a model server that speaks the chat completions
API, such as Ollama on the user's own Mac (3.4). It streams a completion, mapping our
turns to chat messages and the streamed deltas back to our neutral pieces. It offers
the model the chat's tools (7.7) as functions, replays a prior round's calls and
results as the assistant's tool_calls and "tool" messages, and joins each new call's
streamed fragments into one neutral `call` piece.

settings["base_url"] names the server; the router sets it, e.g. Ollama's address plus
/v1. Nothing is replayed raw: the chat completions API takes back no reasoning, so a
turn is always rebuilt from its text and calls.
"""

import json

import openai
from openai import AsyncOpenAI, OpenAI

# Settings' Thinking On and Off as the reasoning_effort Ollama reads: "none" asks
# for no thinking, and a named effort turns it on for a model that only knows on or
# off (Ollama's OpenAI compatibility).
_REASONING = {"on": "medium", "off": "none"}


def list_models(base_url: str, key: str, timeout: float = 2.0) -> list[dict]:
    """The models the server has, e.g. the ones downloaded in Ollama. A short timeout
    and no retries, so a stopped server answers at once (the read picture waits on it).
    Raises when the server cannot be reached."""
    result = OpenAI(base_url=base_url, api_key=key, timeout=timeout, max_retries=0).models.list()
    return [{"id": model.id, "label": model.id.removesuffix(":latest")} for model in result.data]


async def stream(settings, key, request, forward, tool_name):
    kwargs = dict(
        model=settings["model"],
        messages=_messages(request, tool_name),
        stream=True,
        stream_options={"include_usage": True},
    )
    if forward:
        # Sorted by name so the request is the same each round (7.7: the cache holds).
        kwargs["tools"] = [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}
            for t in sorted(forward, key=lambda t: t["name"])
        ]
    effort = _REASONING.get(settings.get("effort"))
    if effort:
        kwargs["reasoning_effort"] = effort
    # No retries: a refused connection must end the turn at once with local-off, not
    # after a back-off the user waits through.
    client = AsyncOpenAI(base_url=settings["base_url"], api_key=key or "none", max_retries=0)
    calls: dict[int, dict] = {}
    finish = None
    usage = None
    try:
        async for chunk in await client.chat.completions.create(**kwargs):
            if chunk.usage is not None:
                usage = _usage(chunk.usage)
            for choice in chunk.choices:
                delta = choice.delta
                # Ollama streams thinking as `reasoning`, others as `reasoning_content`;
                # neither is a field of the client's model, so it is read as an extra.
                extra = delta.model_extra or {}
                thinking = extra.get("reasoning") or extra.get("reasoning_content")
                if isinstance(thinking, str) and thinking:
                    yield {"type": "thinking", "text": thinking}
                if delta.content:
                    yield {"type": "text", "text": delta.content}
                for part in delta.tool_calls or []:
                    call = calls.setdefault(part.index, {"id": "", "name": "", "arguments": ""})
                    if part.id:
                        call["id"] = part.id
                    if part.function and part.function.name:
                        call["name"] += part.function.name
                    if part.function and part.function.arguments:
                        call["arguments"] += part.function.arguments
                if choice.finish_reason:
                    finish = choice.finish_reason
    except openai.APITimeoutError:
        yield {"type": "end", "status": "failed", "error": "unavailable"}
        return
    except openai.APIConnectionError:
        # Nothing listens at the address: on this Mac that means Ollama is not running.
        yield {"type": "end", "status": "failed", "error": "local-off" if settings.get("provider") == "ollama" else "unavailable"}
        return
    except openai.AuthenticationError:
        yield {"type": "end", "status": "failed", "error": "bad-key"}
        return
    except openai.RateLimitError:
        yield {"type": "end", "status": "failed", "error": "rate-limited"}
        return
    except openai.APIStatusError as error:
        yield {"type": "end", "status": "failed", "error": _status_error(error)}
        return
    end = _end(finish, usage)
    # A call only counts when the answer truly finished; a cut-off one may hold half its
    # arguments and must never run (7.7). Calls ride before the end piece (6.3).
    if end["status"] == "done":
        for index in sorted(calls):
            call = calls[index]
            yield {"type": "call", "id": call["id"] or f"call_{index}", "name": call["name"], "payload": _arguments(call["arguments"])}
    yield end


def _arguments(text: str) -> dict:
    # Unreadable arguments become an empty payload, which the shared layer checks
    # against the tool's schema like any other input (7.7).
    try:
        value = json.loads(text) if text else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _status_error(error) -> str:
    if error.status_code >= 500:
        return "unavailable"
    if error.status_code in (400, 404):
        # The server's own message (a model Ollama does not have), never the request body.
        return error.message
    return "unavailable"


def _usage(usage) -> dict:
    # The neutral keys the router logs (llm usage line): input counts only what was not
    # read from the server's cache, as Anthropic reports it.
    details = getattr(usage, "prompt_tokens_details", None)
    cached = int(getattr(details, "cached_tokens", 0) or 0) if details else 0
    return {
        "input_tokens": max(int(usage.prompt_tokens or 0) - cached, 0),
        "cache_read_input_tokens": cached,
        "cache_creation_input_tokens": 0,
        "output_tokens": int(usage.completion_tokens or 0),
    }


def _end(finish, usage) -> dict:
    if finish == "length":
        status = "truncated"
    elif finish == "content_filter":
        status = "refused"
    else:
        status = "done"
    piece = {"type": "end", "status": status}
    if usage is not None:
        piece["usage"] = usage
    return piece


def _messages(request, tool_name) -> list[dict]:
    messages = [{"role": "system", "content": request.get("start", "")}]
    for turn in request.get("turns") or []:
        if turn.get("role") == "user":
            # Every result answers a call of the assistant message just before, so the
            # "tool" messages come first, then any text the user wrote.
            for result in turn.get("results") or []:
                content = result.get("content", "")
                if result.get("isError"):
                    content = f"Error: {content}"
                messages.append({"role": "tool", "tool_call_id": result["callId"], "content": content})
            if turn.get("text"):
                messages.append({"role": "user", "content": turn["text"]})
        elif turn.get("text") or turn.get("calls"):
            message = {"role": "assistant", "content": turn.get("text") or ""}
            if turn.get("calls"):
                message["tool_calls"] = [
                    {
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": tool_name(call["target"], call["name"]), "arguments": json.dumps(call.get("payload", {}))},
                    }
                    for call in turn["calls"]
                ]
            messages.append(message)
    return messages
