-- The Release of each feature (architecture.md 3.1, 5): one shared file,
-- data/flags.db, one row per feature the admin held back. A feature with no row is
-- released, unless it starts off (turned_on below).
CREATE TABLE IF NOT EXISTS off (
    feature TEXT PRIMARY KEY,
    at      INTEGER NOT NULL
);


-- The features that start off (router.py: STARTS_OFF), one row per feature the admin
-- released. A feature that starts off with no row is not released.
CREATE TABLE IF NOT EXISTS turned_on (
    feature TEXT PRIMARY KEY,
    at      INTEGER NOT NULL
);
