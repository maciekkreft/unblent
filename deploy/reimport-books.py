#!/usr/bin/env python3
"""Re-run the epub importer over books already imported, from their kept source.epub,
under the next content version (architecture.md 5). Run on the host after the importer
changes, so a reader picks up the new markup on its next pull; the reading position
resets to the chapter start, because block indices shift with the new structure.

    .venv/bin/python deploy/reimport-books.py <user-id> [book-id ...]

With no book ids, every live (non-deleted) book of that user is re-imported. Honours
UNBLENT_DATA through server.user, like the running server, so a dry run points it at a
throwaway copy of data/.
"""

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from components.books.server.router import reimport
from server.user import user_dir


def _live_books(user_id: str) -> list[str]:
    db = user_dir(user_id) / "books.db"
    if not db.exists():
        return []
    connection = sqlite3.connect(db)
    try:
        rows = connection.execute("SELECT id FROM books WHERE deleted = 0 ORDER BY seq").fetchall()
    finally:
        connection.close()
    return [row[0] for row in rows]


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    user_id, book_ids = argv[0], argv[1:] or _live_books(argv[0])
    if not book_ids:
        print(f"no live books for {user_id}")
        return 0
    failed = 0
    for book_id in book_ids:
        try:
            row = reimport(user_id, book_id)
            print(f"{book_id}  {row['title']}  → content version {row['contentVersion']}")
        except Exception as error:  # noqa: BLE001 — a CLI reports every book and carries on
            failed += 1
            print(f"{book_id}  FAILED  {type(error).__name__}: {error}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
