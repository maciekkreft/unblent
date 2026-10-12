-- llm's per-user store on the server (architecture.md 5, 7.7): one file per user,
-- the router resolving it from the session, so neither schema nor browser names
-- users. settings is the single row of account preferences that ride the read
-- picture; keys holds one encrypted API key per provider, never sent to the
-- browser (7.7). The key is stored as Fernet ciphertext, so the file at rest and
-- its Litestream copy never hold a readable key.
CREATE TABLE IF NOT EXISTS settings (
    one      INTEGER PRIMARY KEY CHECK (one = 1),
    provider TEXT NOT NULL,
    model    TEXT NOT NULL,
    effort   TEXT NOT NULL,
    ttl      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS keys (
    provider TEXT PRIMARY KEY,
    cipher   TEXT NOT NULL,
    at       INTEGER NOT NULL
);
-- starter: the owner's keys a new account may use for its first requests (architecture
-- 12, "Starter keys"). It names the .env entry the key comes from and counts the
-- requests made; the key itself is read from the environment at use, so it never
-- reaches this file or its backup.
CREATE TABLE IF NOT EXISTS starter (
    provider TEXT PRIMARY KEY,
    env      TEXT NOT NULL,
    used     INTEGER NOT NULL
);
