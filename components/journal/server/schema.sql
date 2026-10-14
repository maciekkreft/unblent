-- journal's per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users.
-- version is server-assigned; seq orders every write across the four tables, so a
-- client pulls what changed since one cursor without a clock. deleted marks a
-- tombstone: a delete is a write like any other (5), kept and pulled, never purged.
CREATE TABLE IF NOT EXISTS days (
    id        TEXT PRIMARY KEY,
    day       TEXT NOT NULL,
    text      TEXT NOT NULL,
    edited_at INTEGER NOT NULL,
    version   INTEGER NOT NULL,
    seq       INTEGER NOT NULL,
    deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS days_seq ON days(seq);

CREATE TABLE IF NOT EXISTS projects (
    id      TEXT PRIMARY KEY,
    name    TEXT NOT NULL,
    "on"    INTEGER NOT NULL,
    version INTEGER NOT NULL,
    seq     INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS projects_seq ON projects(seq);

-- questions is the detector's questions as a JSON array.
CREATE TABLE IF NOT EXISTS detectors (
    id        TEXT PRIMARY KEY,
    project   TEXT NOT NULL,
    name      TEXT NOT NULL,
    "on"      INTEGER NOT NULL,
    questions TEXT NOT NULL,
    version   INTEGER NOT NULL,
    seq       INTEGER NOT NULL,
    deleted   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS detectors_seq ON detectors(seq);

-- An answer is kept by its question's id and its paragraph's text, as the browser
-- keeps it; wording and answer are JSON objects.
CREATE TABLE IF NOT EXISTS answers (
    question TEXT NOT NULL,
    text     TEXT NOT NULL,
    wording  TEXT NOT NULL,
    answer   TEXT NOT NULL,
    at       INTEGER NOT NULL,
    version  INTEGER NOT NULL,
    seq      INTEGER NOT NULL,
    deleted  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (question, text)
);
CREATE INDEX IF NOT EXISTS answers_seq ON answers(seq);
