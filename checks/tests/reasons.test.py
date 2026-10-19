#!/usr/bin/env python3
"""Unit tests for the reason check (architecture.md 9, 11.2): pure stdlib over source
text, no node run. Run standalone (`python3 checks/tests/reasons.test.py`) or through
the full check."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

BROWSER = "const browser = await engine.launch();\n"
F = "components/a/tests/page.test.mjs"


class Reasons(unittest.TestCase):
    def test_a_test_without_a_comment_fails_with_its_line_and_name(self):
        files = {F: BROWSER + "\ntest(`renders in ${engine.name}`, async () => {});\n"}
        self.assertEqual(check.reason_problems(files), [(F, 3, "renders in ${engine.name}")])

    def test_each_reason_is_accepted_in_any_case(self):
        for reason in check.REASONS:
            files = {F: BROWSER + f"// Browser: {reason.upper()}.\n  test('x', async () => {{}});\n"}
            self.assertEqual(check.reason_problems(files), [], reason)

    def test_the_reason_may_be_any_line_of_the_comment_directly_above(self):
        files = {F: BROWSER + "// Browser: focus and keys.\n// Starts on the second row.\ntest('x', () => {});\n"}
        self.assertEqual(check.reason_problems(files), [])

    def test_a_blank_line_cuts_the_comment_off(self):
        files = {F: BROWSER + "// Browser: a gesture.\n\ntest('x', () => {});\n"}
        self.assertEqual(len(check.reason_problems(files)), 1)

    def test_a_comment_naming_no_reason_fails(self):
        files = {F: BROWSER + "// Starts on the second row.\ntest('x', () => {});\n"}
        self.assertEqual(len(check.reason_problems(files)), 1)

    def test_journey_steps_need_no_reason(self):
        files = {F: BROWSER + "// Browser: focus and keys.\ntest('j', async (t) => {\n"
                 "  await t.test('step', async () => {});\n});\n"}
        self.assertEqual(check.reason_problems(files), [])

    def test_a_node_test_needs_no_reason(self):
        files = {F: "test('machine', () => {});\n"}
        self.assertEqual(check.reason_problems(files), [])


if __name__ == "__main__":
    unittest.main()
