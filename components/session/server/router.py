"""The passkey ceremonies and the session cookie they issue (architecture.md 3.4).
The client never names a user or a database: the id is generated at registration
or read from the verified login, then carried in the signed cookie `server.user`
mints, so the per-user isolation of section 5 holds by construction. The RP id is
configured (RP_ID), never derived from the request Origin.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

import webauthn
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, options_to_json_dict
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from server.user import (
    SESSION_COOKIE,
    clear_remote,
    clear_session_cookie,
    connection,
    cross_site,
    device_of,
    local_user,
    remote,
    remote_url,
    remove_files,
    save_remote,
    session_of,
    session_token,
    set_session_cookie,
    sign,
    space,
    verify,
)

from . import registry, visitor

router = APIRouter()

RP_NAME = "Unblent"
CHALLENGE_COOKIE = "unblent_challenge"


def _max_users() -> int:
    return int(os.environ.get("MAX_USERS", "1"))


def _registration_open() -> bool:
    # Section 5: a passkey may be registered only while the registry has room, so a
    # single-user install (MAX_USERS=1) admits its owner and nobody else. The local
    # edition has no registration at all (3.4).
    return not local_user() and registry.user_count() < _max_users()


def _passkeys() -> None:
    """The local edition has no passkeys (3.4): its ceremonies do not exist there, so
    RP_ID is never read."""
    if local_user():
        raise HTTPException(status_code=404, detail="Not Found")


def _rp(request: Request) -> tuple[str, str]:
    """(rp_id, expected_origin): the configured RP_ID, and the request Origin only
    when its host is RP_ID or, over https, a subdomain of it. The RP id is never
    taken from the Origin (3.4)."""
    origin = request.headers.get("origin")
    parsed = urlparse(origin) if origin else None
    host = parsed.hostname if parsed else None
    # Configured, never defaulted: an unset RP_ID must fail loudly rather than pin
    # the ceremony to a wrong domain, the same rule as SESSION_SECRET (server.user).
    rp_id = os.environ.get("RP_ID")
    if not rp_id:
        raise RuntimeError("RP_ID is not set")
    # A port is not part of the hostname, so localhost matches on any port.
    # WebAuthn lets a page on a subdomain use its parent's RP id, so the app at
    # app.unblent.com keeps the passkeys registered at unblent.com. The leading dot
    # refuses a look-alike such as evilunblent.com.
    subdomain = parsed is not None and parsed.scheme == "https" and bool(host) and host.endswith("." + rp_id)
    if not host or (host != rp_id and not subdomain):
        raise HTTPException(status_code=400, detail="Origin does not match the configured RP")
    return rp_id, origin


def _set_challenge_cookie(response: Response, request: Request, ticket: str) -> None:
    response.set_cookie(
        CHALLENGE_COOKIE,
        sign(ticket),
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        max_age=300,
        path="/",
    )


def _picture(user_id: str | None, viewer: str | None = None) -> dict:
    """The session as session: read answers it (3.4): who, and whether a guest or
    the admin, and the name people see. A cookie the registry does not hold (a
    forged one in a test) is an ordinary account with no name. While the admin views
    as someone (12) the account is never the admin, and viewingAs carries its name."""
    picture = {"userId": user_id, "registrationOpen": _registration_open()}
    found = registry.account(user_id) if user_id else None
    if found:
        picture.update(guest=found["guest"], admin=found["admin"] and not viewer, name=found["name"])
    if user_id and viewer:
        picture["admin"] = False
        picture["viewingAs"] = (found or {}).get("name") or "someone"
    return picture


def _json(
    payload: dict,
    request: Request,
    *,
    user_id: str | None = None,
    viewer: str | None = None,
    device: str | None = None,
) -> Response:
    response = Response(content=json.dumps(payload), media_type="application/json")
    if user_id is not None:
        set_session_cookie(
            response,
            request,
            user_id,
            guest=payload.get("guest", False),
            admin=payload.get("admin", False),
            viewer=viewer,
            device=device,
        )
        response.delete_cookie(CHALLENGE_COOKIE, path="/")
    return response


@router.get("/me")
def me(request: Request):
    held = session_of(request)
    # A deleted guest's browser (12) is signed out: the account is gone, and a try page
    # makes a new guest at its next Run. A cookie that is signed but names no one is a
    # deleted account's (3.4). A device sign-in refused because Can sync is off is kept:
    # the Mac holding it syncs again once the admin turns Can sync back on.
    if not held and verify(request.cookies.get(SESSION_COOKIE)) and not device_of(request):
        response = _json(_picture(None), request)
        clear_session_cookie(response)
        return response
    if not held:
        return _json(_picture(None), request)
    if registry.is_deleted(held["userId"]):
        response = _json(_picture(None), request)
        clear_session_cookie(response)
        return response
    # The local account is in the registry from its first visit (3.4), so it is the
    # admin by the same rule as on the web. Its id is hex, the handle a passkey would carry.
    local = local_user()
    if held["userId"] == local and not registry.account(local):
        registry.create_user(id=local, handle=bytes.fromhex(local), label=RP_NAME, details=visitor.from_request(request))
    # The admin looking at someone's account is not that person's visit (12).
    if not held["viewer"]:
        registry.seen(held["userId"], visitor.from_request(request))
    picture = _picture(held["userId"], held["viewer"])
    if local:
        picture.update(connection())
    # A cookie from before guests and the admin, or one whose account became the
    # admin, is set again so server modules read the flags from it (3.4).
    stale = (held["guest"], held["admin"]) != (picture.get("guest", False), picture.get("admin", False))
    return _json(picture, request, user_id=held["userId"] if stale else None, viewer=held["viewer"], device=held["device"])


@router.post("/guest")
def guest(request: Request):
    # Asked by session: guest on a try page (3.4, 8). A browser that already holds an
    # account keeps it, so a second ask never makes a second guest.
    held = session_of(request)
    if held:
        return _json(_picture(held["userId"], held["viewer"]), request)
    user_id = secrets.token_hex(16)
    registry.create_guest(id=user_id, details=visitor.from_request(request))
    return _json(_picture(user_id), request, user_id=user_id)


@router.get("/people")
def people(request: Request):
    # Only the admin sees across accounts (12); the registry decides, not the cookie.
    held = session_of(request)
    found = registry.account(held["userId"]) if held else None
    if not found or not found["admin"]:
        raise HTTPException(status_code=403, detail="not-admin")
    return {"people": [{**person, "space": space(person["userId"])} for person in registry.people()]}


@router.delete("/people/{target}")
def delete_person(target: str, request: Request):
    # Delete on a guest (12), sent once notice-stack's Undo window ended: only the
    # admin, whom the cookie names as View as does (3.4), and only a live guest. The
    # registry keeps the row marked deleted; the guest's files go; llm forgets what it
    # spent on its own.
    held = session_of(request)
    if not held or not held["admin"]:
        raise HTTPException(status_code=403, detail="not-admin")
    if not registry.delete_guest(target):
        raise HTTPException(status_code=404, detail="no-such-guest")
    remove_files(target)
    return {"people": [{**person, "space": space(person["userId"])} for person in registry.people()]}


@router.put("/people/{target}/sync")
async def allow_sync(target: str, request: Request):
    # Can sync (3.4, 12): only the admin, and only on a passkey account, the admin's own
    # included. Answers with the new list, so People shows what the registry holds.
    held = session_of(request)
    if not held or not held["admin"]:
        raise HTTPException(status_code=403, detail="not-admin")
    try:
        body = await request.json()
    except ValueError:
        body = None
    allowed = body.get("allowed") if isinstance(body, dict) else None
    if not isinstance(allowed, bool):
        raise HTTPException(status_code=400, detail="allowed must be true or false")
    if not registry.set_sync(target, allowed):
        raise HTTPException(status_code=404, detail="no-such-account")
    return {"people": [{**person, "space": space(person["userId"])} for person in registry.people()]}


# Connecting a Mac (3.4): the native-app sign-in of RFC 8252 with PKCE (RFC 7636). The
# Mac keeps a secret verifier and sends only its SHA-256, the challenge; the signed-in
# browser asks for a one-time code bound to that challenge; the Mac trades the code
# and the verifier for a device sign-in. A code lives two minutes and is good for one try.
CODE_LIFE_MS = 2 * 60 * 1000
# A base64url string as RFC 7636 allows for a verifier, and as an S256 challenge is.
_PKCE = re.compile(r"^[A-Za-z0-9_~.-]{43,128}$")


def _web_only() -> None:
    """Connecting is the web edition's (3.4): the local edition has no such routes."""
    if local_user():
        raise HTTPException(status_code=404, detail="Not Found")


