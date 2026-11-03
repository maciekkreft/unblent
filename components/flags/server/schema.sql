-- The Release of each feature (architecture.md 3.1, 5): one shared file,
-- data/flags.db, one row per feature held back. A feature with no row is released.
CREATE TABLE IF NOT EXISTS off (
    feature TEXT PRIMARY KEY,
    at      INTEGER NOT NULL
);


-- Every feature this file has seen. A feature not in it yet is added the first time the
-- file is opened, and starts held back unless the router lists it as older than this rule.
CREATE TABLE IF NOT EXISTS known (
    feature TEXT PRIMARY KEY
);
