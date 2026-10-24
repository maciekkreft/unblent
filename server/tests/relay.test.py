"""HTTP tests for the relay of the connected local edition (architecture.md 3.4): a
local-edition server whose remote.json holds a device sign-in that is on forwards
/api/* to the account's server with that sign-in, streams both ways, answers 503 when
the account cannot be reached, keeps immutable answers on disk, keeps a rotated sign-in
and never hands it to the browser, and refuses requests from other sites. The account's
server here is a small stdlib server inside this test, so each answer is under the
test's control; the local and web servers are this test's own, on throwaway data."""

import hashlib
import http.client
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LOCAL = "0123456789abcdef0123456789abcdef"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Remote(BaseHTTPRequestHandler):
    """The account's server: records what reached it and answers per path."""

    protocol_version = "HTTP/1.1"
    seen: list = []
    signed_in = True
    release = threading.Event()

    def log_message(self, *args):
        pass

    def _send(self, status: int, body: dict, headers: list = ()):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def _chunk(self, data: bytes):
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def _handle(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        Remote.seen.append({"method": self.command, "path": self.path, "cookie": self.headers.get("Cookie"),
                            "origin": self.headers.get("Origin"), "local": self.headers.get("X-Unblent-Local"),
                            "remote": self.headers.get("X-Unblent-Remote")})
        path = self.path.split("?")[0]
        if path == "/api/session/me":
            return self._send(200, {"userId": "a" * 32 if Remote.signed_in else None, "name": "Admin"})
        if path == "/api/rotate":
            return self._send(200, {}, [("Set-Cookie", "unblent_session=tok2; Max-Age=2592000; HttpOnly; Path=/"),
                                        ("Set-Cookie", "other=x; Path=/")])
        if path == "/api/cleared":
            return self._send(200, {}, [("Set-Cookie", 'unblent_session=""; Max-Age=0; Path=/')])
        if path == "/api/unauth":
            return self._send(401, {"detail": "Sign in required"})
        if path.startswith("/api/books/b1/"):
            raw = b"<p>chapter one</p>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.end_headers()
            return self.wfile.write(raw)
        if path == "/api/llm/stream":
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            self._chunk(b'{"text":"first"}\n')
            # The second piece waits until the browser has read the first.
            Remote.in_time = Remote.release.wait(4)
            self._chunk(b'{"text":"second"}\n')
            return self.wfile.write(b"0\r\n\r\n")
        return self._send(200, {"length": len(body), "sha": hashlib.sha256(body).hexdigest()})

    do_GET = do_PUT = do_POST = do_DELETE = _handle


def _start(env: dict, data: str) -> tuple[subprocess.Popen, int]:
    port = _free_port()
    clean = {k: v for k, v in os.environ.items()
             if k not in ("RP_ID", "MAX_USERS", "UNBLENT_URL", "UNBLENT_LOCAL_USER", "UNBLENT_REMOTE")}
    clean.update(UNBLENT_DATA=data, SESSION_SECRET="relay-test-secret", **env)
    server = subprocess.Popen(
        [str(ROOT / ".venv" / "bin" / "uvicorn"), "server.main:app", "--host", "127.0.0.1",
         "--port", str(port), "--log-level", "warning"], cwd=ROOT, env=clean)
    deadline = time.time() + 20
    while time.time() < deadline:
        try:
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
            conn.request("GET", "/static/bus/bus.js")
            conn.getresponse().read()
            conn.close()
            return server, port
        except OSError:
            time.sleep(0.1)
    server.kill()
    raise RuntimeError("server did not answer")


def _stop(server: subprocess.Popen) -> None:
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()


class Relay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.remote = ThreadingHTTPServer(("127.0.0.1", 0), Remote)
        cls.remote_url = f"http://127.0.0.1:{cls.remote.server_address[1]}"
        threading.Thread(target=cls.remote.serve_forever, daemon=True).start()
        cls.data = tempfile.mkdtemp(prefix="unblent-test-relay-")
        cls.web_data = tempfile.mkdtemp(prefix="unblent-test-relayweb-")
        cls.servers = []
        try:
            cls.local, cls.port = _start({"UNBLENT_LOCAL_USER": LOCAL, "UNBLENT_REMOTE": cls.remote_url,
                                          "UNBLENT_FIRST_BOOK": str(ROOT / "mac" / "books" / "meditations.epub")},
                                         cls.data)
            cls.servers.append(cls.local)
            cls.web, cls.web_port = _start({"UNBLENT_REMOTE": cls.remote_url}, cls.web_data)
            cls.servers.append(cls.web)
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers:
            _stop(server)
        cls.remote.shutdown()
        cls.remote.server_close()
        shutil.rmtree(cls.data, ignore_errors=True)
        shutil.rmtree(cls.web_data, ignore_errors=True)

    def setUp(self):
        Remote.seen.clear()
        Remote.signed_in = True
        Remote.release.clear()
        self.connect("on")

    def connect(self, state: str | None, url: str | None = None, data: str | None = None):
        path = Path(data or self.data) / "remote.json"
        if state is None:
            path.unlink(missing_ok=True)
            return
        path.write_text(json.dumps({"state": state, "url": url or self.remote_url, "token": "tok1",
                                    "userId": "a" * 32, "name": "Admin"}))
        os.chmod(path, 0o600)

    def held(self) -> dict:
        return json.loads((Path(self.data) / "remote.json").read_text())

    def call(self, method: str, path: str, headers: dict | None = None, body: bytes | None = None, port=None):
        conn = http.client.HTTPConnection("127.0.0.1", port or self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            res = conn.getresponse()
            raw = res.read()
            kind = res.headers.get("Content-Type", "")
            return res.status, res.headers, (json.loads(raw) if kind.startswith("application/json") and raw else raw)
        finally:
            conn.close()

    def test_forwards_with_the_device_sign_in_in_place_of_the_browsers_cookie(self):
        status, _, body = self.call("POST", "/api/notes/x?since=0", {
            "Cookie": "unblent_session=the-browsers", "Origin": f"http://127.0.0.1:{self.port}",
            "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json"}, b'{"a":1}')
        self.assertEqual(status, 200)
        self.assertEqual(body["length"], 7)
        [seen] = Remote.seen
        self.assertEqual((seen["method"], seen["path"]), ("POST", "/api/notes/x?since=0"))
        self.assertEqual(seen["cookie"], "unblent_session=tok1")
        self.assertEqual(seen["origin"], self.remote_url)

    def test_a_large_upload_arrives_whole(self):
        upload = os.urandom(3 * 1024 * 1024)
        status, _, body = self.call("PUT", "/api/books/new", {"Content-Type": "application/epub+zip"}, upload)
        self.assertEqual(status, 200)
        self.assertEqual(body, {"length": len(upload), "sha": hashlib.sha256(upload).hexdigest()})

    def test_an_answer_streams_piece_by_piece(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request("POST", "/api/llm/stream", body=b"{}", headers={"Content-Type": "application/json"})
            res = conn.getresponse()
            self.assertEqual(res.status, 200)
            self.assertEqual(res.readline(), b'{"text":"first"}\n', "the first piece arrives before the second is sent")
            Remote.release.set()
            self.assertEqual(res.read(), b'{"text":"second"}\n')
            self.assertTrue(Remote.in_time, "the account was not left waiting for the relay")
        finally:
            Remote.release.set()
            conn.close()

    def test_an_unreachable_account_is_503_offline_at_once(self):
        self.connect("on", url=f"http://127.0.0.1:{_free_port()}")
        started = time.monotonic()
        status, _, body = self.call("GET", "/api/notes?since=0")
        self.assertEqual((status, body), (503, {"error": "offline"}))
        status, _, _ = self.call("GET", "/api/session/me")
        self.assertEqual(status, 503, "/me says offline too, so the Mac keeps its picture")
        self.assertLess(time.monotonic() - started, 3)

    def test_an_immutable_answer_is_kept_and_served_from_disk_without_the_account(self):
        path = "/api/books/b1/3/chapter-1.html"
        status, headers, body = self.call("GET", path)
        self.assertEqual((status, body), (200, b"<p>chapter one</p>"))
        self.connect("on", url=f"http://127.0.0.1:{_free_port()}")
        status, headers, body = self.call("GET", path)
        self.assertEqual((status, body), (200, b"<p>chapter one</p>"))
        self.assertEqual(headers["Content-Type"], "text/html")
        self.assertIn("immutable", headers["Cache-Control"])
        self.assertEqual(len(Remote.seen), 1, "the second read never asked the account")
        self.assertEqual(self.call("GET", "/api/books/b1/3/chapter-2.html")[0], 503, "an unread chapter is not on disk")

    def test_a_rotated_sign_in_is_kept_and_never_reaches_the_browser(self):
        status, headers, _ = self.call("GET", "/api/rotate")
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Set-Cookie"))
        self.assertEqual(self.held()["token"], "tok2")
        self.assertEqual(self.held()["state"], "on")
        self.call("GET", "/api/notes")
        self.assertEqual(Remote.seen[-1]["cookie"], "unblent_session=tok2")
        self.call("GET", "/api/cleared")
        self.assertEqual(self.held()["token"], "tok2", "a cleared cookie is no new sign-in")

    def test_a_401_passes_through(self):
        status, _, body = self.call("GET", "/api/unauth")
        self.assertEqual((status, body), (401, {"detail": "Sign in required"}))

    def test_me_carries_the_connection_also_when_the_account_says_signed_out(self):
        status, _, me = self.call("GET", "/api/session/me")
        self.assertEqual(status, 200)
        self.assertEqual((me["userId"], me["connect"], me["remote"]), ("a" * 32, "on", "Admin"))
        Remote.signed_in = False
        status, _, me = self.call("GET", "/api/session/me")
        self.assertEqual((me["userId"], me["connect"], me["remote"]), (None, "on", "Admin"))

    def test_connecting_and_disconnecting_stay_on_the_mac(self):
        # Disconnect asks the account only whether it still lets this Mac sync.
        status, _, body = self.call("POST", "/api/session/connect/disconnect", {"Sec-Fetch-Site": "same-origin"})
        self.assertEqual((status, body), (200, {"connect": "off"}))
        self.assertEqual([(s["method"], s["path"], s["cookie"]) for s in Remote.seen],
                         [("GET", "/api/session/me", "unblent_session=tok1")])
        self.assertEqual((self.held()["state"], self.held()["token"]), ("left", "tok1"))

    def test_a_request_marked_for_the_account_is_forwarded_while_on_or_left(self):
        for state in ("on", "left"):
            Remote.seen.clear()
            self.connect(state)
            status, _, body = self.call("GET", "/api/books/b2/source", {"X-Unblent-Remote": "1"})
            self.assertEqual((status, body["length"]), (200, 0), state)
            [seen] = Remote.seen
            self.assertEqual((seen["path"], seen["cookie"], seen["remote"]),
                             ("/api/books/b2/source", "unblent_session=tok1", None), state)
        # Left, an ordinary request is the Mac's own, and /me says off.
        status, _, me = self.call("GET", "/api/session/me")
        self.assertEqual((status, me["userId"], me["connect"]), (200, LOCAL, "off"))
        self.assertEqual(len(Remote.seen), 1)

    def test_a_request_marked_for_the_account_without_a_sign_in_is_404(self):
        for state in (None, "pending", "ready"):
            self.connect(state)
            status, _, body = self.call("GET", "/api/books/b2/source", {"X-Unblent-Remote": "1"})
            self.assertEqual((status, body), (404, {"detail": "Not Found"}), state)
        self.connect("left")
        status, _, body = self.call("GET", "/api/books/b2/source",
                                    {"X-Unblent-Remote": "1", "Sec-Fetch-Site": "cross-site"})
        self.assertEqual((status, body), (403, {"detail": "cross-site"}), "the site guard comes first")
        self.assertEqual(Remote.seen, [])

    def test_a_mac_not_connected_forwards_nothing(self):
        for state in (None, "pending", "ready"):
            self.connect(state)
            status, _, me = self.call("GET", "/api/session/me")
            self.assertEqual((status, me["userId"]), (200, LOCAL), state)
        self.assertEqual(Remote.seen, [])

    def test_x_unblent_local_reaches_the_macs_own_server(self):
        status, _, me = self.call("GET", "/api/session/me", {"X-Unblent-Local": "1"})
        self.assertEqual((status, me["userId"], me["connect"]), (200, LOCAL, "on"))
        self.assertEqual(Remote.seen, [])

    def test_another_site_is_refused_connected_or_not(self):
        for state in ("on", None):
            self.connect(state)
            for headers in ({"Origin": "https://evil.example"},
                            {"Sec-Fetch-Site": "cross-site"},
                            {"Sec-Fetch-Site": "same-site", "Origin": f"http://127.0.0.1:{self.port + 1}"}):
                for method, path in (("POST", "/api/notes/x"), ("GET", "/api/session/me"),
                                     ("POST", "/api/session/connect/begin")):
                    status, _, body = self.call(method, path, headers, b"{}" if method == "POST" else None)
                    self.assertEqual((status, body), (403, {"detail": "cross-site"}), (state, headers, path))
        self.assertEqual(Remote.seen, [])

    def test_the_macs_own_page_and_safaris_way_back_pass(self):
        self.connect(None)
        own = {"Origin": f"http://127.0.0.1:{self.port}", "Sec-Fetch-Site": "same-origin"}
        self.assertEqual(self.call("GET", "/api/session/me", own)[0], 200)
        self.assertEqual(self.call("GET", "/api/session/me", {"Origin": f"http://localhost:{self.port}"})[0], 200)
        # The app's window opening its page from the bundled loading page.
        opened = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        self.assertEqual(self.call("GET", "/workshop/apps/macapp", opened)[0], 200)
        # Safari sent back from the web connect page: refused only for its stale state.
        status, _, body = self.call("GET", "/api/session/connect/finish?state=x&code=y", opened)
        self.assertEqual(status, 400)
        self.assertIn(b"expired", body)
        # A form on another site posting into the Mac's server is still a request to act.
        self.assertEqual(self.call("POST", "/api/notes/x", {**opened, "Origin": "null"}, b"{}")[0], 403)

    def test_the_web_edition_relays_nothing_and_refuses_nothing(self):
        self.connect("on", data=self.web_data)
        status, _, me = self.call("GET", "/api/session/me", {"Sec-Fetch-Site": "cross-site"}, port=self.web_port)
        self.assertEqual(status, 200)
        self.assertIsNone(me["userId"])
        self.assertNotIn("connect", me)
        self.assertEqual(self.call("GET", "/api/notes?since=0", port=self.web_port)[0], 401)
        self.assertEqual(Remote.seen, [])


if __name__ == "__main__":
    unittest.main()
