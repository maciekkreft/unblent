"""The local edition's server as one program (architecture.md 3.4): the Mac app starts
it, and so can a person with Python, to use the Mac page in a browser.

It keeps the account and the secret in the data folder, sets the variables the server
reads, and serves on 127.0.0.1 at one fixed port, because the browser keeps its
storage per origin and a different port would start the reader with an empty cache.

Run from source: ``python3 mac/serve.py``. Frozen by mac/freeze.sh, the same file is
the program ``unblent-server``.
"""

import errno
import json
import os
import secrets
import signal
import socket
import sys
import threading
import time
from pathlib import Path

# Fixed for good: the browser's storage for the Mac page is tied to it.
DEFAULT_PORT = 47321
HOST = "127.0.0.1"
PAGE = "/workshop/apps/macapp"


def bundle_root() -> Path:
    """The folder holding server/, components/, pages/ and the rest: the repository when
    run from source, PyInstaller's unpacked folder when frozen."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def data_folder() -> Path:
    if os.environ.get("UNBLENT_DATA"):
        return Path(os.environ["UNBLENT_DATA"]).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Unblent"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "Unblent"


def identity(data: Path) -> dict:
    """The local account's id and the session secret, made on the first run and kept
    readable by the owner alone. The id is hex, as a passkey's handle would be (3.4)."""
    path = data / "local.json"
    if not path.exists():
        made = {"user": secrets.token_hex(16), "secret": secrets.token_urlsafe(48)}
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w") as file:
                json.dump(made, file)
    return json.loads(path.read_text())


def listen(port: int) -> socket.socket:
    """Take the port before the server starts, so a second copy fails here with a
    message rather than inside uvicorn."""
    taken = f"Unblent cannot start: port {port} on {HOST} is already in use, probably by another copy of Unblent. Quit it and try again."
    # On macOS a listener on all addresses does not stop a bind to 127.0.0.1 alone,
    # so ask first whether anything answers there.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.5)
        if probe.connect_ex((HOST, port)) == 0:
            sys.exit(taken)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((HOST, port))
    except OSError as error:
        sock.close()
        if error.errno == errno.EADDRINUSE:
            sys.exit(taken)
        raise
    sock.listen(2048)
    return sock


def follow_parent() -> None:
    """The Mac app passes its process id, so a server whose app ended without stopping
    it (a crash, a forced quit) stops too, instead of holding the port the next start
    needs."""
    parent = os.environ.get("UNBLENT_PARENT_PID")
    if not parent:
        return

    def watch() -> None:
        while os.getppid() == int(parent):
            time.sleep(1)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=watch, daemon=True).start()


def main() -> None:
    root = bundle_root()
    data = data_folder()
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    port = int(os.environ.get("UNBLENT_PORT") or DEFAULT_PORT)
    sock = listen(port)
    follow_parent()

    held = identity(data)
    # The server reads these at import (server/user.py), so they are set before it loads.
    os.environ["UNBLENT_DATA"] = str(data)
    os.environ["UNBLENT_LOCAL_USER"] = held["user"]
    os.environ["SESSION_SECRET"] = held["secret"]
    # The account a Mac connects to (3.4); kept when set, so a test points it at its own server.
    os.environ.setdefault("UNBLENT_REMOTE", "https://app.unblent.com")
    os.environ["UNBLENT_FIRST_BOOK"] = str(root / "mac" / "books" / "meditations.epub")
    sys.path.insert(0, str(root))

    import uvicorn

    # The server is loaded by name, from its source files in the bundle, so its routers
    # find their schema files and pages next to them, as on the web.
    config = uvicorn.Config("server.main:app", host=HOST, port=port, reload=False,
                            loop="asyncio", http="h11", ws="none", lifespan="on")
    print(f"Unblent is at http://{HOST}:{port}{PAGE} (data in {data})", flush=True)
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
