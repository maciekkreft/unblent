-- prompt-sheets' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders writes so a client can pull what changed
-- since its cursor without a clock. deleted marks a tombstone, kept and pulled like a
-- change, never purged. day is set when the row is born and never changes. answers is a
-- JSON array of {prompt, answer, fits}, read and written whole, fits included, so a check
-- rides the sheet's own write and the last write wins.
CREATE TABLE IF NOT EXISTS prompt_sheets (
    id       TEXT PRIMARY KEY,
    day      TEXT NOT NULL,
    set_id   TEXT NOT NULL,
    set_name TEXT NOT NULL,
    based_on TEXT NOT NULL,
    answers  TEXT NOT NULL,
    version  INTEGER NOT NULL,
    seq      INTEGER NOT NULL,
    deleted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS prompt_sheets_seq ON prompt_sheets(seq);
