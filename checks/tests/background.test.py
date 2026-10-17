#!/usr/bin/env python3
"""Unit tests for the fast phase's parallel start (architecture.md 11): the rules that
wait on another program run in a thread while the other rules run, and a failure in
one still fails the check. Pure stdlib, no node run. Run standalone
(`python3 checks/tests/background.test.py`) or through the full check, which globs
checks/tests/*.test.py."""

import importlib.util
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


class Background(unittest.TestCase):
    def test_starts_at_once_and_runs_beside_the_caller(self):
        started = threading.Event()
        release = threading.Event()

        def slow():
            started.set()
            release.wait(2)
            return "manifests"

        job = check._Background(slow)
        # The constructor returns while the job is still waiting, so the caller's
        # rules run meanwhile.
        self.assertTrue(started.wait(1))
        self.assertFalse(release.is_set())
        release.set()
        self.assertEqual(job.result(), "manifests")

    def test_two_waits_overlap(self):
        began = time.perf_counter()
        jobs = [check._Background(time.sleep, 0.3) for _ in range(2)]
        for job in jobs:
            job.result()
        self.assertLess(time.perf_counter() - began, 0.5)

    def test_a_failure_inside_fails_where_the_result_is_taken(self):
        def failing():
            raise SystemExit(1)

        job = check._Background(failing)
        with self.assertRaises(SystemExit):
            job.result()

    def test_main_starts_the_slow_rules_before_the_others(self):
        reader_started = threading.Event()
        vendor_ran = threading.Event()
        seen = {}

        class Stop(Exception):
            pass

        def reader():
            reader_started.set()
            # Still running while the first ordinary rule runs: the two overlap.
            seen["overlapped"] = vendor_ran.wait(2)
            raise Stop

        def vendor():
            seen["reader started first"] = reader_started.wait(1)
            vendor_ran.set()

        saved = {name: getattr(check, name) for name in ("read_manifests", "check_backup", "check_vendor")}
        argv = check.sys.argv
        try:
            check.read_manifests = reader
            check.check_backup = lambda: None
            check.check_vendor = vendor
            check.sys.argv = ["check.py", "--static"]
            # The rules that need no manifests run for real against the tree; the
            # reader's failure surfaces where main waits for the manifests.
            with self.assertRaises(Stop):
                check.main()
        finally:
            check.sys.argv = argv
            for name, value in saved.items():
                setattr(check, name, value)
        self.assertEqual(seen, {"reader started first": True, "overlapped": True})


if __name__ == "__main__":
    unittest.main()
