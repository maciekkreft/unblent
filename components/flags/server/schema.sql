-- Which features are off for everyone except the admin (architecture.md 3.1, 5): one
-- shared file, data/flags.db, one row per feature turned off. A feature with no row
-- is on.
CREATE TABLE IF NOT EXISTS off (
    feature TEXT PRIMARY KEY,
    at      INTEGER NOT NULL
);
