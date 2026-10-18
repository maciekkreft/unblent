#!/usr/bin/env python3
"""Unit tests for the headroom warning (architecture.md 11). Pure stdlib over duration
rows, no node run: they exercise headroom_warnings directly. Run standalone
(`python3 checks/tests/headroom.test.py`) or through the full check, which globs
checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
warnings = check.headroom_warnings
HALF = check.HEADROOM_MS


class Headroom(unittest.TestCase):
    def test_only_tests_past_half_the_budget_warn(self):
        rows = [
            {"name": "quick", "file": str(ROOT / "components/a/tests/page.test.mjs"), "ms": HALF - 1},
            {"name": "slow", "file": str(ROOT / "components/b/tests/page.test.mjs"), "ms": HALF + 500},
        ]
        lines = warnings(rows)
        self.assertEqual(len(lines), 1)
        self.assertIn("slow", lines[0])
        self.assertIn("components/b/tests/page.test.mjs", lines[0])
        self.assertNotIn("quick", lines[0])

    def test_worst_first(self):
        rows = [
            {"name": "mid", "file": "x", "ms": HALF + 100},
            {"name": "worst", "file": "x", "ms": HALF + 900},
        ]
        lines = warnings(rows)
        self.assertEqual([("worst" in line) for line in lines], [True, False])

    def test_missing_duration_or_file_never_throws(self):
        self.assertEqual(warnings([{"name": "no ms", "file": "x"}]), [])
        lines = warnings([{"name": "no file", "ms": HALF + 100}])
        self.assertEqual(len(lines), 1)
        self.assertIn("?", lines[0])

    def test_empty(self):
        self.assertEqual(warnings([]), [])


class SlowFiles(unittest.TestCase):
    LIMIT = check.FILE_WARN_S * 1000

    def test_only_files_past_the_limit_warn_slowest_first(self):
        a, b, c = (str(ROOT / f"components/{n}/tests/page.test.mjs") for n in "abc")
        rows = [{"name": "t", "file": a, "ms": 10}, {"files": {a: self.LIMIT - 1, b: self.LIMIT + 1000, c: self.LIMIT + 5000}}]
        self.assertEqual(check.slow_file_warnings(rows), [
            f"warning: components/c/tests/page.test.mjs took {self.LIMIT / 1000 + 5:.1f}s, over the "
            f"{check.FILE_WARN_S}s a browser test file may take (11)",
            f"warning: components/b/tests/page.test.mjs took {self.LIMIT / 1000 + 1:.1f}s, over the "
            f"{check.FILE_WARN_S}s a browser test file may take (11)",
        ])

    def test_a_file_split_across_rows_adds_up(self):
        rows = [{"files": {"x": self.LIMIT / 2 + 1}}, {"files": {"x": self.LIMIT / 2}}]
        self.assertEqual(len(check.slow_file_warnings(rows)), 1)

    def test_rows_without_files_never_warn(self):
        self.assertEqual(check.slow_file_warnings([{"name": "t", "file": "x", "ms": self.LIMIT * 2},
                                                   {"summary": {"launches": 1}}]), [])


class Engines(unittest.TestCase):
    def test_the_two_passes_split_on_the_engine_named_in_a_test(self):
        # The WebKit pass skips what names Chromium, the push run's Chromium pass runs
        # only that, so the Chromium-only passkey test "(chromium)" runs once, in the first.
        self.assertEqual(check.SKIP_CHROMIUM, "--test-skip-pattern=in chromium")
        self.assertEqual(check.ONLY_CHROMIUM, "--test-name-pattern=in chromium")


class Failed(unittest.TestCase):
    def test_only_failed_tests_are_named_with_their_file(self):
        rows = [
            {"name": "passes", "file": str(ROOT / "components/a/tests/page.test.mjs"), "failed": False},
            {"name": "breaks", "file": str(ROOT / "components/b/tests/page.test.mjs"), "failed": True},
        ]
        self.assertEqual(check.failed_tests(rows), ['components/b/tests/page.test.mjs: "breaks"'])

    def test_detail_falls_back_when_no_test_is_named(self):
        self.assertEqual(check._failure_detail([]), "node --test reported failures")


if __name__ == "__main__":
    unittest.main()
