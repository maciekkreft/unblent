-- prompt-sets' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders writes so a client can pull what changed
-- since its cursor without a clock. deleted marks a tombstone, kept and pulled like a
-- change, never purged. prompts is a JSON array of strings, in the order they are asked.
CREATE TABLE IF NOT EXISTS prompt_sets (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    occasion  TEXT NOT NULL,
    based_on  TEXT NOT NULL,
    prompts   TEXT NOT NULL,
    position  TEXT NOT NULL,
    version   INTEGER NOT NULL,
    seq       INTEGER NOT NULL,
    deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS prompt_sets_seq ON prompt_sets(seq);
