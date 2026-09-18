"""books' server module (architecture.md 5, Decision 2): the far end of the
replicated books fact. Every route needs a signed-in user (require_user) and resolves
that user's own SQLite file and book directory, so isolation holds by construction.
The row (a few KB) holds what rides the bus; the chapters and images are files under
books/<id>/, served immutable under a URL carrying the content version so a re-import
never serves a stale cache. A position is last write wins and never refused (Decision
4); a delete purges the directory and tombstones the row (Decision 6).
"""

import json
import mimetypes
import re
import shutil
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from server.user import require_user, user_dir

from .importer import import_book, purge

router = APIRouter()

_SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
_NAME = re.compile(r"^[A-Za-z0-9._-]+$")
# The browser's HTTP cache is the only copy of a chapter or image (Decision 2); the
# content-version URL prefix makes a re-import a different URL, so the old cache lapses.
_IMMUTABLE = "private, max-age=31536000, immutable"


# `with connection:` alone commits or rolls back and leaves the handle open, to be
# closed only when the interpreter's cycle collector gets to it (a cursor and its rows
# keep the connection in a cycle); on Python 3.14 the server ran out of file
# descriptors that way. Closing when the block ends keeps one handle per request.
@contextmanager
def _connect(user_id: str) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(user_dir(user_id) / "books.db")
    connection.row_factory = sqlite3.Row
    connection.executescript(_SCHEMA)
    # schema.sql is replayed per connect, but CREATE IF NOT EXISTS never adds a column
    # to an existing table, so a db from before user titles is migrated here (5, D11).
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(books)")}
    if "user_title" not in columns:
        connection.executescript("ALTER TABLE books ADD COLUMN user_title TEXT")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _next_seq(connection: sqlite3.Connection) -> int:
    return connection.execute("SELECT COALESCE(MAX(seq), 0) FROM books").fetchone()[0] + 1


def _book_dir(user_id: str, book_id: str) -> Path:
    return user_dir(user_id) / "books" / book_id


def _record(row: sqlite3.Row) -> dict:
    # The row read back as the book.changed shape (minus pending, which is browser-only):
    # chapters and toc are JSON columns; position is its two columns; cover is a full URL.
    return {
        "id": row["id"],
        # The display title is the user's when set, else the file's (D11); fileTitle is
        # the file's own, so the browser can restore it when a rename is cleared. Only
        # title rides the bus (book.changed); fileTitle stays inside the books fact.
        "title": row["user_title"] if row["user_title"] is not None else row["title"],
        "fileTitle": row["title"],
        "author": row["author"],
        "cover": row["cover"],
        "chapters": json.loads(row["chapters"]),
        "toc": json.loads(row["toc"]),
        "position": {"chapter": row["position_chapter"], "block": row["position_block"]},
        "version": row["version"],
        "contentVersion": row["content_version"],
        "addedAt": row["added_at"],
        "updatedAt": row["updated_at"],
        "deleted": bool(row["deleted"]),
    }


def _reread(connection: sqlite3.Connection, book_id: str) -> dict:
    return _record(connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone())


def reimport(user_id: str, book_id: str) -> dict:
    """Re-run the importer over a book's kept source.epub under the next content version
    (architecture.md 5), so every chapter and image URL changes and the browser's cache
    lapses. Run from the host by deploy/reimport-books.py, not over the bus. The row is
    updated so a pull carries the change and `books` emits book.changed; the reading
    position resets to the chapter start because block indices shift with the new markup.
    Raises on a missing book or an unreadable source, leaving the book untouched."""
    book_dir = _book_dir(user_id, book_id)
    source = book_dir / "source.epub"
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        if row is None or row["deleted"]:
            raise LookupError(f"no live book {book_id}")
        if not source.exists():
            raise FileNotFoundError(f"no source for {book_id}")
        content_version = row["content_version"] + 1

        # Import into a sibling first, so an unreadable source cannot leave the book
        # without its chapters; swap the two directories in only once it has succeeded.
        staging = book_dir / ".reimport"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        try:
            fields = import_book(source, staging, book_id, content_version)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        for name in ("chapters", "images"):
            shutil.rmtree(book_dir / name, ignore_errors=True)
            (staging / name).rename(book_dir / name)
        shutil.rmtree(staging, ignore_errors=True)

        now = int(time.time() * 1000)
        connection.execute(
            "UPDATE books SET title = ?, author = ?, cover = ?, chapters = ?, toc = ?,"
            " content_version = ?, version = version + 1, position_block = 0,"
            " updated_at = ?, seq = ? WHERE id = ?",
            (
                fields["title"],
                fields["author"],
                fields["cover"],
                json.dumps(fields["chapters"]),
                json.dumps(fields["toc"]),
                content_version,
                now,
                _next_seq(connection),
                book_id,
            ),
        )
        return _reread(connection, book_id)


