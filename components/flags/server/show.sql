-- Which features one account turned Show off for (architecture.md 3.1, 5): the
-- account's own data/<user>/flags.db, one row per feature it hides from itself. A
-- feature with no row is shown.
CREATE TABLE IF NOT EXISTS hidden (
    feature TEXT PRIMARY KEY,
    at      INTEGER NOT NULL
);
