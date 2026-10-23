-- The identity registry (architecture.md 5): the one shared database, not one per
-- user, because it defines the users every other database is keyed by.
-- guest marks an account without a passkey (3.4), numbered in the order guests
-- arrive; first_seen and last_seen are milliseconds, and the visitor details are
-- the latest seen. sync is Can sync (3.4): the account may connect a Mac, set by the
-- admin, off by default. registry.py adds these columns to a file from before them.
CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    handle     BLOB NOT NULL,
    label      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    guest      INTEGER NOT NULL DEFAULT 0,
    number     INTEGER,
    first_seen INTEGER,
    last_seen  INTEGER,
    country    TEXT NOT NULL DEFAULT '',
    city       TEXT NOT NULL DEFAULT '',
    browser    TEXT NOT NULL DEFAULT '',
    system     TEXT NOT NULL DEFAULT '',
    device     TEXT NOT NULL DEFAULT 'desk',
    sync       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS credentials (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    public_key BLOB NOT NULL,
    sign_count INTEGER NOT NULL,
    transports TEXT
);
-- One-time connect codes (3.4): the SHA-256 of the code, never the code itself; the
-- PKCE challenge the Mac sent; milliseconds until which the code may be redeemed;
-- and whether a redeem was tried, since a code is good for one try only.
CREATE TABLE IF NOT EXISTS connect_codes (
    code_hash  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    challenge  TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
);
-- Every device sign-in issued (3.4), by the id its token carries, so a connected Mac
-- can later be listed and revoked (14).
CREATE TABLE IF NOT EXISTS devices (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
