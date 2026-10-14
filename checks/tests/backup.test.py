#!/usr/bin/env python3
"""Unit tests for the backup check (architecture.md 11.2). Pure stdlib over log lines
shaped like Litestream's and made-up file change times, no journal or disk read: they
exercise backup_problems directly.
Run standalone (`python3 checks/tests/backup.test.py`) or through the full check,
which globs checks/tests/*.test.py."""

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
_spec = importlib.util.spec_from_file_location("check", ROOT / "checks" / "check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)
T0 = check._log_seconds("2026-09-23T17:42:00.000Z")


def problems(lines, changed=None, now=None):
    """The check's verdict at `now`, seconds after 17:42:00 (by default the last line's)."""
    if now is None:
        now = max((check._log_seconds(line[5:29]) for line in lines), default=T0) - T0
    return check.backup_problems(lines, changed or {}, T0 + now)


def sync(db, online, local, second=0, ms=343):
    """One sync line, `second` seconds and `ms` milliseconds after 17:42:00."""
    stamp = f"2026-09-23T17:{42 + second // 60:02d}:{second % 60:02d}.{ms:03d}Z"
    return (f'time={stamp} level=INFO msg="replica sync" system=store db={db} '
            f"replica=s3 txid.replica={online} txid.db={local}")


def upload(db, txid, second=0, ms=600):
    stamp = f"2026-09-23T17:{42 + second // 60:02d}:{second % 60:02d}.{ms:03d}Z"
    return (f'time={stamp} level=INFO msg="ltx file uploaded" system=store db={db} replica=s3 '
            f"level=0 minTXID={txid} maxTXID={txid} size=2799")


ERROR = ('time=2026-09-23T17:41:30.016Z level=ERROR msg="compaction failed" system=store db=notes.db '
         'level=1 error="fetch dst level info: dial tcp: no such host"')


class Backup(unittest.TestCase):
    def test_caught_up_syncs_are_healthy(self):
        self.assertEqual(problems([sync("notes.db", "0012", "0012"), sync("books.db", "0003", "0003")]), [])

    def test_an_error_fails_and_names_it(self):
        found = problems([sync("notes.db", "0012", "0012"), ERROR])
        self.assertEqual(len(found), 1)
        self.assertIn("compaction failed", found[0])

    def test_no_sync_at_all_fails(self):
        self.assertEqual(problems([]), ["no database was synced in the last 2 minutes"])

    def test_an_error_older_than_the_error_window_is_over(self):
        self.assertEqual(problems([ERROR, sync("notes.db", "0012", "0012", 600)], now=11 * 60), [])

    def test_an_error_minutes_old_still_fails(self):
        # Litestream waits up to about five minutes before it tries a failing file again.
        rounds = [ERROR] + [sync("notes.db", "0012", "0012", t) for t in range(0, 300, 10)]
        self.assertEqual(len(problems(rounds)), 1)

    # Today's outage: the log kept saying both copies were equal while the file changed.
    def test_healthy_when_every_change_was_uploaded_after_it(self):
        rounds = [sync("notes.db", "05e9", "05e9", t) for t in range(0, 120, 10)] + [upload("notes.db", "05e9", 20)]
        self.assertEqual(problems(sorted(rounds), {"u1/notes.db": T0 + 15}), [])

    def test_equal_but_stale_counts_with_a_newer_change_fail(self):
        rounds = [sync("notes.db", "05e9", "05e9", t) for t in range(0, 120, 10)] + [upload("notes.db", "05e9", 20)]
        found = problems(sorted(rounds), {"u1/notes.db": T0 + 45})
        self.assertEqual(len(found), 1)
        self.assertIn("u1/notes.db changed", found[0])
        self.assertIn("not been copied online", found[0])

    def test_a_changed_file_never_uploaded_fails(self):
        rounds = [sync("notes.db", "05e9", "05e9", t) for t in range(0, 120, 10)]
        found = problems(rounds, {"u1/notes.db": T0 + 40, "session.db": T0 + 40})
        self.assertEqual(len(found), 2)
        self.assertIn("session.db changed", found[1])

    def test_a_change_within_the_grace_is_on_its_way(self):
        rounds = [sync("notes.db", "05e9", "05e9", t) for t in range(0, 120, 10)]
        self.assertEqual(problems(rounds, {"u1/notes.db": T0 + 95}), [])

    def test_a_change_older_than_the_log_is_not_judged(self):
        rounds = [sync("notes.db", "05e9", "05e9", t) for t in range(0, 120, 10)]
        self.assertEqual(problems(rounds, {"u1/notes.db": T0 - 16 * 60}), [])

    def test_one_upload_does_not_cover_two_same_named_files(self):
        # u2, on the .553 beat, goes from txid 8 to 9 at 50 s. u1, on the .464 beat, goes from
        # 1 to 2 at 40 s when it works, and when stuck keeps reporting 2 and 2.
        def rounds(u1_uploads):
            u1 = [sync("llm.db", "0001" if u1_uploads and t <= 40 else "0002",
                       "0001" if u1_uploads and t < 40 else "0002", t, 464) for t in range(0, 120, 10)]
            u2 = [sync("llm.db", "0009" if t > 50 else "0008", "0009" if t >= 50 else "0008", t, 553)
                  for t in range(0, 120, 10)]
            return sorted(u1 + u2 + [upload("llm.db", "0009", 50, 700)]
                          + ([upload("llm.db", "0002", 40, 600)] if u1_uploads else []))
        changed = {"u1/llm.db": T0 + 39, "u2/llm.db": T0 + 49}
        found = problems(rounds(False), changed)
        self.assertEqual(len(found), 1)
        self.assertIn("u1/llm.db", found[0])
        self.assertEqual(problems(rounds(True), changed), [])

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
