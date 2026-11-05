-- experts' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- id is the book's id. version is server-assigned; seq orders writes so a client can
-- pull what changed since its cursor without a clock. Nothing is deleted. updated_at is
-- the server's time of the last write, in milliseconds, kept for reading the file by hand.
CREATE TABLE IF NOT EXISTS experts (
    id         TEXT PRIMARY KEY,
    prompt     TEXT NOT NULL,
    "on"       INTEGER NOT NULL,
    version    INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS experts_seq ON experts(seq);
