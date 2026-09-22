#!/usr/bin/env python3
"""Unit tests for the distinct-id page rule (architecture.md 4.1, 11.2). Pure
stdlib: they exercise duplicate_id_problems over fixtures and over PageChecker
fed real page files, no git. Run standalone (`python3 checks/tests/pages.test.py`)
or through the full check, which globs checks/tests/*.test.py."""

import glob
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
problems = check.duplicate_id_problems


def parse(html: str) -> list:
    """Feed a temporary page file to PageChecker and return its custom tags."""
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
        path = f.name
    checker = check.PageChecker(path)
    checker.feed(Path(path).read_text())
    Path(path).unlink()
    return checker.custom


class DuplicateIds(unittest.TestCase):
    def test_single_tag_no_id_ok(self):
        self.assertEqual(problems([("note-editor", None)]), [])

    def test_distinct_tags_no_ids_ok(self):
        self.assertEqual(problems([("note-list", None), ("note-editor", None)]), [])

    def test_same_tag_twice_no_ids_fails(self):
        self.assertTrue(problems([("note-editor", None), ("note-editor", None)]))

    def test_same_tag_twice_distinct_ids_ok(self):
        self.assertEqual(
            problems([("note-editor", "a"), ("note-editor", "b")]), [])

    def test_same_tag_twice_repeated_id_fails(self):
        self.assertTrue(problems([("note-editor", "x"), ("note-editor", "x")]))

    def test_same_tag_one_id_missing_fails(self):
        self.assertTrue(problems([("note-editor", "a"), ("note-editor", None)]))

    def test_id_reused_across_tags_fails(self):
        self.assertTrue(problems([("note-list", "x"), ("note-editor", "x")]))

    def test_instance_and_bare_ok(self):
        # A tag with an id beside another distinct tag never collides (4.1).
        self.assertEqual(
            problems([("note-editor", "a"), ("note-list", None)]), [])


class PageFiles(unittest.TestCase):
    def test_page_two_no_ids_fails(self):
        html = (
            "<!doctype html><html><body>"
            "<note-editor></note-editor><note-editor></note-editor>"
            "</body></html>"
        )
        self.assertTrue(problems(parse(html)))

    def test_page_distinct_ids_ok(self):
        html = (
            "<!doctype html><html><body>"
            '<note-editor id="one"></note-editor><note-editor id="two"></note-editor>'
            "</body></html>"
        )
        self.assertEqual(problems(parse(html)), [])

    def test_page_same_id_twice_fails(self):
        html = (
            "<!doctype html><html><body>"
            '<note-editor id="dup"></note-editor><note-editor id="dup"></note-editor>'
            "</body></html>"
        )
        self.assertTrue(problems(parse(html)))

    def test_real_pages_pass(self):
        for path in sorted(glob.glob("pages/**/*.html", root_dir=ROOT, recursive=True)):
            checker = check.PageChecker(path)
            checker.feed((ROOT / path).read_text())
            self.assertEqual(problems(checker.custom), [], path)


if __name__ == "__main__":
    unittest.main()
