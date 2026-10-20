#!/usr/bin/env python3
"""Unit tests for the send rule of the contract check (architecture.md 4.4, 11.2).
Pure stdlib over dict fixtures, no tree: they exercise send_problems directly. Run
standalone (`python3 checks/tests/sends.test.py`) or through the full check, which
globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)


def manifest(sends=None, accepts=None):
    return {"meta": {"kind": "view", "emits": [], "sends": sends or []}, "accepts": accepts or []}


class Sends(unittest.TestCase):
    def test_a_send_the_target_accepts_passes(self):
        recs = {"stage": manifest(sends=["editor: load"]), "editor": manifest(accepts=["load", "focus"])}
        self.assertEqual(check.send_problems(recs), [])

    def test_a_send_to_a_missing_component_fails(self):
        recs = {"stage": manifest(sends=["ghost: load"])}
        out = check.send_problems(recs)
        self.assertEqual(len(out), 1)
        self.assertIn("no component 'ghost'", out[0][1])

    def test_a_send_the_target_does_not_accept_fails(self):
        recs = {"stage": manifest(sends=["editor: open"]), "editor": manifest(accepts=["load"])}
        out = check.send_problems(recs)
        self.assertEqual(out[0][0], "stage")
        self.assertIn("does not accept 'open'", out[0][1])

    def test_a_sender_is_a_bus_partner_of_its_target(self):
        # Section 11: a changed contract reaches the partners' tests, senders included.
        manifests = {
            "components/stage/machine.js": manifest(sends=["editor: load"]) | {"consumes": []},
            "components/editor/machine.js": manifest(accepts=["load"]) | {"consumes": []},
        }
        graph = check._interaction_graph(manifests)
        self.assertIn("editor", graph["stage"])
        self.assertIn("stage", graph["editor"])


if __name__ == "__main__":
    unittest.main()
