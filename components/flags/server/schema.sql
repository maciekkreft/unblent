-- The Release of each feature (architecture.md 3.1, 5): one shared file,
-- data/flags.db, one row per feature the admin held back. A feature with no row is
-- released.
CREATE TABLE IF NOT EXISTS off (
    feature TEXT PRIMARY KEY,
    at      INTEGER NOT NULL
);

