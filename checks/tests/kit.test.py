#!/usr/bin/env python3
"""Unit tests for the kit check (architecture.md 11.2): pure stdlib over source text,
no node run. Run standalone (`python3 checks/tests/kit.test.py`) or through the full
check, which globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
NAMES = ["notes", "session", "note-list", "dock"]


class Kit(unittest.TestCase):
    def test_a_component_named_as_a_whole_word_is_found(self):
        self.assertEqual(check.kit_mentions('document.querySelector("note-list")', NAMES), ["note-list"])
        self.assertEqual(check.kit_mentions("const notes = 1", NAMES), ["notes"])

    def test_a_longer_word_containing_a_name_is_not(self):
        self.assertEqual(check.kit_mentions('name: "unblent_session", notes2, my-dock', NAMES), [])

    def test_a_static_component_path_is_found(self):
        self.assertEqual(check.kit_mentions('import("/static/components/x/view.js")', NAMES), ["/static/components/"])

    def test_comments_do_not_count(self):
        self.assertEqual(check.kit_mentions("// the notes fact\n/* dock */\nconst x = 1", NAMES), [])

    def test_the_real_kit_names_nothing(self):
        names = [p.parent.name for p in ROOT.glob("components/*/machine.js")]
        self.assertEqual(check.kit_mentions((ROOT / "checks" / "kit.mjs").read_text(), names), [])


if __name__ == "__main__":
    unittest.main()
