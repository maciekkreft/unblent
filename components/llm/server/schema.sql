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
    ttl      TEXT NOT NULL,
    -- Ollama's address on the user's Mac (3.4); NULL is the default, localhost:11434.
    address  TEXT
);
CREATE TABLE IF NOT EXISTS keys (
    provider TEXT PRIMARY KEY,
    cipher   TEXT NOT NULL,
    at       INTEGER NOT NULL
);
-- An account uses only its own keys (7.7); older files may still hold a starter table.
DROP TABLE IF EXISTS starter;
