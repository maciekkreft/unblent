-- notes' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders writes so a client can pull what changed
-- since its cursor without a clock.
CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    seq        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_seq ON notes(seq);
