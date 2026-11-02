#!/usr/bin/env python3
"""Unit tests for the steps check (architecture.md 7.3, 11.2, 12). Pure stdlib over
dict fixtures, no tree: they exercise steps_breaks, the decision, directly. Run
standalone (`python3 checks/tests/steps.test.py`) or through the full check, which
globs checks/tests/*.test.py."""

import contextlib
import importlib.util
import io
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

WIRED = {"emits": ["step.recorded", "step.settled"], "consumes": ["step.undone", "step.redone"]}


def fact(emits=(), consumes=(), steps=None):
    meta = {"kind": "fact", "shape": "local-only", "owns": "a thing", "description": "d", "emits": list(emits)}
    if steps is not None:
        meta["steps"] = steps
    return {"meta": meta, "consumes": list(consumes), "answers": [], "accepts": []}


def view(emits=()):
    return {"meta": {"kind": "view", "description": "d", "emits": list(emits), "attributes": []},
            "consumes": [], "answers": [], "accepts": []}


def breaks(recs):
    # Fixture names have no directory, so _contract_parties finds no tool queries.
    manifests = {f"components/zz-{n}/machine.js": m for n, m in recs.items()}
    parties = check._contract_parties(manifests)
    renamed = {f"zz-{n}": m for n, m in recs.items()}
    return check.steps_breaks(renamed, parties)


def wired_pair(cls="step"):
    return {
        "sheet": view(emits=["thing.saved"]),
        "things": fact(emits=WIRED["emits"], consumes=["thing.saved", *WIRED["consumes"]],
                       steps={"thing.saved": cls}),
    }


class Ok(unittest.TestCase):
    def test_a_wired_step_passes(self):
        self.assertEqual(breaks(wired_pair()), [])

    def test_an_event_from_a_fact_needs_no_class(self):
        recs = {"clock": fact(emits=["day.changed"]), "things": fact(consumes=["day.changed"])}
        self.assertEqual(breaks(recs), [])

    def test_follows_a_step_owner_passes(self):
        recs = wired_pair()
        recs["checks"] = fact(consumes=["thing.saved"], steps={"thing.saved": "follows"})
        self.assertEqual(breaks(recs), [])


class Breaks(unittest.TestCase):
    def test_missing_entry(self):
        recs = wired_pair()
        recs["things"]["meta"]["steps"] = {}
        out = breaks(recs)
        self.assertEqual(out, [("zz-things",
            "`zz-things` takes in `thing.saved` from `zz-sheet`: say in `steps` of "
            "`components/zz-things/machine.js` whether it is a step (architecture 12)")])

    def test_stale_key(self):
        recs = wired_pair()
        recs["things"]["meta"]["steps"]["thing.gone"] = "navigation"
        out = breaks(recs)
        self.assertEqual(len(out), 1)
        self.assertIn("`thing.gone` in `steps` is not an event", out[0][1])

    def test_bad_value(self):
        out = breaks(wired_pair("maybe"))
        self.assertEqual(len(out), 1)
        self.assertIn("classed 'maybe'", out[0][1])

    def test_step_without_wiring(self):
        recs = {"sheet": view(emits=["thing.saved"]),
                "things": fact(emits=["step.recorded"], consumes=["thing.saved", "step.undone"],
                               steps={"thing.saved": "step"})}
        out = breaks(recs)
        self.assertEqual(len(out), 1)
        self.assertIn("missing: step.settled, step.redone", out[0][1])

    def test_pending_is_no_class_any_more(self):
        out = breaks(wired_pair("pending"))
        self.assertEqual(len(out), 1)
        self.assertIn("classed 'pending'", out[0][1])

    def test_follows_with_no_step_owner(self):
        recs = {"sheet": view(emits=["thing.saved"]),
                "things": fact(consumes=["thing.saved"], steps={"thing.saved": "navigation"}),
                "checks": fact(consumes=["thing.saved"], steps={"thing.saved": "follows"})}
        out = breaks(recs)
        self.assertEqual(out[0][0], "zz-checks")
        self.assertIn("no other fact marks `thing.saved` as a step", out[0][1])

    def test_steps_not_a_mapping(self):
        out = breaks({"things": fact(steps=["thing.saved"])})
        self.assertIn("meta.steps must map", out[0][1])

    def test_steps_on_a_view(self):
        v = view()
        v["id"] = "zz-sheet"
        v["meta"]["steps"] = {"thing.saved": "step"}
        err = io.StringIO()
        with contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
            check.check_manifests({"components/zz-sheet/machine.js": v})
        self.assertIn("a view component has no steps", err.getvalue())


if __name__ == "__main__":
    unittest.main()
