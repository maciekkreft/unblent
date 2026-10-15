-- evaluators' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders writes so a client can pull what changed
-- since its cursor without a clock. deleted marks a tombstone, kept and pulled like a
-- change, never purged. questions is the evaluator's questions as a JSON array. book is
-- set when the row is born and never changes. journal is "Show in journal"; the router
-- adds it to a file made before it. updated_at is when the content last changed (ISO
-- time), NULL on a row written before it was kept; the router adds it the same way.
CREATE TABLE IF NOT EXISTS evaluators (
    id        TEXT PRIMARY KEY,
    book      TEXT NOT NULL,
    name      TEXT NOT NULL,
    "on"      INTEGER NOT NULL,
    journal   INTEGER NOT NULL DEFAULT 0,
    questions TEXT NOT NULL,
    version   INTEGER NOT NULL,
    seq       INTEGER NOT NULL,
    deleted   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS evaluators_seq ON evaluators(seq);
