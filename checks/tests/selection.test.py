#!/usr/bin/env python3
"""Unit tests for the task-end test selection (architecture.md 11). Pure stdlib over
the page-address helpers, the contract-change detection and affected_tests fed a stub
manifest and the real pages, no git and no node run. Run standalone
(`python3 checks/tests/selection.test.py`) or through the full check, which globs
checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
SMOKE = check.SMOKE_TEST


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


def manifest(emits=(), asks=(), consumes=(), accepts=(), answers=()):
    return {"meta": {"emits": list(emits), "asks": list(asks)},
            "consumes": list(consumes), "accepts": list(accepts), "answers": list(answers)}


class Contracts(unittest.TestCase):
    def test_a_schema_file_added_changed_or_removed_is_a_contract_change(self):
        got = check.contract_files_changed([
            "components/notes/events/note.saved.json",
            "components/llm/queries/complete.json",
            "components/note-editor/commands/focus.json",
            "components/note-editor/view.js",
            "components/notes/tests/machine.test.mjs",
        ])
        self.assertEqual(got, {"notes", "llm", "note-editor"})

    def test_the_contract_is_what_the_component_says_on_the_bus_in_any_order(self):
        a = manifest(emits=["b.x", "a.y"], asks=["n: read"], consumes=["c.z"], accepts=["focus"], answers=["list"])
        b = manifest(emits=["a.y", "b.x"], asks=["n: read"], consumes=["c.z"], accepts=["focus"], answers=["list"])
        self.assertEqual(check.contract_of(a), check.contract_of(b))
        self.assertNotEqual(check.contract_of(a), check.contract_of(manifest(emits=["a.y"])))

    def test_which_seeds_changed_their_contract(self):
        head = {"same": manifest(emits=["s.changed"]), "grew": manifest(emits=["g.changed"]),
                "handles": manifest(consumes=["x.y"])}
        tree = {"components/same/machine.js": manifest(emits=["s.changed"]),
                "components/grew/machine.js": manifest(emits=["g.changed", "g.deleted"]),
                "components/handles/machine.js": manifest(consumes=["x.y", "x.z"]),
                "components/fresh/machine.js": manifest()}
        got = check.contracts_changed({"same", "grew", "handles", "fresh"}, tree, head)
        self.assertEqual(got, {"grew", "handles", "fresh"})


class Affected(unittest.TestCase):
    def setUp(self):
        # settings-sheet sits on the product page and the settings page (real pages/).
        self.manifests = {
            "components/settings/machine.js": manifest(emits=["settings.changed"]),
            "components/settings-sheet/machine.js": manifest(consumes=["settings.changed"]),
        }
        self.tests = ["components/settings/tests/page.test.mjs", "components/settings-sheet/tests/page.test.mjs",
                      "components/book-shelf/tests/page.test.mjs", SMOKE]

    def test_infrastructure_runs_everything(self):
        self.assertIsNone(check.affected_tests(["bus/bus.js"], self.manifests, self.tests))
        self.assertIsNone(check.classify_changes(["requirements.txt"], self.manifests))

    def test_a_change_that_keeps_the_contract_reaches_own_tests_and_the_page_smoke_only(self):
        files, pages = check.affected_tests(["components/settings-sheet/view.js"], self.manifests, self.tests)
        self.assertEqual(files, {"components/settings-sheet/tests/page.test.mjs", SMOKE})
        self.assertIn("/", pages)
        self.assertIn("/workshop/design/settings", pages)

    def test_a_contract_change_reaches_the_partners_too(self):
        files, _ = check.affected_tests(["components/settings-sheet/view.js"], self.manifests, self.tests,
                                        contract_changed={"settings-sheet"})
        self.assertEqual(files, {"components/settings-sheet/tests/page.test.mjs",
                                 "components/settings/tests/page.test.mjs", SMOKE})

    def test_a_page_edit_reaches_its_smoke_test_and_the_tests_that_open_it(self):
        tests = sorted(str(p.relative_to(ROOT)) for p in ROOT.glob("components/*/tests/*.test.mjs"))
        files, pages = check.affected_tests(["pages/index.html"], self.manifests, tests)
        self.assertEqual(pages, {"/"})
        self.assertIn(SMOKE, files)
        for f in files - {SMOKE}:
            self.assertTrue(check._opens((ROOT / f).read_text(), "/"), f)

    def test_a_page_that_merely_holds_the_component_does_not_pull_in_its_openers(self):
        tests = sorted(str(p.relative_to(ROOT)) for p in ROOT.glob("components/*/tests/*.test.mjs"))
        files, pages = check.affected_tests(["components/settings-sheet/view.js"], self.manifests, tests)
        self.assertIn("/", pages)
        self.assertEqual({Path(f).parts[1] for f in files}, {"settings-sheet", "pages"})


if __name__ == "__main__":
    unittest.main()
