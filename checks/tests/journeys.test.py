#!/usr/bin/env python3
"""Unit tests for the journey check (architecture.md 9, 11.2) and a journey's budget in
the headroom warning: pure stdlib over source text and duration rows, no node run. Run
standalone (`python3 checks/tests/journeys.test.py`) or through the full check."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

BROWSER = "const browser = await engine.launch();\n"
A = "components/a/tests/journey-lists.test.mjs"
B = "components/b/tests/page.test.mjs"


class Journeys(unittest.TestCase):
    def test_a_browser_test_with_steps_must_be_listed(self):
        files = {A: BROWSER + 'await t.test("j moves down", async () => {});'}
        self.assertEqual(check.journey_problems(files, []), [A])
        self.assertEqual(check.journey_problems(files, [A]), [])

    def test_the_kit_journey_counts_as_steps(self):
        files = {A: BROWSER + "journey(`the lists in ${engine.name}`, {}, []);"}
        self.assertEqual(check.journey_problems(files, []), [A])

    def test_a_browser_test_without_steps_is_not_a_journey(self):
        files = {B: BROWSER + 'test("renders", async () => { assert.ok(/[jk]/.test(text)); });'}
        self.assertEqual(check.journey_problems(files, []), [])

    def test_steps_without_a_browser_are_not_a_journey(self):
        files = {B: 'test("machine", async (t) => { await t.test("one", () => {}); });'}
        self.assertEqual(check.journey_problems(files, []), [])

    def test_steps_in_a_comment_do_not_count(self):
        files = {B: BROWSER + '// a journey(...) would use t.test("step")\n'}
        self.assertEqual(check.journey_problems(files, []), [])

    def test_a_listed_file_that_is_gone_is_ignored(self):
        self.assertEqual(check.journey_problems({}, ["components/gone/tests/journey.test.mjs"]), [])


class JourneyBudget(unittest.TestCase):
    def test_a_journey_is_judged_by_its_own_budget(self):
        half = check.JOURNEY_TIMEOUT_MS / 2
        rows = [{"name": "the lists", "file": "x", "ms": 20000, "steps": 8},
                {"name": "too long", "file": "x", "ms": half + 1, "steps": 8}]
        lines = check.headroom_warnings(rows)
        self.assertEqual(len(lines), 1)
        self.assertIn("too long", lines[0])
        self.assertIn(f"its {check.JOURNEY_TIMEOUT_MS / 1000:.0f}s budget", lines[0])

    def test_a_step_is_judged_as_a_test(self):
        lines = check.headroom_warnings([{"name": "G", "file": "x", "ms": check.HEADROOM_MS + 1}])
        self.assertEqual(len(lines), 1)


if __name__ == "__main__":
    unittest.main()
