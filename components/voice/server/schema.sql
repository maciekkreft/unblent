-- voice's per-user store on the website (architecture.md 5, 7.7): the voice the account
-- picked, and its own Inworld key as Fernet ciphertext, never sent to the browser. On a
-- Mac nothing is kept here: the voice picked is in DATA/voice.json.
CREATE TABLE IF NOT EXISTS settings (
    one   INTEGER PRIMARY KEY CHECK (one = 1),
    voice TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS keys (
    provider TEXT PRIMARY KEY,
    cipher   TEXT NOT NULL,
    at       INTEGER NOT NULL
);
-- A key change is a step (12, Undo): the key from before and the key after it, both
-- still ciphertext and NULL for none, kept under the step's id until the step leaves the
-- undo list, so Undo and Redo bring a key back without it entering the browser (7.7).
CREATE TABLE IF NOT EXISTS key_steps (
    step          TEXT NOT NULL,
    provider      TEXT NOT NULL,
    before_cipher TEXT,
    before_at     INTEGER,
    after_cipher  TEXT,
    after_at      INTEGER,
    PRIMARY KEY (step, provider)
);
