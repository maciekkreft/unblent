-- The shared copy of the admin's starters (architecture.md 5): one row per try page and
-- ticked evaluator, rewritten whole whenever the admin saves an evaluator, and read by
-- any visitor of that try page (8). page is the try page's name, such as "evaluators";
-- questions is the evaluator's questions as a JSON array; owner is the admin's id;
-- description is what it checks, which the router adds to a file made before it.
CREATE TABLE IF NOT EXISTS starters (
    owner     TEXT NOT NULL,
    page      TEXT NOT NULL,
    id        TEXT NOT NULL,
    name      TEXT NOT NULL,
    questions TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (owner, page, id)
);
