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


if __name__ == "__main__":
    unittest.main()
