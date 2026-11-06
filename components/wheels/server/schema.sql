-- wheels' per-user store on the server (architecture.md 5): one file per user, the router
-- resolving it from the session, so neither schema nor browser names users. actual and
-- wanted are JSON arrays of eight scores, because they are only ever read and written
-- whole. version is server-assigned; seq orders writes so a client can pull what changed
-- since its cursor without a clock. deleted marks a tombstone, kept and pulled like a
-- change, never purged. day is set when the row is born and never changes.
CREATE TABLE IF NOT EXISTS wheels (
    id      TEXT PRIMARY KEY,
    day     TEXT NOT NULL,
    actual  TEXT NOT NULL,
    wanted  TEXT NOT NULL,
    version INTEGER NOT NULL,
    seq     INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS wheels_seq ON wheels(seq);
