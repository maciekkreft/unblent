#!/usr/bin/env python3
"""Unit tests for the tool entry rule (architecture.md 7.2, 7.7, 11.2). Pure stdlib
over dict fixtures: they exercise tool_problems, the decision, directly. Run
standalone (`python3 checks/tests/tools.test.py`) or through the full check, which
globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
problems = check.tool_problems

BASE = {"description": "List the evaluators.", "label": "Listing your evaluators"}


class Ok(unittest.TestCase):
    def test_plain_entry_passes(self):
        self.assertEqual(problems(dict(BASE)), [])

    def test_pointers_pass(self):
        self.assertEqual(problems({**BASE, "name": "/note/title", "excerpt": "/note/body"}), [])

    def test_switch_false_passes(self):
        self.assertEqual(problems({**BASE, "switch": False}), [])

    def test_settings_and_listing_fields_pass(self):
        entry = {**BASE, "title": "Journal days", "group": "Journal", "order": 10,
                 "items": "/days", "itemName": "/date", "total": "/total", "opens": "day"}
        self.assertEqual(problems(entry), [])

    def test_item_excerpt_and_open_pointers_pass(self):
        entry = {**BASE, "itemExcerpt": "/summary", "openId": "/reply/id", "openChapter": "/payload/chapter"}
        self.assertEqual(problems(entry), [])


class Fails(unittest.TestCase):
    def test_missing_label(self):
        self.assertEqual(len(problems({"description": "x"})), 1)

    def test_bad_pointer(self):
        self.assertIn("'name'", problems({**BASE, "name": "note/title"})[0])

    def test_bad_listing_pointer(self):
        self.assertIn("'itemName'", problems({**BASE, "itemName": "date"})[0])

    def test_bad_open_pointers(self):
        self.assertIn("'itemExcerpt'", problems({**BASE, "itemExcerpt": "summary"})[0])
        self.assertIn("'openId'", problems({**BASE, "openId": 3})[0])
        self.assertIn("'openChapter'", problems({**BASE, "openChapter": "chapter"})[0])

    def test_order_not_number_fails(self):
        self.assertIn("'order'", problems({**BASE, "order": "10"})[0])
        self.assertEqual(len(problems({**BASE, "order": True})), 1)

    def test_empty_group_fails(self):
        self.assertIn("'group'", problems({**BASE, "group": " "})[0])

    def test_switch_true_fails(self):
        out = problems({**BASE, "switch": True})
        self.assertEqual(len(out), 1)
        self.assertIn("'switch' may only be false", out[0])

    def test_switch_not_boolean_fails(self):
        self.assertEqual(len(problems({**BASE, "switch": "false"})), 1)
        self.assertEqual(len(problems({**BASE, "switch": 0})), 1)


if __name__ == "__main__":
    unittest.main()
