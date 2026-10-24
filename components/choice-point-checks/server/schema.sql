-- choice-point-checks' per-user store on the server (architecture.md 5): one file per
-- user, the router resolving it from the session, so neither schema nor browser names
-- users. A box's settings are one row, the last write wins, and version is
-- server-assigned. An answer is added once under its key and never changed. seq orders
-- writes across both tables, so a client pulls what changed since its cursor without a
-- clock.
CREATE TABLE IF NOT EXISTS boxes (
    field     TEXT PRIMARY KEY,
    evaluator TEXT,
    questions TEXT NOT NULL,
    also      TEXT,
    version   INTEGER NOT NULL,
    seq       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS boxes_seq ON boxes(seq);
CREATE TABLE IF NOT EXISTS answers (
    key     TEXT PRIMARY KEY,
    answers TEXT NOT NULL,
    seq     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS answers_seq ON answers(seq);