def _connector(request: Request) -> tuple[dict | None, str | None]:
    """(account, why not): the passkey account the browser holds and may connect, or
    the reason it may not, as the reply's error."""
    held = session_of(request)
    if not held:
        return None, "signed-out"
    found = registry.account(held["userId"])
    if not found or found["guest"] or held["guest"] or held["viewer"]:
        return None, "sync-off"
    if not registry.can_sync(held["userId"]):
        return None, "sync-off"
    return {"userId": held["userId"], **found}, None


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


@router.get("/connect")
def connect_allowed(request: Request):
    # Asked by the connect page before it offers Connect (3.4).
    _web_only()
    _, why = _connector(request)
    return {"allowed": why is None}


@router.post("/connect/code")
async def connect_code(request: Request):
    _web_only()
    try:
        body = await request.json()
    except ValueError:
        body = None
    challenge = body.get("challenge") if isinstance(body, dict) else None
    if not isinstance(challenge, str) or not _PKCE.match(challenge):
        raise HTTPException(status_code=400, detail="challenge must be a PKCE challenge")
    found, why = _connector(request)
    if why == "signed-out":
        return JSONResponse({"error": why}, status_code=401)
    if why:
        return JSONResponse({"error": why}, status_code=403)
    code = secrets.token_urlsafe(32)
    registry.add_code(
        code_hash=_hash(code),
        user_id=found["userId"],
        challenge=challenge,
        expires_at=int(time.time() * 1000) + CODE_LIFE_MS,
    )
    return {"code": code}


