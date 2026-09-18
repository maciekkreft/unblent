import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module is the far end of the same component (section 3), tested from
// here against the live check server. Every route needs a signed-in user (5), so
// the test forges the session cookie the server would set — an HMAC over the user
// id under SESSION_SECRET, which checks/check.py passes into the test env — rather
// than running a passkey ceremony. Each test uses its own user id, hence its own
// per-user database (5), so the tests never see each other's notes.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshUser = () => `notes-test-${Date.now()}-${counter++}`;
const noteId = (n) => `01TEST${String(n).padStart(20, "0")}`;

const put = (id, body, cookie) =>
  fetch(`${BASE_URL}/api/notes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const list = (since, cookie) =>
  fetch(`${BASE_URL}/api/notes?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user (401 without a cookie)", async () => {
  assert.equal((await put(noteId(1), { title: "a", body: "b", baseVersion: null })).status, 401);
  assert.equal((await list(0)).status, 401);
});

test("a create is version 1 and an update continues from the held version", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  const created = await (await put(id, { title: "a", body: "b", baseVersion: null }, cookie)).json();
  assert.equal(created.version, 1);
  const updated = await (await put(id, { title: "a2", body: "b2", baseVersion: 1 }, cookie)).json();
  assert.equal(updated.version, 2);
  assert.equal(updated.title, "a2");
});

test("a write on a stale base is a 409 carrying the server's copy", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  await put(id, { title: "a", body: "b", baseVersion: null }, cookie);
  await put(id, { title: "a2", body: "b2", baseVersion: 1 }, cookie);
  const res = await put(id, { title: "x", body: "y", baseVersion: 1 }, cookie);
  assert.equal(res.status, 409);
  const { note } = await res.json();
  assert.equal(note.version, 2);
  assert.equal(note.title, "a2");
});

test("the same text on the right base is idempotent: same version, no rewrite", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  const first = await (await put(id, { title: "a", body: "b", baseVersion: null }, cookie)).json();
  const again = await (await put(id, { title: "a", body: "b", baseVersion: 1 }, cookie)).json();
  assert.equal(again.version, 1);
  assert.equal(again.updatedAt, first.updatedAt, "no new write, so the timestamp is unchanged");
});

test("GET since a cursor returns only what changed after it", async () => {
  const cookie = cookieFor(freshUser());
  await put(noteId(1), { title: "one", body: "1", baseVersion: null }, cookie);
  await put(noteId(2), { title: "two", body: "2", baseVersion: null }, cookie);
  const all = await (await list(0, cookie)).json();
  assert.equal(all.notes.length, 2);
  assert.ok(all.cursor >= 2);
  const after = await (await list(all.cursor, cookie)).json();
  assert.deepEqual(after.notes, []);
  assert.equal(after.cursor, all.cursor);
});

test("a delete is a versioned write that states no base, and the pull carries it", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  await put(id, { title: "a", body: "b", baseVersion: null }, cookie);
  // No baseVersion, yet accepted: a delete always wins (5).
  const gone = await (await put(id, { title: "a", body: "b", deleted: true }, cookie)).json();
  assert.equal(gone.version, 2);
  assert.equal(gone.deleted, true);
  const all = await (await list(0, cookie)).json();
  const row = all.notes.find((n) => n.id === id);
  assert.equal(row.deleted, true, "the tombstone rides the pull like any change");
});

test("a second delete is idempotent: same version, no new write", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  await put(id, { title: "a", body: "b", baseVersion: null }, cookie);
  const first = await (await put(id, { title: "a", body: "b", deleted: true }, cookie)).json();
  const again = await (await put(id, { title: "a", body: "b", deleted: true }, cookie)).json();
  assert.equal(again.version, first.version);
  assert.equal(again.updatedAt, first.updatedAt);
});

test("an edit onto a tombstone loses: a 409 carrying the deleted record", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  await put(id, { title: "a", body: "b", baseVersion: null }, cookie);
  await put(id, { title: "a", body: "b", deleted: true }, cookie);
  const res = await put(id, { title: "revive", body: "me", baseVersion: 1 }, cookie);
  assert.equal(res.status, 409);
  const { note } = await res.json();
  assert.equal(note.deleted, true);
});

