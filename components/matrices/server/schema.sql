-- matrices' per-user store on the server (architecture.md 5): one file per user, the router
-- resolving it from the session, so neither schema nor browser names users. tasks is a JSON
-- array of the matrix's tasks, in their order, because it is only ever read and written
-- whole. version is server-assigned; seq orders writes so a client can pull what changed
-- since its cursor without a clock. deleted marks a tombstone, kept and pulled like a
-- change, never purged. day, from_day (the day it was copied from, NULL for none) and
-- created_at are set when the row is born and never change.
CREATE TABLE IF NOT EXISTS matrices (
    id         TEXT PRIMARY KEY,
    day        TEXT NOT NULL,
    from_day   TEXT,
    tasks      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    version    INTEGER NOT NULL,
    seq        INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS matrices_seq ON matrices(seq);
