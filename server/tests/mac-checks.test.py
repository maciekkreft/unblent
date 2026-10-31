"""The evaluators and box settings that come with the Mac app (architecture.md 3.4):
mac/export-checks.py run over a made-up owner's data folder, and a local-edition server
of this test's own that starts from what it wrote. Stdlib only. Each component's own
tests cover giving once per Mac; this one covers the whole path, so the settings a new
Mac gets name the evaluators it got."""

import http.client
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
SCRIPT = ROOT / "mac" / "export-checks.py"
LOCAL = "0123456789abcdef0123456789abcdee"
ADMIN = "a" * 32
JOURNAL = "00000000000000000000000JRN"
YOURS = "0000000000000000000000YVAS"
GOAL, VALUE, EXAMPLE, PRIVATE, OLD = (f"01ARZ3NDEKTSV4RRFFQ69G5EV{n}" for n in range(1, 6))
OTHER_BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1"
QUESTION = "01ARZ3NDEKTSV4RRFFQ69G5QQ1"
# One of the owner's own values, as Your values' question for it is named.
OWNER_VALUE = "01ARZ3NDEKTSV4RRFFQ69G5VL1"


def _setting(question: str, when: dict | None = None) -> dict:
    return {"id": question, "show": True, "expect": "yes", "when": when, "icons": {}}


def _owner(data: Path, names=("goal type", "Value Type", "Value Example")) -> None:
    """A made-up host: a guest who came first, the admin, and a later account."""
    with closing(sqlite3.connect(data / "session.db")) as db, db:
        db.executescript((ROOT / "components/session/server/schema.sql").read_text())
        for user, created, guest in (("g" * 32, 1, 1), (ADMIN, 2, 0), ("b" * 32, 3, 0)):
            db.execute("INSERT INTO users (id, handle, label, created_at, guest) VALUES (?, x'00', '', ?, ?)", (user, created, guest))
    folder = data / ADMIN
    folder.mkdir()
    with closing(sqlite3.connect(folder / "evaluators.db")) as db, db:
        db.executescript((ROOT / "components/evaluators/server/schema.sql").read_text())
        rows = [(GOAL, JOURNAL, names[0], 0, "a1"), (VALUE, OTHER_BOOK, names[1], 0, None), (EXAMPLE, JOURNAL, names[2], 0, "a2"),
                (PRIVATE, JOURNAL, "Private", 0, None), (OLD, JOURNAL, "Value Type", 1, None)]
        for evaluator, book, name, deleted, position in rows:
            questions = [{"id": QUESTION, "kind": "yesno", "text": "Is it?", "yes": "", "no": "", "options": []}] if evaluator == GOAL else []
            db.execute(
                'INSERT INTO evaluators (id, book, name, "on", questions, version, seq, deleted, starter_for, position, description)'
                " VALUES (?, ?, ?, 1, ?, 3, 1, ?, '[\"evaluators\"]', ?, 'What it checks.')",
                (evaluator, book, name, json.dumps(questions), deleted, position),
            )
    with closing(sqlite3.connect(folder / "choice-point-checks.db")) as db, db:
        db.executescript((ROOT / "components/choice-point-checks/server/schema.sql").read_text())
        towards = ([_setting(QUESTION, {"question": OWNER_VALUE, "option": "yes"})],
                   [{"evaluator": YOURS, "questions": [_setting(OWNER_VALUE)]}, {"evaluator": PRIVATE, "questions": []}])
        db.execute("INSERT INTO boxes VALUES ('towards', ?, ?, ?, 4, 1)", (GOAL, json.dumps(towards[0]), json.dumps(towards[1])))
        db.execute("INSERT INTO boxes VALUES ('away', ?, '[]', '[]', 2, 2)", (PRIVATE,))
        db.execute("INSERT INTO answers VALUES ('k', '[{\"text\": \"my secret line\"}]', 3)")
    with closing(sqlite3.connect(folder / "value-checks.db")) as db, db:
        db.executescript((ROOT / "components/value-checks/server/schema.sql").read_text())
        db.execute("INSERT INTO settings VALUES ('settings', ?, ?, 2, 1)", (VALUE, PRIVATE))


def _export(data: Path, out: Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", str(SCRIPT), "--data", str(data), "--out", str(out)],
                          capture_output=True, text=True, timeout=20)


