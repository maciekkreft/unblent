#!/usr/bin/env python3
"""Unit tests for the counts check (architecture.md 7.3, 11.2). Pure stdlib over dict
fixtures, no tree: they exercise counts_breaks, the decision, directly. Run standalone
(`python3 checks/tests/counts.test.py`) or through the full check, which globs
checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

FEATURES = ["notes", "highlights", "other"]


def fact(emits=(), counts=None, features=FEATURES):
    meta = {"kind": "fact", "shape": "replicated", "owns": "a thing", "description": "d", "emits": list(emits)}
    if counts is not None:
        meta["counts"] = counts
        meta["features"] = features
    return {"meta": meta, "consumes": [], "answers": [], "accepts": []}


def view(emits=()):
    return {"meta": {"kind": "view", "description": "d", "emits": list(emits), "attributes": []},
            "consumes": [], "answers": [], "accepts": []}


def breaks(recs):
    manifests = {f"components/{n}/machine.js": m for n, m in recs.items()}
    return check.counts_breaks(recs, check._contract_parties(manifests))


def world(counts):
    return {
        "editor": view(emits=["note.saved"]),
        "reader": view(emits=["note.saved"]),
        "notes": fact(emits=["note.changed"]),
        "usage": fact(counts=counts),
    }


SPLIT = {"note.saved": {"editor": "notes", "reader": "highlights"}}


class Ok(unittest.TestCase):
    def test_no_counts_anywhere_passes(self):
        recs = world(None)
        self.assertEqual(breaks(recs), [])

    def test_every_view_event_classed_passes(self):
        self.assertEqual(breaks(world(SPLIT)), [])

    def test_a_flat_feature_covers_every_sender(self):
        self.assertEqual(breaks(world({"note.saved": "notes"})), [])

    def test_an_event_from_a_fact_needs_no_class(self):
        # Only a view announces what the user did (4.3), so a fact's event is not counted.
        recs = world(SPLIT)
        recs["notes"]["meta"]["emits"].append("note.purged")
        self.assertEqual(breaks(recs), [])


class Breaks(unittest.TestCase):
    def test_unclassed_event_names_file_features_and_instruction(self):
        out = breaks(world({}))
        self.assertEqual(out, [("usage",
            "`note.saved` is emitted by `editor`, `reader` but not counted: add \"note.saved\": \"<feature>\" "
            "to `meta.counts` in `components/usage/machine.js`, picking the feature the user is in when they "
            "do this: notes, highlights, other; use a map {\"<view>\": \"<feature>\"} if the event belongs to "
            "different features depending on the view that emits it")])

    def test_missing_sender(self):
        out = breaks(world({"note.saved": {"editor": "notes"}}))
        self.assertEqual(len(out), 1)
        self.assertIn("also emitted by `reader`", out[0][1])
        self.assertIn("components/usage/machine.js", out[0][1])

    def test_sender_that_does_not_emit(self):
        out = breaks(world({"note.saved": {"editor": "notes", "reader": "highlights", "list": "notes"}}))
        self.assertEqual(len(out), 1)
        self.assertIn("`list` in the map of `note.saved`", out[0][1])

    def test_stale_key(self):
        out = breaks(world({**SPLIT, "note.gone": "notes"}))
        self.assertEqual(out, [("usage",
            "`note.gone` in `meta.counts` in `components/usage/machine.js` is not an event any view emits; remove it")])

    def test_a_fact_event_is_a_stale_key(self):
        out = breaks(world({**SPLIT, "note.changed": "notes"}))
        self.assertEqual(len(out), 1)
        self.assertIn("`note.changed`", out[0][1])

    def test_bad_feature_id(self):
        out = breaks(world({"note.saved": "chats"}))
        self.assertEqual(len(out), 1)
        self.assertIn("counted as 'chats'; a feature is one of: notes, highlights, other", out[0][1])

    def test_bad_feature_id_in_a_sender_map(self):
        out = breaks(world({"note.saved": {"editor": "notes", "reader": "books"}}))
        self.assertEqual(len(out), 1)
        self.assertIn("`note.saved` from `reader` is counted as 'books'", out[0][1])

    def test_counts_without_features(self):
        out = breaks(world(SPLIT) | {"usage": fact(counts=SPLIT, features=None)})
        self.assertEqual(len(out), 1)
        self.assertIn("meta.features", out[0][1])

    def test_a_view_has_no_counts(self):
        recs = world(SPLIT)
        recs["editor"]["meta"]["counts"] = {}
        out = breaks(recs)
        self.assertEqual(out, [("editor", "a view component has no `counts`; a fact classes the events views emit")])


if __name__ == "__main__":
    unittest.main()
