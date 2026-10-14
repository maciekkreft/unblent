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


def parse(html: str, what: str = "custom") -> list:
    """Feed a temporary page file to PageChecker and return its custom tags, or
    another list it collects (`what`)."""
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
        path = f.name
    checker = check.PageChecker(path)
    checker.feed(Path(path).read_text())
    Path(path).unlink()
    return getattr(checker, what)


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


# The containers' consumed gestures, as their manifests would report them.
CONSUMES = {
    "dock-desk": {"dock.changed", "book.selected", "note.selected"},
    "list-then-item": {"book.selected", "note.selected", "highlights.selected"},
}


def shows_on(html: str) -> list:
    page = "<!doctype html><html><body>" + html + "</body></html>"
    return check.shows_on_problems(parse(page, "shows_on"), CONSUMES)


class ShowsOn(unittest.TestCase):
    def test_consumed_gesture_ok(self):
        self.assertEqual(shows_on(
            '<dock-desk><book-shelf></book-shelf>'
            '<book-toc shows-on="book.selected"></book-toc></dock-desk>'), [])

    def test_unconsumed_gesture_names_page_tag_event_and_container(self):
        found = shows_on(
            '<dock-desk><list-then-item id="chats" shows-on="note.selected">'
            '<conversation-list></conversation-list>'
            '<chat-thread shows-on="conversation.selected"></chat-thread>'
            '</list-then-item></dock-desk>')
        self.assertEqual(len(found), 1)
        self.assertIn('<chat-thread> has shows-on="conversation.selected"', found[0])
        self.assertIn('<list-then-item id="chats">', found[0])
        self.assertIn("components/list-then-item/machine.js", found[0])

    def test_nested_list_then_item_checks_each_tag_against_its_nearest_container(self):
        def page(item_event):
            return (
                '<dock-desk><list-then-item id="outer" shows-on="book.selected">'
                '<book-shelf></book-shelf>'
                '<list-then-item id="inner" shows-on="highlights.selected">'
                '<note-list></note-list>'
                f'<note-editor shows-on="{item_event}"></note-editor>'
                '</list-then-item></list-then-item></dock-desk>')
        self.assertEqual(shows_on(page("note.selected")), [])
        found = shows_on(page("evaluator.selected"))
        self.assertEqual(len(found), 1)
        self.assertIn('<note-editor> has shows-on="evaluator.selected"', found[0])
        self.assertIn('<list-then-item id="inner">', found[0])

    def test_sibling_after_closed_container_belongs_to_the_outer_one(self):
        self.assertEqual(shows_on(
            '<dock-desk><list-then-item id="a"><note-list></note-list></list-then-item>'
            '<book-toc shows-on="book.selected"></book-toc></dock-desk>'), [])

    def test_shows_on_outside_any_container_fails(self):
        self.assertEqual(len(shows_on('<book-toc shows-on="book.selected"></book-toc>')), 1)

    def test_real_pages_pass(self):
        found = check.check_pages()
        consumes = {Path(p).parent.name: set(m["consumes"])
                    for p, m in check.read_manifests().items()}
        for path, checker in found.items():
            self.assertEqual(check.shows_on_problems(checker.shows_on, consumes), [], path)


if __name__ == "__main__":
    unittest.main()
