-- generators' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders writes across both tables so a client can pull
-- what changed since its cursor without a clock. Nothing is deleted. updated_at is the
-- server's time of the last write, in milliseconds, kept for reading the file by hand.
CREATE TABLE IF NOT EXISTS generators (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    "on"       INTEGER NOT NULL,
    model      TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    version    INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS generators_seq ON generators(seq);
CREATE TABLE IF NOT EXISTS results (
    id         TEXT PRIMARY KEY,
    generator  TEXT NOT NULL,
    item       TEXT NOT NULL,
    text       TEXT NOT NULL,
    source     TEXT NOT NULL,
    version    INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS results_seq ON results(seq);
