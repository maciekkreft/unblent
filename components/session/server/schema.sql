-- The identity registry (architecture.md 5): the one shared database, not one per
-- user, because it defines the users every other database is keyed by.
CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    handle     BLOB NOT NULL,
    label      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL,
    transports TEXT
);
