#!/usr/bin/env python3
"""Unit tests for the backup check (architecture.md 11.2). Pure stdlib over log lines
shaped like Litestream's, no journal read: they exercise backup_problems directly.
Run standalone (`python3 checks/tests/backup.test.py`) or through the full check,
which globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
problems = check.backup_problems


def sync(db, online, local):
    return (f'time=2026-09-23T17:42:47.572Z level=INFO msg="replica sync" system=store db={db} '
            f"replica=s3 txid.replica={online} txid.db={local}")


ERROR = ('time=2026-09-23T17:38:30.016Z level=ERROR msg="compaction failed" system=store db=notes.db '
         'level=1 error="fetch dst level info: dial tcp: no such host"')


class Backup(unittest.TestCase):
    def test_caught_up_syncs_are_healthy(self):
        self.assertEqual(problems([sync("notes.db", "0012", "0012"), sync("books.db", "0003", "0003")]), [])

    def test_an_error_fails_and_names_it(self):
        found = problems([sync("notes.db", "0012", "0012"), ERROR])
        self.assertEqual(len(found), 1)
        self.assertIn("compaction failed", found[0])

    def test_no_sync_at_all_fails(self):
        self.assertEqual(problems([]), ["no database was synced"])

    def test_only_the_latest_sync_of_a_database_counts(self):
        self.assertEqual(problems([sync("notes.db", "0011", "0012"), sync("notes.db", "0012", "0012")]), [])
        found = problems([sync("notes.db", "0012", "0012"), sync("notes.db", "0012", "0013")])
        self.assertEqual(len(found), 1)
        self.assertIn("notes.db", found[0])


if __name__ == "__main__":
    unittest.main()
