-- journal's per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders every write, so a client pulls what changed
-- since one cursor without a clock. deleted marks a tombstone: a delete is a write like
-- any other (5), kept and pulled, never purged.
CREATE TABLE IF NOT EXISTS days (
    id        TEXT PRIMARY KEY,
    day       TEXT NOT NULL,
    text      TEXT NOT NULL,
    edited_at INTEGER NOT NULL,
    version   INTEGER NOT NULL,
    seq       INTEGER NOT NULL,
    deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS days_seq ON days(seq);
-- The highest seq of the tables an older file held for the journal's detectors, kept
-- when they were dropped so seq never goes back below it. One row at most.
CREATE TABLE IF NOT EXISTS seq_floor (
    id  INTEGER PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL
);
