"""The passkey ceremonies and the session cookie they issue (architecture.md 3.4).
The client never names a user or a database: the id is generated at registration
or read from the verified login, then carried in the signed cookie `server.user`
mints, so the per-user isolation of section 5 holds by construction. The RP id is
configured (RP_ID), never derived from the request Origin.
"""

import json
import os
import secrets
from urllib.parse import urlparse

import webauthn
from fastapi import APIRouter, HTTPException, Request, Response
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url, options_to_json_dict
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from server.user import clear_session_cookie, session_of, set_session_cookie, sign, space, verify

from . import registry, visitor

router = APIRouter()

RP_NAME = "Unblent"
CHALLENGE_COOKIE = "unblent_challenge"


def _max_users() -> int:
    return int(os.environ.get("MAX_USERS", "1"))


def _registration_open() -> bool:
    # Section 5: a passkey may be registered only while the registry has room, so a
    # single-user install (MAX_USERS=1) admits its owner and nobody else.
    return registry.user_count() < _max_users()


def _rp(request: Request) -> tuple[str, str]:
    """(rp_id, expected_origin): the configured RP_ID, and the request Origin only
    when its host matches it. The RP id is never taken from the Origin (3.4)."""
    origin = request.headers.get("origin")
    host = urlparse(origin).hostname if origin else None
    # Configured, never defaulted: an unset RP_ID must fail loudly rather than pin
    # the ceremony to a wrong domain, the same rule as SESSION_SECRET (server.user).
    rp_id = os.environ.get("RP_ID")
    if not rp_id:
        raise RuntimeError("RP_ID is not set")
    # A port is not part of the hostname, so localhost matches on any port.
    if not host or host != rp_id:
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


def _picture(user_id: str | None) -> dict:
    """The session as session: read answers it (3.4): who, and whether a guest or
    the admin, and the name people see. A cookie the registry does not hold (a
    forged one in a test) is an ordinary account with no name."""
    picture = {"userId": user_id, "registrationOpen": _registration_open()}
    found = registry.account(user_id) if user_id else None
    if found:
        picture.update(guest=found["guest"], admin=found["admin"], name=found["name"])
    return picture


def _json(payload: dict, request: Request, *, user_id: str | None = None) -> Response:
    response = Response(content=json.dumps(payload), media_type="application/json")
    if user_id is not None:
        set_session_cookie(
            response, request, user_id, guest=payload.get("guest", False), admin=payload.get("admin", False)
        )
        response.delete_cookie(CHALLENGE_COOKIE, path="/")
    return response


@router.get("/me")
def me(request: Request):
    held = session_of(request)
    if not held:
        return _json(_picture(None), request)
    registry.seen(held["userId"], visitor.from_request(request))
    picture = _picture(held["userId"])
    # A cookie from before guests and the admin, or one whose account became the
    # admin, is set again so server modules read the flags from it (3.4).
    stale = (held["guest"], held["admin"]) != (picture.get("guest", False), picture.get("admin", False))
    return _json(picture, request, user_id=held["userId"] if stale else None)


@router.post("/guest")
def guest(request: Request):
    # Asked by session: guest on a try page (3.4, 8). A browser that already holds an
    # account keeps it, so a second ask never makes a second guest.
    held = session_of(request)
    if held:
        return _json(_picture(held["userId"]), request)
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


@router.post("/register/begin")
def register_begin(request: Request):
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
    rp_id, _ = _rp(request)
    # No allow-list (3.4): the browser offers the discoverable passkeys itself.
    options = webauthn.generate_authentication_options(rp_id=rp_id)
    response = Response(content=json.dumps(options_to_json_dict(options)), media_type="application/json")
    _set_challenge_cookie(response, request, f"auth:{bytes_to_base64url(options.challenge)}")
    return response


@router.post("/login/finish")
async def login_finish(request: Request):
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
