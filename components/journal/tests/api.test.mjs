import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// The server module is the far end of the same component (section 3), tested from here
// against the check's throwaway server. Every route needs a signed-in user (5), so the
// test forges the session cookie the server would set, an HMAC over the user id under
// SESSION_SECRET, rather than running a passkey ceremony. Each test uses its own user,
// hence its own per-user database (5), so the tests never see each other's journal.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const newUser = () => `journal-test-${Date.now()}-${counter++}`;
const signIn = () => cookieFor(newUser());

const D1 = "01K7TEST00000000000000DA01";
const P1 = "01K7TEST00000000000000PR01";

const put = (kind, payload, cookie) =>
  fetch(`${BASE_URL}/api/journal/${kind}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/journal?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

const day = (text, editedAt = 1000) => ({ id: D1, day: "2026-10-12", text, editedAt });

test("every route needs a signed-in user (401 without a cookie)", async () => {
  assert.equal((await put("days", { record: day("a"), baseVersion: null })).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a body the route does not take is a fixed 400 that never echoes it", async () => {
  const cookie = signIn();
  const secretish = "do-not-echo-me";
  for (const [kind, payload] of [
    ["days", `{"record": "${secretish}"`],
    ["days", { record: { ...day("a"), id: secretish }, baseVersion: null }],
    ["days", { record: day("a"), baseVersion: secretish }],
    ["projects", { record: { id: P1, name: secretish, on: true } }],
    ["detectors", { record: { id: P1, name: secretish, on: true } }],
    ["answers", { record: { text: secretish } }],
  ]) {
    const res = await put(kind, payload, cookie);
    assert.equal(res.status, 400, `${kind} ${JSON.stringify(payload)}`);
    const text = await res.text();
    assert.equal(text, '{"error":"bad-request"}');
  }
  assert.equal((await pull(secretish, cookie)).status, 400);
});

test("a new record continues from the version it was sent on, so a signed-out history carries over", async () => {
  const cookie = signIn();
  const fresh = await (await put("days", { record: day("a"), baseVersion: null }, cookie)).json();
  assert.equal(fresh.record.version, 1);
  const D2 = "01K7TEST00000000000000DA02";
  const adopted = await (await put("days", { record: { ...day("b"), id: D2 }, baseVersion: 4 }, cookie)).json();
  assert.deepEqual(adopted.record, { ...day("b"), id: D2, version: 5, deleted: false });
});

test("a day on its current version is the next version; on a stale one it is a 409 carrying the server's copy", async () => {
  const cookie = signIn();
  await put("days", { record: day("Morning"), baseVersion: null }, cookie);
  const next = await (await put("days", { record: day("Morning\nPhone", 2000), baseVersion: 1 }, cookie)).json();
  assert.equal(next.record.version, 2);
  const res = await put("days", { record: day("Morning\nLaptop", 3000), baseVersion: 1 }, cookie);
  assert.equal(res.status, 409);
  const { record } = await res.json();
  assert.deepEqual(record, { ...day("Morning\nPhone", 2000), version: 2, deleted: false });
});

test("a resend of a write already applied is idempotent, not a conflict", async () => {
  const cookie = signIn();
  await put("days", { record: day("a"), baseVersion: null }, cookie);
  await put("days", { record: day("ab", 2000), baseVersion: 1 }, cookie);
  const again = await put("days", { record: day("ab", 2000), baseVersion: 1 }, cookie);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).record.version, 2, "no new version");
});

test("a day's date is set when it is born and never changes", async () => {
  const cookie = signIn();
  await put("days", { record: day("a"), baseVersion: null }, cookie);
  const moved = await (await put("days", { record: { ...day("ab"), day: "2027-01-01" }, baseVersion: 1 }, cookie)).json();
  assert.equal(moved.record.day, "2026-10-12");
});

test("a delete always wins and is kept as a tombstone; an edit onto it is a conflict", async () => {
  const cookie = signIn();
  await put("days", { record: day("a"), baseVersion: null }, cookie);
  const gone = await (await put("days", { record: day("a"), deleted: true }, cookie)).json();
  assert.deepEqual([gone.record.deleted, gone.record.version], [true, 2]);
  const edit = await put("days", { record: day("revived"), baseVersion: 2 }, cookie);
  assert.equal(edit.status, 409, "a day's edit onto its tombstone is a conflict");
  assert.equal((await edit.json()).record.deleted, true);
});

test("the pull returns the days changed since a cursor, tombstones included", async () => {
  const cookie = signIn();
  await put("days", { record: day("a"), baseVersion: null }, cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(Object.keys(all).sort(), ["cursor", "days"]);
  assert.deepEqual(all.days.map((d) => d.id), [D1]);
  await put("days", { record: day("a"), deleted: true }, cookie);
  const since = await (await pull(all.cursor, cookie)).json();
  assert.equal(since.days[0].deleted, true);
  assert.ok(since.cursor > all.cursor);
  const none = await (await pull(since.cursor, cookie)).json();
  assert.deepEqual([none.days, none.cursor], [[], since.cursor]);
});

// A journal file written while the journal kept detectors holds their tables, and a
// device's cursor may already be past their writes; the next day must still be pulled.
test("a day written into a file with older tables is numbered past them", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const user = newUser();
  const dir = join(process.env.UNBLENT_DATA, user);
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "journal.db"));
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, "on" INTEGER NOT NULL,
    version INTEGER NOT NULL, seq INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO projects VALUES ('${P1}', 'Goals and values', 1, 1, 50, 0);`);
  db.close();
  const cookie = cookieFor(user);
  await put("days", { record: day("a"), baseVersion: null }, cookie);
  const after = await (await pull(50, cookie)).json();
  assert.deepEqual(after.days.map((d) => d.id), [D1]);
  assert.ok(after.cursor > 50);
});
