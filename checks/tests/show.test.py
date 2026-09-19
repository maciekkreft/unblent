#!/usr/bin/env python3
"""Unit tests for show.py (architecture.md 7.1, 11.1). Pure stdlib over a sample reply,
no server: they exercise the line builders directly. Run standalone
(`python3 checks/tests/show.test.py`) or through the full check, which globs
checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("show", ROOT / "checks" / "show.py")
show = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(show)

CONTRACTS = {
    "events": [
        {"name": "note.deleted", "owner": "notes", "consumers": ["note-list"],
         "schema": {"type": "object", "properties": {"id": {"type": "string"}}}},
    ],
    "queries": [
        {"target": "notes", "name": "read", "askers": ["note-editor"],
         "supersededBy": ["note.changed", "note.deleted"],
         "payload": {"type": "object", "properties": {"id": {}}},
         "reply": {"oneOf": [{"properties": {"note": {}}}, {"properties": {"error": {}}}]}},
        {"target": "books", "name": "read", "askers": [], "supersededBy": [],
         "payload": {"type": "object"}, "reply": {"properties": {"book": {}}}},
    ],
    "commands": [
        {"target": "note-editor", "name": "load", "payload": {"properties": {"id": {}}}},
    ],
}


class ContractLines(unittest.TestCase):
    def test_one_line_per_contract_under_a_counted_heading(self):
        self.assertEqual(show.contract_lines(CONTRACTS), [
            "events (1)",
            "note.deleted  owner: notes  { id }",
            "",
            "queries (2)",
            "notes: read  { id }  → { note } | { error }; superseded by note.changed, note.deleted",
            "books: read  {}      → { book }; superseded by nothing",
            "",
            "commands (1)",
            "note-editor: load  { id }",
        ])

    def test_an_empty_kind_has_no_heading(self):
        lines = show.contract_lines({**CONTRACTS, "commands": []})
        self.assertNotIn("commands (0)", lines)
        self.assertEqual(lines[-1], "books: read  {}      → { book }; superseded by nothing")


class FindContracts(unittest.TestCase):
    def test_an_event_by_its_name(self):
        self.assertEqual([c["owner"] for c in show.find_contracts(CONTRACTS, "note.deleted")], ["notes"])

    def test_a_bare_query_name_finds_every_target(self):
        self.assertEqual([c["target"] for c in show.find_contracts(CONTRACTS, "read")], ["notes", "books"])

    def test_target_and_name_finds_one(self):
        self.assertEqual([c["target"] for c in show.find_contracts(CONTRACTS, "books: read")], ["books"])

    def test_an_unknown_name_finds_nothing(self):
        self.assertEqual(show.find_contracts(CONTRACTS, "note.vanished"), [])


class ComponentAndPageLines(unittest.TestCase):
    def test_a_component_lists_only_what_it_has(self):
        catalog = {"components": [
            {"name": "notes", "kind": "fact", "status": "built", "shape": "replicated", "role": None,
             "emits": ["note.changed"], "consumes": [], "answers": ["list"], "accepts": [], "asks": []},
        ]}
        self.assertEqual(show.component_lines(catalog), [
            "notes  fact  built  replicated",
            "    emits: note.changed",
            "    answers: list",
        ])

    def test_pages_are_aligned_by_kind_and_path(self):
        pages = {"pages": [
            {"kind": "app", "path": "/", "title": "Unblent"},
            {"kind": "tokens", "path": "/workshop/design/tokens", "title": "Tokens"},
        ]}
        self.assertEqual(show.page_lines(pages), [
            "app     /                        Unblent",
            "tokens  /workshop/design/tokens  Tokens",
        ])


if __name__ == "__main__":
    unittest.main()
