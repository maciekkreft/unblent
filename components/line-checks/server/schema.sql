-- line-checks' per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session, so neither schema nor browser names users. An
-- answer is added once under its key and never changed. seq orders the writes, so a
-- client pulls what changed since its cursor without a clock.
CREATE TABLE IF NOT EXISTS answers (
    key     TEXT PRIMARY KEY,
    answers TEXT NOT NULL,
    seq     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS answers_seq ON answers(seq);
