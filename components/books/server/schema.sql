-- books' per-user store on the server (architecture.md 5, Decision 2): one file per
-- user, the router resolving it from the session. The row holds only what rides the
-- bus and what must be versioned; the chapters and images are files on disk under
-- books/<id>/ (Decision 2), so this table stays a few KB per book. version is
-- server-assigned; seq orders writes for the pull cursor. content_version names the
-- immutable URL prefix the files are served under, bumped on re-import. deleted marks
-- a tombstone: a delete is a write like any other (5), the row stays and is pulled,
-- and the directory is purged; a position is last write wins and never refused (4).
CREATE TABLE IF NOT EXISTS books (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    author           TEXT NOT NULL,
    cover            TEXT,
    chapters         TEXT NOT NULL,   -- JSON: [{ title }] in spine order
    toc              TEXT NOT NULL,   -- JSON: [{ title, chapter, block, children }]
    position_chapter INTEGER NOT NULL DEFAULT 0,
    position_block   INTEGER NOT NULL DEFAULT 0,
    version          INTEGER NOT NULL,
    content_version  INTEGER NOT NULL DEFAULT 1,
    added_at         INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    seq              INTEGER NOT NULL,
    deleted          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS books_seq ON books(seq);

-- Which book this user is reading (architecture.md 5): one row, last write wins and
-- never refused, so it carries no version and no seq. The pull returns it beside the
-- rows, so a reload or another device opens what was being read. book_id may be null
-- (nothing open); at is the server's clock, the only thing compared across devices.
CREATE TABLE IF NOT EXISTS open (
    one     INTEGER PRIMARY KEY CHECK (one = 1),
    book_id TEXT,
    at      INTEGER NOT NULL
);