test("a delete for an unknown id is born a tombstone at version 1", async () => {
  const cookie = cookieFor(freshUser());
  const born = await (await put(noteId(9), { title: "a", body: "b", deleted: true }, cookie)).json();
  assert.equal(born.version, 1);
  assert.equal(born.deleted, true);
});

// --- Note links (about, slice 2) --------------------------------------------------

test("about rides the create and the pull; a note without about is []", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  const created = await (await put(id, { title: "a", body: "b", baseVersion: null, about: [{ kind: "book", id: "b1" }] }, cookie)).json();
  assert.deepEqual(created.about, [{ kind: "book", id: "b1" }]);
  const plain = await (await put(noteId(2), { title: "c", body: "d", baseVersion: null }, cookie)).json();
  assert.deepEqual(plain.about, [], "a note created without about is []");
  const all = await (await list(0, cookie)).json();
  assert.deepEqual(all.notes.find((n) => n.id === id).about, [{ kind: "book", id: "b1" }]);
});

test("about absent leaves the links; present replaces them, empty clears them", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  await put(id, { title: "a", body: "b", baseVersion: null, about: [{ kind: "book", id: "b1" }] }, cookie);
  const kept = await (await put(id, { title: "a2", body: "b2", baseVersion: 1 }, cookie)).json();
  assert.deepEqual(kept.about, [{ kind: "book", id: "b1" }], "an edit without about keeps the link");
  const relinked = await (await put(id, { title: "a3", body: "b3", baseVersion: 2, about: [{ kind: "book", id: "b2" }] }, cookie)).json();
  assert.deepEqual(relinked.about, [{ kind: "book", id: "b2" }], "about present replaces the links");
  const cleared = await (await put(id, { title: "a4", body: "b4", baseVersion: 3, about: [] }, cookie)).json();
  assert.deepEqual(cleared.about, [], "an empty list clears the links");
});

test("changing only the links is a change: a new version; the same links is idempotent", async () => {
  const cookie = cookieFor(freshUser());
  const id = noteId(1);
  const created = await (await put(id, { title: "a", body: "b", baseVersion: null }, cookie)).json();
  assert.equal(created.version, 1);
  const linked = await (await put(id, { title: "a", body: "b", baseVersion: 1, about: [{ kind: "book", id: "b1" }] }, cookie)).json();
  assert.equal(linked.version, 2, "same text, a new link, still a change");
  const again = await (await put(id, { title: "a", body: "b", baseVersion: 2, about: [{ kind: "book", id: "b1" }] }, cookie)).json();
  assert.equal(again.version, 2, "same text and same links is not a change");
});

test("a database file from before links gains the about column, defaulting to []", async () => {
  // node:sqlite is experimental; hush the one-time warning so the run stays clean.
  const saved = process.emitWarning;
  process.emitWarning = () => {};
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const { join } = await import("node:path");
    const { mkdirSync } = await import("node:fs");
    const user = freshUser();
    const dir = join(process.env.UNBLENT_DATA, user);
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "notes.db"));
    // The pre-links schema: notes without an about column.
    db.exec(
      "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, " +
        "version INTEGER NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);",
    );
    db.exec(`INSERT INTO notes (id, title, body, version, updated_at, seq, deleted) VALUES ('${noteId(1)}', 'old', 'body', 1, 5, 1, 0);`);
    db.close();
    const cookie = cookieFor(user);
    const all = await (await list(0, cookie)).json();
    assert.deepEqual(all.notes.find((n) => n.id === noteId(1)).about, [], "the migrated row reads as []");
    const updated = await (await put(noteId(1), { title: "old2", body: "body2", baseVersion: 1, about: [{ kind: "book", id: "b1" }] }, cookie)).json();
    assert.deepEqual(updated.about, [{ kind: "book", id: "b1" }], "the migrated db can now store links");
  } finally {
    process.emitWarning = saved;
  }
});
