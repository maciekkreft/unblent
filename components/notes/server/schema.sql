-- notes' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders writes so a client can pull what changed
-- since its cursor without a clock. deleted marks a tombstone: a delete is a write
-- like any other (5), so the row stays, versioned and pulled like a change, and a
-- pulling device learns of the deletion; it is never purged.
-- about holds the note's links (12) as a JSON array, [] when none; a delete keeps it.
-- position is the note's place in the list (5), a key the browser computes; last write
-- wins, so setting it bumps seq but never version. NULL for a note from before places,
-- which the browser orders by updated_at, newest first, until it is edited or moved.
CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    about      TEXT NOT NULL DEFAULT '[]',
    position   TEXT
);
CREATE INDEX IF NOT EXISTS notes_seq ON notes(seq);
