"""The relay of the connected local edition (architecture.md 3.4): while this Mac holds
a device sign-in that is on, every /api/* request except /api/session/connect/* goes to
the account's server with that sign-in in place of the browser's cookie, and its answer
comes back streamed. The browser code calls the same addresses either way.

It is plain ASGI rather than a FastAPI route, so a request body and an answer stream
through without being held (a book upload, a model's answer arriving piece by piece).
On the web edition it passes every request straight on and does nothing else.
"""

import hashlib
import json
import os
import tempfile
from http.cookies import CookieError, SimpleCookie

import httpx
from starlette.datastructures import Headers

from server.user import DATA, SESSION_COOKIE, connection, cross_site, local_user, remote, save_remote

CACHE = DATA / "remote-cache"

# Five seconds to reach the account, then no limit: a model's answer may take minutes.
_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=None, pool=5.0)

# Hop-by-hop headers belong to one connection, not to the request (RFC 9110 7.6.1).
_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
        "trailer", "transfer-encoding", "upgrade"}
# The browser's cookie and its own address mean nothing to the account's server.
_NOT_UPSTREAM = _HOP | {"host", "cookie", "origin", "referer", "x-unblent-local"}
# Set-Cookie is the account's sign-in for this Mac, kept by the relay, never the browser's.
_NOT_BACK = _HOP | {"set-cookie"}

_client: httpx.AsyncClient | None = None


class _Left(Exception):
    """The browser went away while its request body was still arriving (3.4)."""


def _relayed(path: str) -> bool:
    # Connecting and disconnecting are this Mac's own business, connected or not (3.4).
    return path.startswith("/api/") and not (
        path == "/api/session/connect" or path.startswith("/api/session/connect/"))


def _upstream(client_headers: Headers, token: str, url: str) -> list[tuple[str, str]]:
    headers = [(k, v) for k, v in client_headers.items() if k not in _NOT_UPSTREAM]
    # The account's server checks a passkey's Origin and a write's site against its own.
    return headers + [("cookie", f"{SESSION_COOKIE}={token}"), ("origin", url)]


def _rotated(set_cookies: list[str]) -> str | None:
    """The account's new sign-in for this Mac when its answer sets one; a cookie it
    clears is no sign-in, and the old one stays until the account says otherwise."""
    for line in set_cookies:
        try:
            jar = SimpleCookie(line)
        except CookieError:
            continue
        morsel = jar.get(SESSION_COOKIE)
        if morsel and morsel.value and morsel["max-age"] not in ("0", 0):
            return morsel.value
    return None


def _cache_paths(path: str, query: bytes):
    name = hashlib.sha256((path + ("?" + query.decode("latin-1") if query else "")).encode()).hexdigest()
    return CACHE / name, CACHE / f"{name}.json"


def _write(target, data: bytes) -> None:
    # Whole or not at all, so a half-written body is never served as a book's chapter.
    CACHE.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=CACHE, prefix=".part-")
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        os.replace(temporary, target)
    except BaseException:
        os.unlink(temporary)
        raise


async def _json(send, status: int, body: dict, extra: list[tuple[bytes, bytes]] = ()) -> None:
    raw = json.dumps(body).encode()
    await send({"type": "http.response.start", "status": status, "headers": [
        (b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode()),
        (b"cache-control", b"no-store"), *extra]})
    await send({"type": "http.response.body", "body": raw})


class Relay:
    """ASGI middleware mounted around every router (3.4)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not local_user():
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        port = (scope.get("server") or (None, None))[1]
        # No page on another site may make the Mac's server act, connected or not (3.4).
        # A top-level visit that only reads is let through: Safari coming back from the
        # web connect page, and the app's window opening the Mac page from its loading page.
        reading = scope["method"] in ("GET", "HEAD") and headers.get("sec-fetch-mode") == "navigate"
        if not reading and cross_site(headers, port):
            return await _json(send, 403, {"detail": "cross-site"})
        held = remote()
        if (not held or held["state"] != "on" or not _relayed(scope["path"])
                or headers.get("x-unblent-local") == "1"):
            return await self.app(scope, receive, send)
        await self._forward(scope, receive, send, headers, held)

    async def _forward(self, scope, receive, send, headers: Headers, held: dict) -> None:
        global _client
        method, path, query = scope["method"], scope["path"], scope.get("query_string", b"")
        body_path, meta_path = _cache_paths(path, query)
        if method == "GET" and meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text())
                kept = body_path.read_bytes()
            except (OSError, ValueError):
                pass
            else:
                await send({"type": "http.response.start", "status": meta["status"], "headers": [
                    (k.encode("latin-1"), v.encode("latin-1")) for k, v in meta["headers"]]})
                await send({"type": "http.response.body", "body": kept})
                return

        url = held["url"].rstrip("/")
        has_body = "content-length" in headers or "transfer-encoding" in headers

        async def body():
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    raise _Left()
                if message.get("body"):
                    yield message["body"]
                if not message.get("more_body"):
                    return

        if _client is None:
            _client = httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False)
        request = _client.build_request(
            method, url + path + ("?" + query.decode("latin-1") if query else ""),
            headers=_upstream(headers, held["token"], url),
            content=body() if has_body else None,
        )
        try:
            answer = await _client.send(request, stream=True)
        except _Left:
            return
        except httpx.TransportError:
            # Unreachable: every fact treats a 503 as offline and keeps its outbox (5).
            return await _json(send, 503, {"error": "offline"})
        try:
            token = _rotated(answer.headers.get_list("set-cookie"))
            if token and token != held["token"]:
                save_remote({**held, "token": token})
            back = [(k, v) for k, v in answer.headers.multi_items() if k.lower() not in _NOT_BACK]
            if method == "GET" and path == "/api/session/me" and answer.status_code == 200:
                # The Mac's picture of the connection rides the account's own answer, also
                # when the account says signed out: then sync was turned off (3.4).
                try:
                    picture = json.loads(await answer.aread())
                except ValueError:
                    picture = None
                if isinstance(picture, dict):
                    return await _json(send, 200, {**picture, **connection(), "connect": "on"})
                return await _json(send, 503, {"error": "offline"})
            keep = (method == "GET" and answer.status_code == 200
                    and "immutable" in answer.headers.get("cache-control", ""))
            await send({"type": "http.response.start", "status": answer.status_code, "headers": [
                (k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in back]})
            kept = bytearray() if keep else None
            async for chunk in answer.aiter_raw():
                if kept is not None:
                    kept += chunk
                await send({"type": "http.response.body", "body": chunk, "more_body": True})
            await send({"type": "http.response.body", "body": b""})
            if kept is not None:
                # A book's files never change under one address, so the copy on disk
                # keeps an opened book readable offline (3.4, 5).
                _write(body_path, bytes(kept))
                _write(meta_path, json.dumps({"status": answer.status_code, "headers": back}).encode())
        except httpx.TransportError:
            # The account went away mid-answer: the browser sees the answer cut short.
            return
        finally:
            await answer.aclose()
