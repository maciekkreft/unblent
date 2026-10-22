"""HTTP tests for the local edition (architecture.md 3.4): a server started with
UNBLENT_LOCAL_USER treats every request without a valid cookie as that one account,
the admin, with no registration and no passkeys. Stdlib only. The local server is
this test's own, on a throwaway data directory and without RP_ID; the web edition is
the check's server at UNBLENT_URL, started without the variable."""

import http.client
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent.parent
LOCAL = "0123456789abcdef0123456789abcdef"


def _call(port: int, method: str, path: str, body: dict | None = None, cookie: str | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        headers = {"Content-Type": "application/json", "Origin": f"http://localhost:{port}"}
        if cookie:
            headers["Cookie"] = cookie
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        res = conn.getresponse()
        raw = res.read()
        return res.status, (json.loads(raw) if raw and res.headers.get("Content-Type", "").startswith("application/json") else None)
    finally:
        conn.close()


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LocalEdition(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.mkdtemp(prefix="unblent-test-local-")
        cls.port = _free_port()
        env = {k: v for k, v in os.environ.items() if k not in ("RP_ID", "MAX_USERS", "UNBLENT_URL")}
        env.update(UNBLENT_DATA=cls.data, UNBLENT_LOCAL_USER=LOCAL)
        env.setdefault("SESSION_SECRET", "local-test-secret")
        cls.server = subprocess.Popen(
            [str(ROOT / ".venv" / "bin" / "uvicorn"), "server.main:app", "--host", "127.0.0.1",
             "--port", str(cls.port), "--log-level", "warning"],
            cwd=ROOT, env=env,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                _call(cls.port, "GET", "/static/bus/bus.js")
                return
            except OSError:
                time.sleep(0.1)
        cls.tearDownClass()
        raise RuntimeError("local server did not answer")

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.server.kill()
        shutil.rmtree(cls.data, ignore_errors=True)

    def test_no_cookie_is_the_local_admin(self):
        status, me = _call(self.port, "GET", "/api/session/me")
        self.assertEqual(status, 200)
        self.assertEqual(me["userId"], LOCAL)
        self.assertTrue(me["admin"])
        self.assertFalse(me["guest"])
        self.assertFalse(me["registrationOpen"])
        # Seeded once: a second visit finds the row and adds none.
        _call(self.port, "GET", "/api/session/me")
        status, people = _call(self.port, "GET", "/api/session/people")
        self.assertEqual(status, 200)
        self.assertEqual([p["userId"] for p in people["people"]], [LOCAL])

    def test_a_note_saves_without_signing_in(self):
        status, _ = _call(self.port, "PUT", "/api/notes/01JLOCALTEST0000000000000A", {"title": "Hello", "body": "x"})
        self.assertEqual(status, 200)
        status, listed = _call(self.port, "GET", "/api/notes")
        self.assertEqual(status, 200)
        self.assertIn("Hello", [n["title"] for n in listed["notes"]])
        self.assertTrue((Path(self.data) / LOCAL / "notes.db").is_file())

    def test_passkeys_and_guests_do_not_exist(self):
        for path in ("/register/begin", "/register/finish", "/login/begin", "/login/finish"):
            self.assertEqual(_call(self.port, "POST", f"/api/session{path}", {})[0], 404, path)
        # A try page's guest ask gets the one account back, never a new guest.
        status, picture = _call(self.port, "POST", "/api/session/guest")
        self.assertEqual(status, 200)
        self.assertEqual(picture["userId"], LOCAL)
        self.assertFalse(picture["guest"])


class WebEdition(unittest.TestCase):
    """Without the variable nothing changes: the check's own server."""

    def setUp(self):
        self.port = urlparse(os.environ["UNBLENT_URL"]).port

    def test_no_cookie_is_anonymous(self):
        status, me = _call(self.port, "GET", "/api/session/me")
        self.assertEqual(status, 200)
        self.assertIsNone(me["userId"])
        self.assertEqual(_call(self.port, "GET", "/api/notes")[0], 401)
        self.assertNotEqual(_call(self.port, "POST", "/api/session/login/begin", {})[0], 404)


if __name__ == "__main__":
    unittest.main()
