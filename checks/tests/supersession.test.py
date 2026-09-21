#!/usr/bin/env python3
"""Unit tests for the supersession rule (architecture.md 4.2, 4.3, 11.2). Pure
stdlib over dict fixtures, no tree: they exercise supersession_breaks, the decision,
directly. Run standalone (`python3 checks/tests/supersession.test.py`) or through the
full check, which globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
breaks = check.supersession_breaks


def manifest(kind="view", emits=None, asks=None, consumes=None):
    return {
        "meta": {"kind": kind, "emits": emits or [], "asks": asks or []},
        "consumes": consumes or [],
    }


# A fact owning notes, a view listing them, wired the way note-list/notes are.
def wired():
    recs = {
        "notes": manifest("fact", emits=["note.changed", "note.deleted"]),
        "note-list": manifest("view", asks=["notes: list"], consumes=["note.changed", "note.deleted"]),
    }
    schemas = {("notes", "list"): {"supersededBy": ["note.changed", "note.deleted"]}}
    return recs, schemas


class Ok(unittest.TestCase):
    def test_wired_pair_passes(self):
        recs, schemas = wired()
        self.assertEqual(breaks(recs, schemas), [])

    def test_empty_supersededby_passes(self):
        recs = {"catalog": manifest("fact")}
        schemas = {("catalog", "list"): {"supersededBy": []}}
        self.assertEqual(breaks(recs, schemas), [])


class Breaks(unittest.TestCase):
    def test_missing_key(self):
        recs = {"notes": manifest("fact", emits=["note.changed"])}
        schemas = {("notes", "list"): {"payload": {}, "reply": {}}}
        out = breaks(recs, schemas)
        self.assertEqual(len(out), 1)
        self.assertIn("no supersededBy list", out[0][2])

    def test_not_a_list_of_strings(self):
        recs = {"notes": manifest("fact", emits=["note.changed"])}
        schemas = {("notes", "list"): {"supersededBy": [1, 2]}}
        self.assertIn("no supersededBy list", breaks(recs, schemas)[0][2])

    def test_names_an_event_the_owner_does_not_emit(self):
        recs = {"notes": manifest("fact", emits=["note.changed"])}
        schemas = {("notes", "list"): {"supersededBy": ["note.deleted"]}}
        out = breaks(recs, schemas)
        self.assertIn("does not emit", out[0][2])

    def test_asker_does_not_consume_the_superseding_event(self):
        recs, schemas = wired()
        # Drop note.deleted from the asker's subscriptions: it queries for the start
        # but would miss a deletion that races the list.
        recs["note-list"]["consumes"] = ["note.changed"]
        out = breaks(recs, schemas)
        self.assertEqual(len(out), 1)
        owner, q, detail = out[0]
        self.assertEqual((owner, q), ("notes", "list"))
        self.assertIn("note-list asks notes: list", detail)
        self.assertIn("note.deleted", detail)
        self.assertIn("supersedes it", detail)


class Wildcard(unittest.TestCase):
    # The wildcard ask `*: tool` (7.7) asks no specific query, so its holder is not made
    # to consume a tool's supersededBy events; only an exact ask carries that duty.
    def test_wildcard_asker_is_not_held_to_follow_a_tool(self):
        recs = {
            "notes": manifest("fact", emits=["note.changed", "note.deleted"]),
            # A tool-asker that consumes neither superseding event; it must not be flagged.
            "conversations": manifest("fact", emits=[], asks=["*: tool"], consumes=[]),
        }
        schemas = {("notes", "list"): {"supersededBy": ["note.changed", "note.deleted"]}}
        self.assertEqual(breaks(recs, schemas), [])

    def test_exact_asker_alongside_a_wildcard_is_still_checked(self):
        # An exact asker missing a superseding event is still a break, wildcard or not.
        recs = {
            "notes": manifest("fact", emits=["note.changed", "note.deleted"]),
            "note-list": manifest("view", asks=["notes: list", "*: tool"], consumes=["note.changed"]),
        }
        schemas = {("notes", "list"): {"supersededBy": ["note.changed", "note.deleted"]}}
        out = breaks(recs, schemas)
        self.assertEqual(len(out), 1)
        self.assertIn("note.deleted", out[0][2])


if __name__ == "__main__":
    unittest.main()
