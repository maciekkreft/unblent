-- What guests spend (architecture.md 5, 7.7): one shared file, data/llm.db, because
-- the limit for all guests adds up many accounts. guest_keys holds one encrypted key
-- per provider, Fernet ciphertext like an account's own keys, never sent to the
-- browser. limits holds the dollar limits by name ('guest', 'allGuests', and
-- 'provider:<id>' for a provider's own limit; no row for a provider means none).
-- spent is each guest's running total per provider since the start, in dollars.
-- blocked lists the guests the admin blocked. before_reset keeps a guest's totals from
-- before the admin's last Reset use, so Undo can bring them back.
CREATE TABLE IF NOT EXISTS guest_keys (
    provider TEXT PRIMARY KEY,
    cipher   TEXT NOT NULL,
    at       INTEGER NOT NULL
);
-- A guest key change is a step (12, Undo), kept as key_steps is in each account's file.
CREATE TABLE IF NOT EXISTS guest_key_steps (
    step          TEXT NOT NULL,
    provider      TEXT NOT NULL,
    before_cipher TEXT,
    before_at     INTEGER,
    after_cipher  TEXT,
    after_at      INTEGER,
    PRIMARY KEY (step, provider)
);
CREATE TABLE IF NOT EXISTS limits (
    name    TEXT PRIMARY KEY,
    dollars REAL NOT NULL
);
INSERT OR IGNORE INTO limits (name, dollars) VALUES ('guest', 1.0), ('allGuests', 10.0);
CREATE TABLE IF NOT EXISTS spent (
    user_id  TEXT NOT NULL,
    provider TEXT NOT NULL,
    dollars  REAL NOT NULL,
    PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS blocked (
    user_id TEXT PRIMARY KEY,
    at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS before_reset (
    user_id  TEXT NOT NULL,
    provider TEXT NOT NULL,
    dollars  REAL NOT NULL,
    PRIMARY KEY (user_id, provider)
);
