#!/usr/bin/env python3
"""Unit tests for the disk check (architecture.md 11.2): made-up sizes, no disk read.
Run standalone (`python3 checks/tests/disk.test.py`) or through the full check, which
globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
GB = 2**30


class DiskProblem(unittest.TestCase):
    def test_below_the_limit_says_nothing(self):
        self.assertIsNone(check.disk_problem(79 * GB, 21 * GB))

    def test_at_the_limit_says_how_full_and_what_is_free(self):
        problem = check.disk_problem(80 * GB, 20 * GB)
        self.assertIn("80% full", problem)
        self.assertIn("20.0 GB free", problem)
        self.assertIn("tell the owner", problem)

    def test_space_a_user_cannot_have_does_not_count(self):
        # 33 GB used and 3 GB free on a 38 GB disk is the 92% df printed, not 87%.
        self.assertIn("92% full", check.disk_problem(33 * GB, int(2.9 * GB)))


if __name__ == "__main__":
    unittest.main()
