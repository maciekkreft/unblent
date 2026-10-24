-- values' per-user store on the server (architecture.md 5): one file per user, the router
-- resolving it from the session, so neither schema nor browser names users. One row per
-- day's version, keyed by the day; list holds the values as JSON, in the client's order.
-- version is server-assigned; seq orders writes so a client can pull what changed since
-- its cursor without a clock. Nothing is deleted.
CREATE TABLE IF NOT EXISTS versions (
    day     TEXT PRIMARY KEY,
    list    TEXT NOT NULL,
    version INTEGER NOT NULL,
    seq     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_seq ON versions(seq);