def _call(port: int, path: str):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        conn.request("GET", path, headers={"Origin": f"http://localhost:{port}"})
        res = conn.getresponse()
        return res.status, json.loads(res.read())
    finally:
        conn.close()


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Export(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="unblent-test-mac-checks-"))
        self.data, self.out = self.tmp / "data", self.tmp / "checks"
        self.data.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_only_the_three_evaluators_and_the_settings_that_name_them(self):
        _owner(self.data)
        done = _export(self.data, self.out)
        self.assertEqual(done.returncode, 0, done.stderr)
        evaluators = json.loads((self.out / "evaluators.json").read_text())["evaluators"]
        self.assertEqual([(e["id"], e["name"], e["book"]) for e in evaluators],
                         [(GOAL, "goal type", JOURNAL), (VALUE, "Value Type", JOURNAL), (EXAMPLE, "Value Example", JOURNAL)],
                         "in a fixed order, the deleted one left out, one kept with another book kept with the journal")
        self.assertEqual(set(evaluators[0]), {"id", "book", "name", "description", "on", "questions", "position"}, "never the starter ticks")
        boxes = json.loads((self.out / "choice-point-checks.json").read_text())["boxes"]
        self.assertEqual(boxes, [
            {"field": "away", "evaluator": None, "questions": [], "also": []},
            {"field": "towards", "evaluator": GOAL, "questions": [_setting(QUESTION)], "also": [{"evaluator": YOURS, "questions": []}]},
        ])
        self.assertEqual(json.loads((self.out / "value-checks.json").read_text()), {"settings": {"values": VALUE, "examples": None}})
        written = "".join(p.read_text() for p in self.out.iterdir())
        for private in ("Private", PRIVATE, OWNER_VALUE, "my secret line"):
            self.assertNotIn(private, written)
        self.assertIn("not exported", done.stdout)

    def test_a_missing_evaluator_is_named_and_nothing_is_written(self):
        _owner(self.data, names=("Goal Type", "Value Kind", "Value Example"))
        done = _export(self.data, self.out)
        self.assertEqual(done.returncode, 1)
        self.assertIn("'Value Type'", done.stderr)
        self.assertFalse(self.out.exists())


class NewMac(unittest.TestCase):
    """A local-edition server started on what the export wrote."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="unblent-test-new-mac-"))
        owner, cls.bundle, cls.data = cls.tmp / "owner", cls.tmp / "checks", cls.tmp / "mac"
        owner.mkdir()
        cls.data.mkdir()
        _owner(owner)
        done = _export(owner, cls.bundle)
        assert done.returncode == 0, done.stderr
        cls.port = _free_port()
        env = {k: v for k, v in os.environ.items() if k not in ("RP_ID", "MAX_USERS", "UNBLENT_URL", "UNBLENT_REMOTE")}
        env.update(UNBLENT_DATA=str(cls.data), UNBLENT_LOCAL_USER=LOCAL, UNBLENT_FIRST_CHECKS=str(cls.bundle))
        env.setdefault("SESSION_SECRET", "local-test-secret")
        cls.server = subprocess.Popen(
            [str(ROOT / ".venv" / "bin" / "uvicorn"), "server.main:app", "--host", "127.0.0.1",
             "--port", str(cls.port), "--log-level", "warning"],
            cwd=ROOT, env=env,
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                _call(cls.port, "/api/session/me")
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
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_the_settings_name_the_evaluators_the_mac_got(self):
        status, listed = _call(self.port, "/api/evaluators")
        self.assertEqual(status, 200)
        got = {e["id"] for e in listed["evaluators"]}
        self.assertEqual(got, {GOAL, VALUE, EXAMPLE})
        status, checks = _call(self.port, "/api/choice-point-checks")
        self.assertEqual(status, 200)
        named = {b["evaluator"] for b in checks["boxes"] if b["evaluator"]} | {a["evaluator"] for b in checks["boxes"] for a in b["also"]}
        self.assertEqual(named, {GOAL, YOURS}, "the bundled evaluators, and Your values, which evaluators builds on every Mac")
        self.assertEqual(checks["answers"], [])
        status, values = _call(self.port, "/api/value-checks")
        self.assertEqual(status, 200)
        self.assertEqual(values["settings"]["values"], VALUE)
        for mark in ("first-evaluators", "first-choice-point-checks", "first-value-checks"):
            self.assertTrue((self.data / mark).is_file(), mark)


if __name__ == "__main__":
    unittest.main()
