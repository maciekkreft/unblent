import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own evaluators.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshUser = () => `evaluators-test-${Date.now()}-${counter++}`;
const freshCookie = () => cookieFor(freshUser());

const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const QUESTION = { id: "01ARZ3NDEKTSV4RRFFQ69G5QQ1", kind: "yesno", text: "Is this a goal?", yes: "", no: "", options: [] };

const body = (over = {}) => ({ book: BOOK, name: "Goals", on: true, questions: [QUESTION], baseVersion: null, deleted: false, ...over });
const put = (id, payload, cookie) =>
  fetch(`${BASE_URL}/api/evaluators/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/evaluators?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(ID, body())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a create continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(ID, body({ baseVersion: 3 }), cookie)).json();
  const { updatedAt, ...rest } = created;
  assert.deepEqual(rest, { id: ID, book: BOOK, name: "Goals", on: true, journal: false, questions: [QUESTION], version: 4, deleted: false, position: null });
  assert.ok(!Number.isNaN(Date.parse(updatedAt)), "a write without a time is stamped by the server");
  // Last write wins: a stale base is never refused.
  const res = await put(ID, body({ name: "Renamed", on: false, baseVersion: 1 }), cookie);
  assert.equal(res.status, 200);
  assert.deepEqual([(await res.json()).version], [5]);
  const again = await (await put(ID, body({ name: "Renamed", on: false, baseVersion: 1 }), cookie)).json();
  assert.equal(again.version, 5, "the same content is not a new version");
});

test("a place is saved without a new version, alone or with a write, and pulled like a change", async () => {
  const cookie = freshCookie();
  assert.deepEqual(await (await put(ID, { position: "V", deleted: false }, cookie)).json(), { id: ID, missing: true }, "nothing to move");
  await put(ID, body(), cookie);
  const moved = await (await put(ID, { position: "V", deleted: false }, cookie)).json();
  assert.deepEqual([moved.position, moved.version, moved.name], ["V", 1, "Goals"]);
  const both = await (await put(ID, body({ name: "Renamed", position: "F" }), cookie)).json();
  assert.deepEqual([both.position, both.version], ["F", 2]);
  const kept = await (await put(ID, body({ name: "Again" }), cookie)).json();
  assert.equal(kept.position, "F", "a write without a place keeps it");
  assert.equal((await put(ID, { position: "0", deleted: false }, cookie)).status, 400, "a key never ends in 0");
  const before = (await (await pull(0, cookie)).json()).cursor;
  await put(ID, { position: "a", deleted: false }, cookie);
  const after = await (await pull(before, cookie)).json();
  assert.deepEqual(after.evaluators.map((e) => [e.position, e.version]), [["a", 3]]);
});

test("an evaluator ticked Show in journal moves to the journal, pulled as a change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  await put(ID, body({ journal: true }), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.evaluators.map((e) => [e.book, e.journal, e.version]), [["00000000000000000000000JRN", false, 3]]);
  const again = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(again.evaluators, [], "it moves once");
});

test("the browser's time of a change is kept, and a resend of the same content keeps the first", async () => {
  const cookie = freshCookie();
  const first = await (await put(ID, body({ updatedAt: "2026-01-02T03:04:05.006Z" }), cookie)).json();
  assert.equal(first.updatedAt, "2026-01-02T03:04:05.006Z");
  const same = await (await put(ID, body({ updatedAt: "2026-02-02T00:00:00.000Z" }), cookie)).json();
  assert.equal(same.updatedAt, "2026-01-02T03:04:05.006Z");
  const edited = await (await put(ID, body({ name: "Renamed", updatedAt: "2026-02-02T00:00:00.000Z" }), cookie)).json();
  assert.equal(edited.updatedAt, "2026-02-02T00:00:00.000Z");
});

test("a file from before updatedAt gains the column, its rows null", async () => {
  const user = freshUser();
  const dir = join(process.env.UNBLENT_DATA, user);
  execFileSync("python3", [
    "-c",
    "import os, sqlite3, sys; os.makedirs(sys.argv[1], exist_ok=True); c = sqlite3.connect(os.path.join(sys.argv[1], 'evaluators.db'));" +
      " c.executescript('CREATE TABLE evaluators (id TEXT PRIMARY KEY, book TEXT NOT NULL, name TEXT NOT NULL, \"on\" INTEGER NOT NULL, journal INTEGER NOT NULL DEFAULT 0, questions TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);');" +
      " c.execute('INSERT INTO evaluators VALUES (?, ?, ?, 1, 0, ?, 1, 1, 0)', (sys.argv[2], sys.argv[3], 'Old', '[]')); c.commit()",
    dir,
    ID,
    BOOK,
  ]);
  const all = await (await pull(0, cookieFor(user))).json();
  assert.deepEqual(all.evaluators.map((e) => [e.name, e.updatedAt]), [["Old", null]]);
});

test("a book is set when the evaluator is born and never changes", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  const moved = await (await put(ID, body({ book: "01ARZ3NDEKTSV4RRFFQ69G5BK2", name: "Moved" }), cookie)).json();
  assert.deepEqual([moved.book, moved.name], [BOOK, "Moved"]);
});

test("a delete is a tombstone that always wins and is pulled like a change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  await put(ID2, body({ name: "Other" }), cookie);
  const gone = await (await put(ID, body({ deleted: true, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([gone.deleted, gone.version], [true, 2]);
  const late = await (await put(ID, body({ name: "Revived" }), cookie)).json();
  assert.deepEqual([late.deleted, late.name, late.version], [true, "Goals", 2], "a write onto a tombstone returns it");
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.evaluators.map((e) => [e.id, e.deleted]), [[ID2, false], [ID, true]]);
  const later = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(later, { evaluators: [], cursor: all.cursor });
});

test("a body that is not an evaluator is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  for (const bad of [body({ on: "yes" }), body({ book: "nope" }), body({ questions: ["x"] }), body({ baseVersion: true }), body({ journal: "yes" }), body({ updatedAt: "yesterday" })]) {
    const res = await put(ID, bad, cookie);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await put("not-an-id", body(), cookie)).status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's evaluators", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(ID, body(), a);
  assert.deepEqual((await (await pull(0, b)).json()).evaluators, []);
});

// Starters (5, 8): each test ticks for a page of its own, so the shared file's other rows
// never meet it.
const starters = (page) => fetch(`${BASE_URL}/api/evaluators/starters/${page}`);
const freshPage = () => `api-${Date.now()}-${counter++}`;

test("the admin's ticked evaluators are copied to the shared file, which anyone can read", async () => {
  const admin = cookieFor(`${freshUser()}|admin`);
  const page = freshPage();
  const ticked = await (await put(ID, body({ starterFor: [page, page] }), admin)).json();
  assert.deepEqual([ticked.starterFor, ticked.version], [[page], 1]);
  await put(ID2, body({ name: "Not ticked" }), admin);
  const res = await starters(page);
  assert.equal(res.status, 200, "no account is needed");
  assert.deepEqual(await res.json(), { evaluators: [{ name: "Goals", questions: [QUESTION] }] });

  // A save the admin makes reaches the copy; a save leaving starterFor out keeps the tick.
  await put(ID, body({ name: "Clear goal" }), admin);
  assert.deepEqual((await (await starters(page)).json()).evaluators.map((e) => e.name), ["Clear goal"]);
  // Unticking, or deleting, takes it out.
  const off = await (await put(ID, body({ name: "Clear goal", starterFor: [] }), admin)).json();
  assert.equal("starterFor" in off, false, "an evaluator that is a starter for nothing does not carry it");
  assert.deepEqual((await (await starters(page)).json()).evaluators, []);
  await put(ID2, body({ name: "Not ticked", starterFor: [page] }), admin);
  assert.equal((await (await starters(page)).json()).evaluators.length, 1);
  await put(ID2, body({ deleted: true }), admin);
  assert.deepEqual((await (await starters(page)).json()).evaluators, []);
});

test("only the admin's evaluators are starters", async () => {
  const cookie = freshCookie();
  const page = freshPage();
  const saved = await (await put(ID, body({ starterFor: [page] }), cookie)).json();
  assert.equal("starterFor" in saved, false);
  assert.deepEqual((await (await starters(page)).json()).evaluators, []);
  const bad = await put(ID, body({ starterFor: "evaluators" }), cookie);
  assert.equal(bad.status, 400);
});