@router.post("/connect/token")
async def connect_token(request: Request):
    # Asked by the Mac's server, not a browser: no cookie, only the code and the verifier.
    _web_only()
    try:
        body = await request.json()
    except ValueError:
        body = None
    code = body.get("code") if isinstance(body, dict) else None
    verifier = body.get("verifier") if isinstance(body, dict) else None
    if not isinstance(code, str) or not isinstance(verifier, str) or not _PKCE.match(verifier):
        return JSONResponse({"error": "invalid-code"}, status_code=400)
    taken = registry.take_code(_hash(code))
    if not taken:
        return JSONResponse({"error": "invalid-code"}, status_code=400)
    # S256 (RFC 7636 4.6): the challenge is the unpadded base64url of the verifier's SHA-256.
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, taken["challenge"]):
        return JSONResponse({"error": "invalid-code"}, status_code=400)
    user_id = taken["user_id"]
    found = registry.account(user_id)
    if not found or found["guest"]:
        return JSONResponse({"error": "invalid-code"}, status_code=400)
    if not registry.can_sync(user_id):
        return JSONResponse({"error": "sync-off"}, status_code=403)
    device = secrets.token_hex(8)
    registry.add_device(id=device, user_id=user_id)
    token = session_token(user_id, admin=found["admin"], device=device)
    return {"token": token, "userId": user_id, "name": found["name"]}


# Connecting, on the Mac (3.4): the local edition's half of the same sign-in. begin
# keeps the verifier and opens the web connect page in Safari; Safari comes back to
# finish with the code, which is traded for a device sign-in kept as ready; commit
# turns it on once the hand-over (12) has emptied the outboxes; disconnect forgets it.
_DONE = ("Done. Go back to Unblent.",
         "You can close this tab. The app on your Mac will ask one last question before it switches.")
_CANCELLED = ("Not connected. Go back to Unblent.", "You can close this tab. Nothing changed on your Mac.")
_STALE = ("This link has expired.", "Go back to Unblent and press Connect account again.")
_SYNC_OFF = ("Sync is not turned on for this account.",
             "Go back to Unblent. The account's owner can turn it on in Administration.")
_OFFLINE = ("Unblent could not reach your account.",
            "Check the internet connection, then reload this tab or press Connect account again.")


def _local_only() -> None:
    """The Mac's half exists only in the local edition (3.4)."""
    if not local_user():
        raise HTTPException(status_code=404, detail="Not Found")


def _same_origin(request: Request) -> None:
    """A page on another site must not connect or disconnect this Mac (3.4)."""
    if cross_site(request.headers, request.scope.get("server", (None, None))[1]):
        raise HTTPException(status_code=403, detail="cross-site")


