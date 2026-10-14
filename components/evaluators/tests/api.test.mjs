import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

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
const freshCookie = () => cookieFor(`evaluators-test-${Date.now()}-${counter++}`);

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
  assert.deepEqual(created, { id: ID, book: BOOK, name: "Goals", on: true, questions: [QUESTION], version: 4, deleted: false });
  // Last write wins: a stale base is never refused.
  const res = await put(ID, body({ name: "Renamed", on: false, baseVersion: 1 }), cookie);
  assert.equal(res.status, 200);
  assert.deepEqual([(await res.json()).version], [5]);
  const again = await (await put(ID, body({ name: "Renamed", on: false, baseVersion: 1 }), cookie)).json();
  assert.equal(again.version, 5, "the same content is not a new version");
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
  for (const bad of [body({ on: "yes" }), body({ book: "nope" }), body({ questions: ["x"] }), body({ baseVersion: true })]) {
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
