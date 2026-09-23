#!/usr/bin/env python3
"""Unit tests for the task-end test selection (architecture.md 11). Pure stdlib over
the page-address helpers and over affected_tests fed a stub manifest and the real
pages, no git and no node run. Run standalone (`python3 checks/tests/selection.test.py`)
or through the full check, which globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


class Addresses(unittest.TestCase):
    def test_product_and_workshop_pages(self):
        self.assertEqual(check._page_address("pages/index.html"), "/")
        self.assertEqual(check._page_address("pages/workshop/design/notes.html"), "/workshop/design/notes")

    def test_a_workshop_address_is_not_a_prefix_match(self):
        self.assertTrue(check._opens('goto(`${BASE_URL}/workshop/design/notes`)', "/workshop/design/notes"))
        self.assertFalse(check._opens('goto(`${BASE_URL}/workshop/design/notes-x`)', "/workshop/design/notes"))

    def test_the_product_is_opened_by_slash_after_the_base_url(self):
        self.assertTrue(check._opens('page.goto(`${BASE_URL}/`)', "/"))
        self.assertFalse(check._opens('page.goto(`${BASE_URL}/workshop/design/notes`)', "/"))


class Affected(unittest.TestCase):
    def setUp(self):
        self.manifests = {
            "components/settings/machine.js": {"meta": {"emits": ["settings.changed"]}, "consumes": []},
            "components/settings-sheet/machine.js": {"meta": {"emits": []}, "consumes": ["settings.changed"]},
        }

    def test_infrastructure_runs_everything(self):
        self.assertIsNone(check.affected_tests(["bus/bus.js"], self.manifests, []))

    def test_a_component_reaches_its_partners_but_not_unrelated_tests(self):
        # book-shelf is no partner of settings-sheet and opens no page holding it.
        tests = ["components/settings/tests/page.test.mjs", "components/book-shelf/tests/page.test.mjs"]
        got = check.affected_tests(["components/settings-sheet/view.js"], self.manifests, tests)
        self.assertEqual(got, {"components/settings/tests/page.test.mjs"})

    def test_a_page_edit_reaches_the_tests_that_open_it(self):
        tests = sorted(str(p.relative_to(ROOT)) for p in ROOT.glob("components/*/tests/*.test.mjs"))
        got = check.affected_tests(["pages/index.html"], self.manifests, tests)
        self.assertTrue(got)
        for f in got:
            self.assertTrue(check._opens((ROOT / f).read_text(), "/"), f)


if __name__ == "__main__":
    unittest.main()
