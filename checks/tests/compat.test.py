#!/usr/bin/env python3
"""Unit tests for the schema compatibility rule (architecture.md 7.1, 11.2). Pure
stdlib over dict fixtures, no git: they exercise schema_breaks, the structural diff,
directly. Run standalone (`python3 checks/tests/compat.test.py`) or through the full
check, which globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
breaks = check.schema_breaks

DRAFT = "https://json-schema.org/draft/2020-12/schema"


def obj(props, required=None, extra=None):
    s = {"$schema": DRAFT, "type": "object", "properties": props,
         "additionalProperties": False}
    if required is not None:
        s["required"] = required
    if extra:
        s.update(extra)
    return s


class Compatible(unittest.TestCase):
    def test_identical(self):
        s = obj({"a": {"type": "string"}}, ["a"])
        self.assertEqual(breaks(s, s), [])

    def test_added_optional_property(self):
        old = obj({"a": {"type": "string"}}, ["a"])
        new = obj({"a": {"type": "string"}, "b": {"type": "string"}}, ["a"])
        self.assertEqual(breaks(old, new), [])

    def test_type_widened(self):
        old = {"type": "string"}
        new = {"type": ["string", "null"]}
        self.assertEqual(breaks(old, new), [])

    def test_enum_gains_value(self):
        old = {"enum": ["a", "b"]}
        new = {"enum": ["a", "b", "c"]}
        self.assertEqual(breaks(old, new), [])

    def test_oneof_gains_branch(self):
        old = {"oneOf": [{"type": "string"}]}
        new = {"oneOf": [{"type": "string"}, {"type": "null"}]}
        self.assertEqual(breaks(old, new), [])

    def test_additional_properties_opened(self):
        old = obj({"a": {"type": "string"}})  # closed
        new = {"$schema": DRAFT, "type": "object",
               "properties": {"a": {"type": "string"}}}  # open (absent)
        self.assertEqual(breaks(old, new), [])


class Breaking(unittest.TestCase):
    def test_removed_property(self):
        old = obj({"a": {"type": "string"}, "b": {"type": "string"}})
        new = obj({"a": {"type": "string"}})
        self.assertTrue(any("properties/b" in b for b in breaks(old, new)))

    def test_renamed_property(self):
        old = obj({"a": {"type": "string"}})
        new = obj({"c": {"type": "string"}})
        self.assertTrue(any("properties/a" in b for b in breaks(old, new)))

    def test_new_required(self):
        old = obj({"a": {"type": "string"}, "b": {"type": "string"}}, ["a"])
        new = obj({"a": {"type": "string"}, "b": {"type": "string"}}, ["a", "b"])
        self.assertTrue(any("required" in b and "'b'" in b for b in breaks(old, new)))

    def test_type_narrowed(self):
        old = {"type": ["string", "null"]}
        new = {"type": "string"}
        self.assertTrue(any("type narrowed" in b for b in breaks(old, new)))

    def test_enum_value_removed(self):
        old = {"enum": ["a", "b", "c"]}
        new = {"enum": ["a", "b"]}
        self.assertTrue(any("enum" in b for b in breaks(old, new)))

    def test_const_changed(self):
        old = {"const": "x"}
        new = {"const": "y"}
        self.assertTrue(any("const" in b for b in breaks(old, new)))

    def test_oneof_branch_removed(self):
        old = {"oneOf": [{"type": "string"}, {"type": "null"}]}
        new = {"oneOf": [{"type": "string"}]}
        self.assertTrue(any("oneOf" in b and "branch removed" in b for b in breaks(old, new)))

    def test_additional_properties_closed(self):
        old = {"$schema": DRAFT, "type": "object", "properties": {"a": {"type": "string"}}}
        new = obj({"a": {"type": "string"}})  # additionalProperties False
        self.assertTrue(any("additionalProperties" in b for b in breaks(old, new)))

    def test_boolean_true_narrowed(self):
        self.assertTrue(any("accept-anything" in b for b in breaks(True, {"type": "object"})))
        self.assertTrue(any("accept-anything" in b for b in breaks(True, False)))

    def test_nested_in_items(self):
        old = {"type": "array", "items": obj({"a": {"type": "string"}, "b": {"type": "string"}})}
        new = {"type": "array", "items": obj({"a": {"type": "string"}})}
        self.assertTrue(any("items/properties/b" in b for b in breaks(old, new)))

    def test_nested_in_oneof_branch(self):
        old = {"oneOf": [{"type": "string"}, obj({"a": {}, "b": {}})]}
        new = {"oneOf": [{"type": "string"}, obj({"a": {}})]}
        self.assertTrue(any("oneOf/1/properties/b" in b for b in breaks(old, new)))


class QueryFixture(unittest.TestCase):
    """schema_breaks is called per payload/reply key by the rule; simulate that."""

    def test_reply_removed_field_prefixed(self):
        old = {"payload": obj({}), "reply": obj({"a": {}, "b": {}})}
        new = {"payload": obj({}), "reply": obj({"a": {}})}
        found = []
        for key in ("payload", "reply"):
            found += breaks(old[key], new[key], key)
        self.assertTrue(any(b.startswith("reply/properties/b") for b in found))

    def test_payload_new_required_prefixed(self):
        old = {"payload": obj({"a": {}}, []), "reply": obj({})}
        new = {"payload": obj({"a": {}}, ["a"]), "reply": obj({})}
        found = []
        for key in ("payload", "reply"):
            found += breaks(old[key], new[key], key)
        self.assertTrue(any(b.startswith("payload/required") for b in found))


if __name__ == "__main__":
    unittest.main()