def _answer(words: tuple[str, str], status: int = 200) -> HTMLResponse:
    # What Safari shows after the web connect page sends it back here: a server answer,
    # not a page of the app, so it carries its own few styles and nothing else.
    title, line = words
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unblent</title>
<style>
:root{{color-scheme:light dark;--ground:#fffefb;--ink:#201515;--muted:#605d52}}
@media (prefers-color-scheme: dark){{:root{{--ground:#1c1a17;--ink:#f3efe9;--muted:#b5b0a5}}}}
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
box-sizing:border-box;background:var(--ground);color:var(--ink);font-family:Inter,system-ui,sans-serif;text-align:center}}
main{{max-width:420px;display:flex;flex-direction:column;gap:16px;align-items:center}}
h1{{margin:0;font-size:24px;font-weight:600;line-height:1.2}}
p{{margin:0;font-size:16px;line-height:1.5;color:var(--muted)}}
</style></head>
<body><main><h1>{title}</h1><p>{line}</p></main></body></html>
"""
    # The address held a one-time code: no copy kept, and no address sent onwards.
    return HTMLResponse(body, status_code=status, headers={
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    })


def _trade(url: str, code: str, verifier: str) -> tuple[int, dict]:
    """(status, body) of the web edition's connect/token, or (0, {}) when it cannot be
    reached. The standard library's client, as llm's Jev adapter uses (10)."""
    request = urllib.request.Request(
        f"{url}/api/session/connect/token",
        data=json.dumps({"code": code, "verifier": verifier}).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
    except (urllib.error.URLError, OSError, ValueError):
        return 0, {}
    try:
        body = json.loads(raw)
    except ValueError:
        body = {}
    return status, body if isinstance(body, dict) else {}


@router.post("/connect/begin")
def connect_begin(request: Request):
    _local_only()
    _same_origin(request)
    held = remote()
    if held and held["state"] == "on":
        return JSONResponse({"error": "connected"}, status_code=409)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    url = remote_url()
    save_remote({"state": "pending", "url": url, "verifier": verifier, "pendingState": state})
    port = request.scope.get("server", (None, None))[1]
    query = urlencode({"challenge": challenge, "state": state, "port": port})
    return {"url": f"{url}/workshop/apps/connect?{query}"}


@router.get("/connect/finish")
def connect_finish(state: str = "", code: str = "", error: str = ""):
    # A top-level visit from Safari, so no Origin to check: only the state proves the
    # visit answers this Mac's own begin.
    _local_only()
    held = remote()
    if not held or held["state"] != "pending" or not hmac.compare_digest(state.encode(), held["pendingState"].encode()):
        return _answer(_STALE, 400)
    if error or not code:
        clear_remote()
        return _answer(_CANCELLED)
    status, body = _trade(held["url"], code, held["verifier"])
    if status == 0 or status >= 500:
        # Kept pending: a reload of this tab tries the same code again.
        return _answer(_OFFLINE, 502)
    if status == 403 and body.get("error") == "sync-off":
        clear_remote()
        return _answer(_SYNC_OFF, 403)
    token, user_id, name = body.get("token"), body.get("userId"), body.get("name")
    if status != 200 or not isinstance(token, str) or not isinstance(user_id, str):
        clear_remote()
        return _answer(_STALE, 400)
    save_remote({"state": "ready", "url": held["url"], "token": token, "userId": user_id,
                 "name": name if isinstance(name, str) else ""})
    return _answer(_DONE)


@router.post("/connect/commit")
def connect_commit(request: Request):
    # Asked by the hand-over (12) once every outbox is empty: from now on the relay
    # forwards to the account.
    _local_only()
    _same_origin(request)
    held = remote()
    if not held or held["state"] not in ("ready", "on"):
        return JSONResponse({"error": "not-ready"}, status_code=409)
    save_remote({**held, "state": "on"})
    return connection()


@router.post("/connect/disconnect")
def connect_disconnect(request: Request):
    # The undo of connecting (3.4): the token is forgotten and the Mac's own copy is
    # back. Harmless when there is nothing to forget.
    _local_only()
    _same_origin(request)
    clear_remote()
    return connection()


@router.post("/viewas")
async def view_as(request: Request):
    # View as (12): only the admin, and not while already viewing as someone; the
    # cookie, set by this module from the registry, says who the admin is (3.4). The
    # browser then holds that account, and the cookie names the admin so Back to you
    # needs no passkey.
    held = session_of(request)
    # A connected Mac's sign-in never views as anyone: the new cookie would not be a
    # device sign-in, and Can sync could no longer stop it (3.4).
    if not held or not held["admin"] or held["device"]:
        raise HTTPException(status_code=403, detail="not-admin")
    try:
        body = await request.json()
    except ValueError:
        body = None
    target = body.get("user") if isinstance(body, dict) else None
    found = registry.account(target) if isinstance(target, str) and target else None
    if not found or found["admin"] or target == held["userId"]:
        raise HTTPException(status_code=404, detail="no-such-person")
    return _json(_picture(target, held["userId"]), request, user_id=target, viewer=held["userId"])


@router.post("/back")
def back(request: Request):
    # Back to you (12): the browser goes back to the admin the cookie names.
    held = session_of(request)
    if not held or not held["viewer"]:
        raise HTTPException(status_code=403, detail="not-viewing")
    picture = _picture(held["viewer"])
    picture["admin"] = True
    return _json(picture, request, user_id=held["viewer"])


@router.post("/register/begin")
def register_begin(request: Request):
    _passkeys()
    # Validate the request Origin before the capacity gate, uniformly with
    # login/begin, so a bad Origin is always a 400 (3.4), open registry or not.
    rp_id, _ = _rp(request)
    if not _registration_open():
        raise HTTPException(status_code=403, detail="registration-closed")
    user_id = secrets.token_hex(16)
    options = webauthn.generate_registration_options(
        rp_id=rp_id,
        rp_name=RP_NAME,
        user_id=bytes.fromhex(user_id),
        user_name=RP_NAME,
        user_display_name=RP_NAME,
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.PREFERRED,
        ),
    )
    challenge = bytes_to_base64url(options.challenge)
    response = Response(content=json.dumps(options_to_json_dict(options)), media_type="application/json")
    _set_challenge_cookie(response, request, f"reg:{user_id}:{RP_NAME}:{challenge}")
    return response


@router.post("/register/finish")
async def register_finish(request: Request):
    _passkeys()
    ticket = verify(request.cookies.get(CHALLENGE_COOKIE))
    if not ticket or not ticket.startswith("reg:"):
        raise HTTPException(status_code=400, detail="No registration in progress")
    _, user_id, label, challenge_b64 = ticket.split(":", 3)
    if not _registration_open():
        raise HTTPException(status_code=403, detail="registration-closed")
    rp_id, origin = _rp(request)
    credential = await request.json()
    verification = webauthn.verify_registration_response(
        credential=credential,
        expected_challenge=base64url_to_bytes(challenge_b64),
        expected_rp_id=rp_id,
        expected_origin=origin,
    )
    registry.create_user(id=user_id, handle=bytes.fromhex(user_id), label=label, details=visitor.from_request(request))
    registry.add_credential(
        id=bytes_to_base64url(verification.credential_id),
        user_id=user_id,
        public_key=verification.credential_public_key,
        sign_count=verification.sign_count,
        transports=json.dumps(credential.get("response", {}).get("transports")),
    )
    return _json(_picture(user_id), request, user_id=user_id)


@router.post("/login/begin")
def login_begin(request: Request):
    _passkeys()
    rp_id, _ = _rp(request)
    # No allow-list (3.4): the browser offers the discoverable passkeys itself.
    options = webauthn.generate_authentication_options(rp_id=rp_id)
    response = Response(content=json.dumps(options_to_json_dict(options)), media_type="application/json")
    _set_challenge_cookie(response, request, f"auth:{bytes_to_base64url(options.challenge)}")
    return response


@router.post("/login/finish")
async def login_finish(request: Request):
    _passkeys()
    ticket = verify(request.cookies.get(CHALLENGE_COOKIE))
    if not ticket or not ticket.startswith("auth:"):
        raise HTTPException(status_code=400, detail="No login in progress")
    challenge_b64 = ticket.split(":", 1)[1]
    rp_id, origin = _rp(request)
    credential = await request.json()
    record = registry.get_credential(credential["id"])
    if not record:
        raise HTTPException(status_code=401, detail="unknown-credential")
    verification = webauthn.verify_authentication_response(
        credential=credential,
        expected_challenge=base64url_to_bytes(challenge_b64),
        expected_rp_id=rp_id,
        expected_origin=origin,
        credential_public_key=record["public_key"],
        credential_current_sign_count=record["sign_count"],
    )
    registry.update_sign_count(credential_id=record["id"], sign_count=verification.new_sign_count)
    registry.seen(record["user_id"], visitor.from_request(request))
    return _json(_picture(record["user_id"]), request, user_id=record["user_id"])


@router.post("/logout")
def logout():
    # 200 even when no session, so a sign-out is idempotent (5: retries are harmless).
    response = Response(content=json.dumps({"userId": None}), media_type="application/json")
    clear_session_cookie(response)
    return response
