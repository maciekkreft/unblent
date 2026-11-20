import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own prompt-sets.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`prompt-sets-test-${Date.now()}-${counter++}`);

const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";

const body = (over = {}) => ({
  name: "Evening review",
  occasion: "Evening",
  basedOn: "On Anger, Seneca",
  prompts: ["What did I do well today?", "Where did I fall short?"],
  position: "6",
  baseVersion: null,
  deleted: false,
  ...over,
});
const put = (id, payload, cookie) =>
  fetch(`${BASE_URL}/api/prompt-sets/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/prompt-sets?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(ID, body())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a create continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(ID, body({ baseVersion: 3 }), cookie)).json();
  const { baseVersion, deleted, ...fields } = body();
  assert.deepEqual(created, { id: ID, ...fields, version: 4, deleted: false });
  const res = await put(ID, body({ prompts: ["Only one"], baseVersion: 1 }), cookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 5, "a stale base is never refused");
  const again = await (await put(ID, body({ prompts: ["Only one"], baseVersion: 1 }), cookie)).json();
  assert.equal(again.version, 5, "the same content is not a new version");
});

const starters = (sets, cookie) =>
  fetch(`${BASE_URL}/api/prompt-sets/starters`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ sets }),
  });
const starter = (id, over = {}) => {
  const { deleted, ...rest } = body(over);
  return { id, ...rest };
};

test("the starters arrive in one request, each added only when nothing of its id is held, live or deleted", async () => {
  assert.equal((await starters([starter(ID)])).status, 401);
  const cookie = freshCookie();
  const first = await (await starters([starter(ID), starter(ID2, { name: "Other" })], cookie)).json();
  assert.deepEqual(first.sets.map((s) => [s.id, s.version]), [[ID, 1], [ID2, 1]]);
  await put(ID, body({ name: "Edited", baseVersion: 1 }), cookie);
  await put(ID2, body({ deleted: true, baseVersion: 1 }), cookie);
  const again = await (await starters([starter(ID), starter(ID2)], cookie)).json();
  assert.deepEqual([again.sets[0].name, again.sets[0].version], ["Edited", 2], "a starter never undoes an edit");
  assert.deepEqual([again.sets[1].deleted, again.sets[1].version], [true, 2], "a deleted starter stays deleted");
  for (const bad of [[], [starter("not-an-id")], [starter(ID, { prompts: "one" })], "x"]) {
    const res = await starters(bad, cookie);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
});

test("a delete is a tombstone that always wins and is pulled like a change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  await put(ID2, body({ name: "Other" }), cookie);
  const gone = await (await put(ID, body({ deleted: true, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([gone.deleted, gone.version], [true, 2]);
  const late = await (await put(ID, body({ name: "Revived" }), cookie)).json();
  assert.deepEqual([late.deleted, late.name, late.version], [true, "Evening review", 2], "a write onto a tombstone returns it");
  const restored = await (await put(ID, body({ name: "Back", baseVersion: 2 }), cookie)).json();
  assert.deepEqual([restored.deleted, restored.name, restored.version], [false, "Back", 3], "a restore write names the tombstone's version (5)");
  await put(ID, body({ deleted: true, baseVersion: 3 }), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.sets.map((s) => [s.id, s.deleted]), [[ID2, false], [ID, true]]);
  const later = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(later, { sets: [], cursor: all.cursor });
});

test("a body that is not a prompt set is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  for (const bad of [body({ name: 3 }), body({ prompts: "one" }), body({ prompts: [1] }), body({ position: null }), body({ baseVersion: true }), body({ deleted: "no" })]) {
    const res = await put(ID, bad, cookie);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await put("not-an-id", body(), cookie)).status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's prompt sets", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(ID, body(), a);
  assert.deepEqual((await (await pull(0, b)).json()).sets, []);
});
