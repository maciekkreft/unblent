"""The entry's user infrastructure (architecture.md 3.4, 11.1): who a request is
from and where their files live. A fact component's server module reaches it for
the session cookie and its per-user directory, so no router mints a cookie or
resolves a path on its own. The client never names a user or a database: the id
is carried in a signed cookie, so the per-user isolation of section 5 holds by
construction.
"""

import hashlib
import hmac
import os
from pathlib import Path

from fastapi import HTTPException, Request, Response

# Section 5: UNBLENT_DATA relocates all persistent state (the check runs each
# suite against a throwaway directory), defaulting to data/ at the repository root.
ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get("UNBLENT_DATA") or ROOT / "data")

SESSION_COOKIE = "unblent_session"
# A passkey sign-in is meant to last: without a Max-Age the cookie is a session
# cookie the browser drops on close, so every restart signs the user out while the
# local caches persist (architecture.md 3.4). Thirty days keeps them signed in
# across restarts; losing the cookie only forces a re-login, never data.
SESSION_MAX_AGE = 60 * 60 * 24 * 30


def user_dir(user_id: str) -> Path:
    """The signed-in user's own directory (section 5), created on first use."""
    directory = DATA / user_id
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def space(user_id: str) -> int:
    """Bytes the user's own directory takes (5), for Administration's People list
    (12); 0 when nothing was saved yet. Never creates the directory."""
    directory = DATA / user_id
    if not directory.is_dir():
        return 0
    total = 0
    for path in directory.rglob("*"):
        try:
            if path.is_file() and not path.is_symlink():
                total += path.stat().st_size
        except OSError:
            # A file removed while counting (a database's journal) counts as nothing.
            continue
    return total


def _secret() -> bytes:
    # Section 3.4: losing the secret only forces a re-login; it never breaks the
    # user-to-database link. Absent, it must fail loudly rather than sign with ""
    secret = os.environ.get("SESSION_SECRET")
    if not secret:
        raise RuntimeError("SESSION_SECRET is not set")
    return secret.encode()


def sign(payload: str) -> str:
    """`payload.mac`: the payload is opaque text chosen by the caller (3.4)."""
    mac = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{mac}"


def verify(token: str | None) -> str | None:
    """The payload when the token's HMAC checks out, else None."""
    if not token or "." not in token:
        return None
    payload, _, mac = token.rpartition(".")
    expected = hmac.new(_secret(), payload.encode(), hashlib.sha256).hexdigest()
    return payload if hmac.compare_digest(mac, expected) else None


def set_session_cookie(
    response: Response,
    request: Request,
    user_id: str,
    *,
    guest: bool = False,
    admin: bool = False,
    viewer: str | None = None,
) -> None:
    # Secure only under https, so the cookie still rides http://localhost in tests;
    # SameSite=strict because no cross-site flow ever needs it (3.4).
    # The cookie also says whether the account is a guest or the admin (3.4), so a
    # server module can tell without asking session; a bare id is an ordinary account.
    # While the admin views as someone it also names the admin (12), so Back to you
    # needs no passkey; the account it holds is then never the admin.
    flags = (["guest"] if guest else []) + (["admin"] if admin and not viewer else [])
    payload = "|".join([user_id] + flags + ([f"by:{viewer}"] if viewer else []))
    response.set_cookie(
        SESSION_COOKIE,
        sign(payload),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def session_of(request: Request) -> dict | None:
    """Who the cookie names (3.4): {"userId", "guest", "admin", "viewer"}, or None
    when anonymous. viewer is the admin's id while the admin views as someone (12),
    else None. Which flags a cookie carries is set by session's server module."""
    payload = verify(request.cookies.get(SESSION_COOKIE))
    if not payload:
        return None
    user_id, *flags = payload.split("|")
    viewer = next((f[3:] for f in flags if f.startswith("by:") and len(f) > 3), None)
    return {"userId": user_id, "guest": "guest" in flags, "admin": "admin" in flags and not viewer, "viewer": viewer}


def current_user(request: Request) -> str | None:
    """FastAPI dependency: the signed-in user's id, or None when anonymous."""
    session = session_of(request)
    return session["userId"] if session else None


def require_user(request: Request) -> str:
    """FastAPI dependency for a replicated fact's routes (section 5): 401 when no
    user is signed in, so anonymous work never reaches the server."""
    user_id = current_user(request)
    if not user_id:
        raise HTTPException(status_code=401, detail="Sign in required")
    return user_id
