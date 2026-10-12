import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

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
const signIn = () => cookieFor(`journal-test-${Date.now()}-${counter++}`);

const D1 = "01K7TEST00000000000000DA01";
const P1 = "01K7TEST00000000000000PR01";
const T1 = "01K7TEST00000000000000DT01";
const Q1 = "01K7TEST00000000000000QQ01";

const put = (kind, payload, cookie) =>
  fetch(`${BASE_URL}/api/journal/${kind}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/journal?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

const day = (text, editedAt = 1000) => ({ id: D1, day: "2026-10-12", text, editedAt });
const detector = (name, on = true) => ({
  id: T1,
  project: P1,
  name,
  on,
  questions: [{ id: Q1, kind: "yesno", text: "Is this a goal?", yes: "", no: "", options: [] }],
});
const answer = (p) => ({
  text: "One paragraph.",
  wording: { text: "Is this a goal?", yes: "", no: "", options: [] },
  answer: { id: Q1, p },
  at: 2000,
});

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
    ["projects", { record: { id: P1, name: secretish, on: "yes" } }],
    ["notes", { record: { id: P1, name: secretish, on: true } }],
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
  const adopted = await (await put("projects", { record: { id: P1, name: "Mine", on: true }, baseVersion: 4 }, cookie)).json();
  assert.deepEqual(adopted.record, { id: P1, name: "Mine", on: true, version: 5, deleted: false });
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

test("a detector is last write wins: a write on any version replaces it, never a 409", async () => {
  const cookie = signIn();
  await put("detectors", { record: detector("Phone"), baseVersion: null }, cookie);
  await put("detectors", { record: detector("Phone again"), baseVersion: 1 }, cookie);
  const res = await put("detectors", { record: detector("Laptop", false), baseVersion: 1 }, cookie);
  assert.equal(res.status, 200);
  const { record } = await res.json();
  assert.equal(record.version, 3);
  assert.equal(record.name, "Laptop");
  assert.equal(record.on, false);
  assert.deepEqual(record.questions, detector("x").questions, "the questions come back as they were sent");
});

test("answers are kept by question and paragraph, last write wins", async () => {
  const cookie = signIn();
  const first = await (await put("answers", { record: answer(0.2), baseVersion: null }, cookie)).json();
  assert.equal(first.record.version, 1);
  const second = await (await put("answers", { record: answer(0.9), baseVersion: null }, cookie)).json();
  assert.equal(second.record.version, 2, "the same question and paragraph is the same record");
  assert.equal(second.record.answer.p, 0.9);
  const other = await (await put("answers", { record: { ...answer(0.5), text: "Another." }, baseVersion: null }, cookie)).json();
  assert.equal(other.record.version, 1);
});

test("a delete always wins and is kept as a tombstone; a later write does not bring the record back", async () => {
  const cookie = signIn();
  await put("projects", { record: { id: P1, name: "Mine", on: true }, baseVersion: null }, cookie);
  const gone = await (await put("projects", { record: { id: P1, name: "Mine", on: true }, deleted: true }, cookie)).json();
  assert.equal(gone.record.deleted, true);
  assert.equal(gone.record.version, 2);
  const late = await put("projects", { record: { id: P1, name: "Renamed", on: true }, baseVersion: 1 }, cookie);
  assert.equal(late.status, 200, "last write wins is never a conflict");
  assert.deepEqual((await late.json()).record, { id: P1, name: "Mine", on: true, version: 2, deleted: true });
  await put("days", { record: day("a"), baseVersion: null }, cookie);
  await put("days", { record: day("a"), deleted: true }, cookie);
  const edit = await put("days", { record: day("revived"), baseVersion: 2 }, cookie);
  assert.equal(edit.status, 409, "a day's edit onto its tombstone is a conflict");
  assert.equal((await edit.json()).record.deleted, true);
});

test("the pull returns every kind changed since a cursor, tombstones included", async () => {
  const cookie = signIn();
  await put("days", { record: day("a"), baseVersion: null }, cookie);
  await put("projects", { record: { id: P1, name: "Mine", on: true }, baseVersion: null }, cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.days.map((d) => d.id), [D1]);
  assert.deepEqual(all.projects.map((p) => p.id), [P1]);
  assert.deepEqual([all.detectors, all.answers], [[], []]);
  await put("detectors", { record: detector("New"), baseVersion: null }, cookie);
  await put("projects", { record: { id: P1, name: "Mine", on: true }, deleted: true }, cookie);
  const since = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(since.days, []);
  assert.deepEqual(since.detectors.map((d) => d.name), ["New"]);
  assert.equal(since.projects[0].deleted, true);
  assert.ok(since.cursor > all.cursor);
  const none = await (await pull(since.cursor, cookie)).json();
  assert.deepEqual([none.days, none.projects, none.detectors, none.answers, none.cursor], [[], [], [], [], since.cursor]);
});
