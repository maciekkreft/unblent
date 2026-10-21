#!/usr/bin/env python3
"""Unit tests for checks/leftovers.py: which processes count as test servers or test
browsers, and that one whose session has ended is listed while this test's own
ancestors (a running session or check) keep theirs. Run standalone
(`python3 checks/tests/leftovers.test.py`) or through the full check."""

import importlib.util
import subprocess
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("leftovers", ROOT / "checks" / "leftovers.py")
leftovers = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(leftovers)


def args(text):
    return [part.encode() for part in text.split()]


class Kind(unittest.TestCase):
    def test_a_test_server_is_one(self):
        self.assertEqual(leftovers._kind(args("python3 uvicorn server.main:app --port 41089")), "test server")

    def test_the_live_server_never_is(self):
        self.assertIsNone(leftovers._kind(args("python3 uvicorn server.main:app --port 8080 --reload")))

    def test_another_projects_server_is_not(self):
        self.assertIsNone(leftovers._kind(args("python3 uvicorn app.main:app --port 8000")))

    def test_a_playwright_browser_is_one(self):
        self.assertEqual(leftovers._kind(args("/home/u/.cache/ms-playwright/webkit-2100/pw_run.sh")), "test browser")


class Orphans(unittest.TestCase):
    def test_an_orphan_is_listed_and_stopped(self):
        # A double fork leaves the fake server with no session above it, as a check
        # killed mid-run leaves its server.
        marker = f"uvicorn server.main:app --port 1{time.time_ns() % 10000:04d}"
        subprocess.run(["bash", "-c", f'( setsid bash -c "exec -a \\"{marker}\\" sleep 30" </dev/null >/dev/null 2>&1 & )'], check=True)
        deadline = time.time() + 2
        found = []
        while time.time() < deadline and not found:
            found = [pid for pid, _, text in leftovers.leftovers() if text.startswith(marker)]
            time.sleep(0.02)
        self.assertEqual(len(found), 1)
        for pid in found:
            leftovers.os.kill(pid, leftovers.signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
