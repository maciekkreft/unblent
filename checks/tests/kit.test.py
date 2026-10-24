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

    def test_a_property_named_like_a_component_is_not(self):
        self.assertEqual(check.kit_mentions("Object.values(actors)", NAMES + ["values"]), [])

    def test_a_static_component_path_is_found(self):
        self.assertEqual(check.kit_mentions('import("/static/components/x/view.js")', NAMES), ["/static/components/"])

    def test_comments_do_not_count(self):
        self.assertEqual(check.kit_mentions("// the notes fact\n/* dock */\nconst x = 1", NAMES), [])

    def test_the_real_kit_names_nothing(self):
        names = [p.parent.name for p in ROOT.glob("components/*/machine.js")]
        self.assertEqual(check.kit_mentions((ROOT / "checks" / "kit.mjs").read_text(), names), [])


class EditorKit(unittest.TestCase):
    # The editor kit (architecture.md 10) imports only vendored CodeMirror packages and
    # knows no component, the same rule as the kit's.
    def test_only_codemirror_imports_pass(self):
        src = 'import { x } from "@codemirror/view";\nimport { vim } from "@replit/codemirror-vim";\nimport "./more.js";'
        self.assertEqual(check.editor_import_problems(src), [])

    def test_the_bus_another_library_or_a_parent_path_fails(self):
        self.assertEqual(len(check.editor_import_problems('import { ask } from "bus"')), 1)
        self.assertEqual(len(check.editor_import_problems('import { html } from "lit"')), 1)
        self.assertEqual(len(check.editor_import_problems('import "../components/x/view.js"')), 1)
        self.assertEqual(len(check.editor_import_problems('import("@codemirror/unvendored")')), 1)

    def test_the_real_editor_kit_imports_and_names_nothing_it_may_not(self):
        names = [p.parent.name for p in ROOT.glob("components/*/machine.js")]
        for path in ROOT.glob("editor/*.js"):
            src = path.read_text()
            self.assertEqual(check.editor_import_problems(src), [], path)
            self.assertEqual(check.kit_mentions(src, names), [], path)

    def test_theme_objects_are_read_as_css_declarations(self):
        src = '// fontSize: "12px"\nEditorView.theme({ ".cm-line": { fontSize: "var(--text-body)", paddingTop: "4px" } })'
        self.assertEqual(check.theme_declarations(src), [("font-size", "var(--text-body)"), ("padding-top", "4px")])


if __name__ == "__main__":
    unittest.main()