@router.put("/{book_id}")
async def import_epub(book_id: str, request: Request, user_id: str = Depends(require_user)):
    # A second import of an id is idempotent (files first, row last, so a row never
    # points at files that do not exist): drain the body and return the row unchanged.
    with _connect(user_id) as connection:
        existing = connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    if existing is not None:
        async for _ in request.stream():
            pass
        return _record(existing)

    book_dir = _book_dir(user_id, book_id)
    book_dir.mkdir(parents=True, exist_ok=True)
    source = book_dir / "source.epub"
    # Stream the raw body to disk rather than holding 25 MB in RAM (Decision 2).
    with source.open("wb") as out:
        async for chunk in request.stream():
            out.write(chunk)

    try:
        fields = import_book(source, book_dir, book_id, 1)
    except Exception:
        purge(book_dir)
        return JSONResponse({"error": "unreadable"}, status_code=422)

    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        connection.execute(
            "INSERT INTO books (id, title, author, cover, chapters, toc, position_chapter, position_block,"
            " version, content_version, added_at, updated_at, seq, deleted)"
            " VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, 1, ?, ?, ?, 0)",
            (
                book_id,
                fields["title"],
                fields["author"],
                fields["cover"],
                json.dumps(fields["chapters"]),
                json.dumps(fields["toc"]),
                now,
                now,
                _next_seq(connection),
            ),
        )
        return _reread(connection, book_id)


@router.put("/{book_id}/position")
async def set_position(book_id: str, request: Request, user_id: str = Depends(require_user)):
    payload = await request.json()
    chapter = int(payload.get("chapter", 0))
    block = int(payload.get("block", 0))
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404)
        # Last write wins (Decision 4): no base, never a 409. A tombstone keeps its place.
        connection.execute(
            "UPDATE books SET position_chapter = ?, position_block = ?, version = ?, updated_at = ?, seq = ? WHERE id = ?",
            (chapter, block, row["version"] + 1, now, _next_seq(connection), book_id),
        )
        return _reread(connection, book_id)


@router.put("/{book_id}/title")
async def set_title(book_id: str, request: Request, user_id: str = Depends(require_user)):
    # A user title, last write wins (D11): no base, never a 409. It is kept apart from
    # the file's title, which a re-import refreshes without touching this; a trimmed
    # empty string clears it (NULL), so the display title falls back to the file's.
    payload = await request.json()
    user_title = (payload.get("title") or "").strip() or None
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404)
        connection.execute(
            "UPDATE books SET user_title = ?, version = ?, updated_at = ?, seq = ? WHERE id = ?",
            (user_title, row["version"] + 1, now, _next_seq(connection), book_id),
        )
        return _reread(connection, book_id)


@router.put("/{book_id}/deleted")
async def delete_book(book_id: str, user_id: str = Depends(require_user)):
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        row = connection.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        if row is None:
            # Born a tombstone (as notes does), no directory to purge.
            connection.execute(
                "INSERT INTO books (id, title, author, cover, chapters, toc, version, added_at, updated_at, seq, deleted)"
                " VALUES (?, '', '', NULL, '[]', '[]', 1, ?, ?, ?, 1)",
                (book_id, now, now, _next_seq(connection)),
            )
            return _reread(connection, book_id)
        if row["deleted"]:
            return _record(row)  # idempotent
        connection.execute(
            "UPDATE books SET version = ?, updated_at = ?, seq = ?, deleted = 1 WHERE id = ?",
            (row["version"] + 1, now, _next_seq(connection), book_id),
        )
        result = _reread(connection, book_id)
    purge(_book_dir(user_id, book_id))
    return result


@router.put("/{book_id}/opened")
async def set_open(book_id: str, user_id: str = Depends(require_user)):
    # The open book is last write wins and never refused (like a position): the single
    # row is upserted with the server's clock, whatever the book's own version. It is
    # not part of the seq stream, so it never provokes a book.changed on another device.
    now = int(time.time() * 1000)
    with _connect(user_id) as connection:
        connection.execute(
            "INSERT INTO open (one, book_id, at) VALUES (1, ?, ?)"
            " ON CONFLICT(one) DO UPDATE SET book_id = excluded.book_id, at = excluded.at",
            (book_id, now),
        )
    return {"id": book_id, "at": now}


def _open(connection: sqlite3.Connection) -> dict:
    row = connection.execute("SELECT book_id, at FROM open WHERE one = 1").fetchone()
    return {"id": row["book_id"], "at": row["at"]} if row else {"id": None, "at": 0}


@router.get("")
def pull(since: int = 0, user_id: str = Depends(require_user)):
    with _connect(user_id) as connection:
        rows = connection.execute("SELECT * FROM books WHERE seq > ? ORDER BY seq", (since,)).fetchall()
        open_row = _open(connection)
    cursor = rows[-1]["seq"] if rows else since
    return {"books": [_record(row) for row in rows], "cursor": cursor, "open": open_row}


def _content_ok(user_id: str, book_id: str, content_version: int) -> bool:
    with _connect(user_id) as connection:
        row = connection.execute(
            "SELECT deleted, content_version FROM books WHERE id = ?", (book_id,)
        ).fetchone()
    return row is not None and not row["deleted"] and row["content_version"] == content_version


@router.get("/{book_id}/{content_version}/chapters/{index}")
def get_chapter(book_id: str, content_version: int, index: int, user_id: str = Depends(require_user)):
    if not _content_ok(user_id, book_id, content_version):
        raise HTTPException(status_code=404)
    path = _book_dir(user_id, book_id) / "chapters" / f"{index}.html"
    if not path.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(path, media_type="text/html; charset=utf-8", headers={"Cache-Control": _IMMUTABLE})


@router.get("/{book_id}/{content_version}/images/{name}")
def get_image(book_id: str, content_version: int, name: str, user_id: str = Depends(require_user)):
    # The name is validated so no path escapes the images directory (Decision 2).
    if not _NAME.match(name) or not _content_ok(user_id, book_id, content_version):
        raise HTTPException(status_code=404)
    path = _book_dir(user_id, book_id) / "images" / name
    if not path.is_file():
        raise HTTPException(status_code=404)
    media_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": _IMMUTABLE})
