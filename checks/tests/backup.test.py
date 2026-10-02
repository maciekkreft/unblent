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


def sync(db, online, local, second=0, ms=343):
    """One sync line, `second` seconds and `ms` milliseconds after 17:42:00."""
    stamp = f"2026-09-23T17:{42 + second // 60:02d}:{second % 60:02d}.{ms:03d}Z"
    return (f'time={stamp} level=INFO msg="replica sync" system=store db={db} '
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

    def test_a_change_seconds_old_is_on_its_way(self):
        # The line is written before the round uploads, so the latest one may read behind.
        rounds = [sync("notes.db", "0012", "0012", t) for t in range(0, 50, 10)] + [sync("notes.db", "0012", "0013", 50)]
        self.assertEqual(problems(rounds), [])

    def test_steady_saving_is_healthy_while_the_online_copy_moves(self):
        # Five rounds behind in a row, each round uploading what the one before saw.
        rounds = [sync("notes.db", f"{0x30 + i:04x}", f"{0x31 + i:04x}", i * 10) for i in range(6)]
        self.assertEqual(problems(rounds), [])

    def test_a_change_older_than_the_grace_not_online_fails(self):
        rounds = [sync("notes.db", "0012", "0012", 0)] + [sync("notes.db", "0012", "0013", t) for t in range(10, 60, 10)]
        found = problems(rounds)
        self.assertEqual(len(found), 1)
        self.assertIn("notes.db", found[0])

    def test_too_short_a_log_is_not_judged(self):
        self.assertEqual(problems([sync("notes.db", "0012", "0013", t) for t in range(0, 30, 10)]), [])
    def test_two_accounts_files_of_one_name_are_judged_apart(self):
        # Same name, different beat: one account far ahead of the other is not a lag.
        rounds = [line for t in range(0, 60, 10)
                  for line in (sync("notes.db", "0156", "0156", t, 464), sync("notes.db", "0002", "0002", t, 553))]
        self.assertEqual(problems(rounds), [])

    def test_one_of_two_same_named_files_stuck_fails(self):
        rounds = [line for t in range(0, 60, 10)
                  for line in (sync("notes.db", "0156", "0156", t, 464), sync("notes.db", "0002", "0003", t, 614))]
        found = problems(rounds)
        self.assertEqual(len(found), 1)
        self.assertIn("notes.db", found[0])


if __name__ == "__main__":
    unittest.main()
