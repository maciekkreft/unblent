-- conversations' per-user store on the server (architecture.md 5): one file per user,
-- the router resolving it from the session, so the per-user isolation of section 5
-- holds by construction. A chat is remote-only (3.1): every turn needs the model, so
-- nothing is written offline and the server is the single copy. A finished turn never
-- changes, so a turn is added by id and never rewritten; the chat row (title, links,
-- start) and a delete are last write wins.
CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    about      TEXT NOT NULL,   -- JSON: [{ kind, id }], what the chat is linked to (12)
    start      TEXT NOT NULL,   -- the instructions the chat began with, written once (12)
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at);

-- One row per turn, added by id and never rewritten (5). body is the whole turn as
-- JSON, including a tool result's content, which the browser drops before the bus (4.3)
-- but the server keeps so a request can be rebuilt. Turns are ordered by id everywhere.
CREATE TABLE IF NOT EXISTS turns (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    body            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS turns_conversation ON turns(conversation_id);

-- The account's tool preferences (7.7): which lookups are on and whether they are
-- approved by hand or automatically. One row, last write wins.
CREATE TABLE IF NOT EXISTS tools (
    one  INTEGER PRIMARY KEY CHECK (one = 1),
    body TEXT NOT NULL,
    at   INTEGER NOT NULL
);
