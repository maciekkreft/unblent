"""The Anthropic provider (architecture.md 10): the official Python client behind
our neutral interface. It streams a completion, mapping our turns to the provider's
messages and its stream events back to our neutral pieces. This session sends no
tools; the tool-use mapping is added when the chat first reads the library.
"""

import anthropic
from anthropic import Anthropic, AsyncAnthropic


def list_models(key: str) -> list[dict]:
    """The account's available models, listed with the user's key. Called from the
    read route (in a threadpool), cached per user by the router."""
    result = Anthropic(api_key=key).models.list(limit=100)
    return [{"id": model.id, "label": model.display_name} for model in result.data]


async def stream(settings, key, request, forward):
    if not key:
        yield {"type": "end", "status": "failed", "error": "bad-key"}
        return
    model = settings["model"]
    ttl = settings["ttl"]
    messages = _messages(request.get("turns") or [], settings)
    kwargs = dict(
        model=model,
        # Streaming lets max_tokens be generous without an HTTP timeout (claude-api
        # skill); 32000 is well within every current model's output cap.
        max_tokens=32000,
        # The start is written once and cached, so a follow-up in the same chat reads
        # it from the provider's cache (7.7); the growing conversation is cached at its
        # last block, both with the account's chosen lifetime.
        system=[{"type": "text", "text": request.get("start", ""), "cache_control": {"type": "ephemeral", "ttl": ttl}}],
        messages=messages,
        thinking={"type": "adaptive", "display": "summarized"},
    )
    if settings["effort"] != "default":
        kwargs["output_config"] = {"effort": settings["effort"]}
    _cache_tail(messages, ttl)
    try:
        async with client_for(key).messages.stream(**kwargs) as reply:
            async for event in reply:
                if event.type == "content_block_delta":
                    delta = event.delta
                    if delta.type == "text_delta":
                        yield {"type": "text", "text": delta.text}
                    elif delta.type == "thinking_delta":
                        yield {"type": "thinking", "text": delta.thinking}
            final = await reply.get_final_message()
        yield _end(final)
    except anthropic.AuthenticationError:
        yield {"type": "end", "status": "failed", "error": "bad-key"}
    except anthropic.RateLimitError:
        yield {"type": "end", "status": "failed", "error": "rate-limited"}
    except anthropic.APIStatusError as error:
        yield {"type": "end", "status": "failed", "error": _status_error(error)}
    except anthropic.APIConnectionError:
        yield {"type": "end", "status": "failed", "error": "unavailable"}


def client_for(key: str) -> AsyncAnthropic:
    return AsyncAnthropic(api_key=key)


def _status_error(error) -> str:
    if error.status_code == 529:
        return "overloaded"
    if error.status_code >= 500:
        return "unavailable"
    if error.status_code == 400:
        # The API's own message, never the request body: it does not carry the key.
        return error.message
    return "unavailable"


def _messages(turns, settings):
    provider, model = settings["provider"], settings["model"]
    messages = []
    for turn in turns:
        if turn.get("role") == "user":
            content = []
            for result in turn.get("results") or []:
                block = {"type": "tool_result", "tool_use_id": result["callId"], "content": result.get("content", "")}
                if result.get("isError"):
                    block["is_error"] = True
                content.append(block)
            if turn.get("text"):
                content.append({"type": "text", "text": turn["text"]})
            if content:
                messages.append({"role": "user", "content": content})
        else:
            raw = turn.get("raw")
            if raw and turn.get("provider") == provider and turn.get("model") == model:
                # Sent back exactly as this model produced it, so thinking blocks
                # replay unchanged and the provider's cache holds (7.7).
                messages.append({"role": "assistant", "content": raw})
            elif turn.get("text") or turn.get("calls"):
                messages.append({"role": "assistant", "content": [{"type": "text", "text": turn.get("text", "")}]})
    return messages


def _cache_tail(messages, ttl):
    if not messages:
        return
    content = messages[-1]["content"]
    if content and isinstance(content[-1], dict):
        content[-1] = {**content[-1], "cache_control": {"type": "ephemeral", "ttl": ttl}}


def _end(final):
    reason = final.stop_reason
    if reason == "refusal":
        status, error = "refused", (final.stop_details.explanation if final.stop_details else None)
    elif reason == "max_tokens":
        # A cut-off answer keeps its text but drops any call it had started (7.7).
        status, error = "truncated", None
    else:
        status, error = "done", None
    piece = {"type": "end", "status": status, "usage": final.usage.model_dump(mode="json")}
    if status == "done":
        piece["raw"] = final.model_dump(mode="json")["content"]
    if error:
        piece["error"] = error
    return piece
