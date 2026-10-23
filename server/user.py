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
import json
import shutil
import sqlite3
import tempfile
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


# One empty file per deleted guest (3.4, 12), named by its id. A leading dot keeps it
# apart from every user directory, since no user id starts with one.
REMOVED = DATA / ".deleted"


def removed(user_id: str) -> bool:
    """Whether the admin deleted this account (12), so no request may act as it again."""
    return bool(user_id) and not user_id.startswith(".") and (REMOVED / user_id).is_file()


def user_dir(user_id: str) -> Path:
    """The signed-in user's own directory (section 5), created on first use. A deleted
    account gets none back, whatever cookie its browser still holds (3.4)."""
    if removed(user_id):
        raise HTTPException(status_code=401, detail="Sign in required")
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


def remove_files(user_id: str) -> None:
    """Remove everything the user saved (5): their directory and every component's files
    in it, when the admin deletes a guest (12). An id that is not one plain name under
    DATA is refused, so no path can reach outside it."""
    directory = DATA / user_id
    if not user_id or directory.parent != DATA or directory.name != user_id or user_id.startswith("."):
        raise ValueError("not a user id")
    REMOVED.mkdir(parents=True, exist_ok=True)
    (REMOVED / user_id).touch()
    if directory.is_dir() and not directory.is_symlink():
        shutil.rmtree(directory)


def local_user() -> str | None:
    """The one account of the local edition (3.4), or None on the web. Read per call,
    so the variable alone decides which edition a request meets."""
    return os.environ.get("UNBLENT_LOCAL_USER") or None


# The connected local edition (3.4): where the account lives, and this Mac's device
# sign-in to it, kept beside local.json in the data folder.
REMOTE = DATA / "remote.json"


def remote_url() -> str:
    """The web edition a Mac connects to (3.4); UNBLENT_REMOTE points a test elsewhere."""
    return (os.environ.get("UNBLENT_REMOTE") or "https://app.unblent.com").rstrip("/")


def remote() -> dict | None:
    """What remote.json holds, or None when this Mac is not connecting (3.4). Its
    `state` is pending (Safari was opened: `verifier` and `state` wait for the code),
    ready (a device sign-in waits for the hand-over: `token`, `userId`, `name`) or on
    (the relay forwards to `url`). An unreadable file counts as none."""
    try:
        held = json.loads(REMOTE.read_text())
    except (OSError, ValueError):
        return None
    return held if isinstance(held, dict) and held.get("state") in ("pending", "ready", "on") else None


def save_remote(held: dict) -> None:
    """Write remote.json readable by the owner alone, whole or not at all: a token half
    written would sign the Mac out, so it goes to a temporary file that replaces the old."""
    DATA.mkdir(parents=True, exist_ok=True)
    # mkstemp makes the file 0600; the leading dot keeps it apart from user directories.
    fd, temporary = tempfile.mkstemp(dir=DATA, prefix=".remote-", suffix=".json")
    try:
        with os.fdopen(fd, "w") as file:
            json.dump(held, file)
        os.replace(temporary, REMOTE)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def clear_remote() -> None:
    """Forget the device sign-in: the Mac is back to its own copy (3.4)."""
    REMOTE.unlink(missing_ok=True)


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


def session_token(
    user_id: str,
    *,
    guest: bool = False,
    admin: bool = False,
    viewer: str | None = None,
    device: str | None = None,
) -> str:
    """The signed value of the session cookie (3.4). The cookie also says whether the
    account is a guest or the admin, so a server module can tell without asking
    session; a bare id is an ordinary account. While the admin views as someone it
    also names the admin (12), so Back to you needs no passkey; the account it holds is
    then never the admin. A device sign-in (3.4) carries `device:<id>`, the connected
    Mac it was issued to, so session_of can refuse it once the account's Can sync is off."""
    flags = (["guest"] if guest else []) + (["admin"] if admin and not viewer else [])
    extra = ([f"by:{viewer}"] if viewer else []) + ([f"device:{device}"] if device else [])
    return sign("|".join([user_id] + flags + extra))


def set_session_cookie(
    response: Response,
    request: Request,
    user_id: str,
    *,
    guest: bool = False,
    admin: bool = False,
    viewer: str | None = None,
    device: str | None = None,
) -> None:
    # Secure only under https, so the cookie still rides http://localhost in tests;
    # SameSite=strict because no cross-site flow ever needs it (3.4).
    response.set_cookie(
        SESSION_COOKIE,
        session_token(user_id, guest=guest, admin=admin, viewer=viewer, device=device),
        max_age=SESSION_MAX_AGE,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def _flag(flags: list[str], name: str) -> str | None:
    return next((f[len(name):] for f in flags if f.startswith(name) and len(f) > len(name)), None)


def device_of(request: Request) -> str | None:
    """The connected Mac a validly signed device sign-in names (3.4), whether or not its
    account may still sync; None for any other cookie."""
    payload = verify(request.cookies.get(SESSION_COOKIE))
    return _flag((payload or "").split("|")[1:], "device:") if payload else None


def _may_sync(user_id: str) -> bool:
    # Read only for a device sign-in (3.4), so an ordinary request costs nothing more.
    # session owns the registry; this is a read of its Can sync column and nothing
    # else, and a registry without the column or the row refuses.
    path = DATA / "session.db"
    if not path.is_file():
        return False
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = connection.execute(
                "SELECT sync FROM users WHERE id = ? AND guest = 0 AND deleted_at IS NULL", (user_id,)
            ).fetchone()
        finally:
            connection.close()
    except sqlite3.Error:
        return False
    return bool(row and row[0])


def session_of(request: Request) -> dict | None:
    """Who the cookie names (3.4): {"userId", "guest", "admin", "viewer", "device"}, or
    None when anonymous or the account was deleted. viewer is the admin's id while the
    admin views as someone (12), else None; device is the connected Mac a device sign-in
    was issued to, else None. Which flags a cookie carries is set by session's server
    module. A device sign-in whose account's Can sync is off is no one (3.4).
    In the local edition a request without a valid cookie is the local account (3.4)."""
    payload = verify(request.cookies.get(SESSION_COOKIE))
    user_id, *flags = (payload or "").split("|")
    device = _flag(flags, "device:") if payload else None
    # A deleted account's cookie is no one's (3.4): every module sees the browser signed out.
    if not payload or removed(user_id) or (device and not _may_sync(user_id)):
        # The local edition (3.4): a browser holding no valid cookie is the one
        # account, and that account is the admin, so no sign-in ever happens.
        local = local_user()
        return {"userId": local, "guest": False, "admin": True, "viewer": None, "device": None} if local else None
    viewer = _flag(flags, "by:")
    return {
        "userId": user_id,
        "guest": "guest" in flags,
        "admin": "admin" in flags and not viewer,
        "viewer": viewer,
        "device": device,
    }


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
