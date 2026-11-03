-- usage's per-user store on the server (architecture.md 5): one file per user, the
-- router resolving it from the session. One row per device, day and feature holds that
-- device's running total in milliseconds; the last write wins, so a row is replaced
-- whole and needs no version.
CREATE TABLE IF NOT EXISTS totals (
    id      TEXT PRIMARY KEY,
    device  TEXT NOT NULL,
    day     TEXT NOT NULL,
    feature TEXT NOT NULL,
    ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS totals_day ON totals(day);
