#!/usr/bin/env python3
"""Unit tests for the browser phase summary (architecture.md 11): pure stdlib over
duration rows, no node run. Run standalone (`python3 checks/tests/summary.test.py`) or
through the full check, which globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
summary = check.browser_summary
FILE = str(ROOT / "components/a/tests/page.test.mjs")


def row(name, *loads, ms=1000):
    return {"name": name, "file": FILE, "ms": ms, "failed": False,
            "loads": [{"url": f"http://127.0.0.1:1{path}", "ms": load} for path, load in loads],
            "load_ms": sum(load for _, load in loads)}


class Summary(unittest.TestCase):
    def test_the_line_splits_launches_loads_and_the_rest(self):
        rows = [row("one", ("/", 700)), row("two", ("/workshop/design/notes", 500), ("/workshop/design/notes", 300)),
                {"summary": {"launches": 2, "launch_ms": 1000}}]
        lines = summary(rows, 10.0)
        self.assertEqual(lines[0], "browser: 2 tests 10.0s — launches 2 (1.0s), page loads 3 (1.5s), the rest 7.5s")

    def test_the_slowest_loads_are_named_worst_first_with_their_test(self):
        rows = [row("quick", ("/", 100)), row("slow", ("/workshop/design/dock", 900), ("/", 400))]
        lines = summary(rows, 3.0)
        self.assertEqual(lines[1], '  slowest load 0.9s /workshop/design/dock  components/a/tests/page.test.mjs "slow"')
        self.assertIn("0.4s /  ", lines[2])
        self.assertIn('"quick"', lines[3])
        self.assertEqual(len(lines), 4)

    def test_at_most_five_loads_are_named(self):
        rows = [row(f"t{i}", ("/", 100 + i)) for i in range(8)]
        self.assertEqual(len(summary(rows, 9.0)), 6)

    def test_launches_from_every_worker_are_added(self):
        rows = [{"summary": {"launches": 1, "launch_ms": 400}}, {"summary": {"launches": 2, "launch_ms": 600}}]
        self.assertEqual(summary(rows, 2.0)[0], "browser: 0 tests 2.0s — launches 3 (1.0s), page loads 0 (0.0s), the rest 1.0s")

    def test_the_rest_never_goes_below_zero_and_old_rows_have_no_loads(self):
        rows = [{"name": "old", "file": FILE, "ms": 50, "failed": False}, {"summary": {"launches": 1, "launch_ms": 5000}}]
        self.assertEqual(summary(rows, 1.0), ["browser: 1 tests 1.0s — launches 1 (5.0s), page loads 0 (0.0s), the rest 0.0s"])

    def test_empty(self):
        self.assertEqual(summary([], 0.0), ["browser: 0 tests 0.0s — launches 0 (0.0s), page loads 0 (0.0s), the rest 0.0s"])

    def test_a_files_row_is_not_counted_as_a_test(self):
        rows = [row("one"), {"files": {FILE: 1000}}]
        self.assertTrue(summary(rows, 1.0)[0].startswith("browser: 1 tests "))

    def test_summary_rows_never_warn_or_fail(self):
        rows = [{"summary": {"launches": 1, "launch_ms": 5000}}, {"files": {FILE: 1000}}]
        self.assertEqual(check.headroom_warnings(rows), [])
        self.assertEqual(check.failed_tests(rows), [])


if __name__ == "__main__":
    unittest.main()
