import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own wheels.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`wheels-test-${Date.now()}-${counter++}`);

const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const DAY = "2026-10-14";

const ACTUAL = [6, null, null, null, null, null, null, null];
const WANTED = [9, 8, 7, 6, 5, 4, 3, 2];
const OTHER = [1, null, null, null, null, null, null, 10];

const body = (over = {}) => ({ day: DAY, actual: ACTUAL, wanted: WANTED, baseVersion: null, deleted: false, ...over });
const put = (id, payload, cookie) =>
  fetch(`${BASE_URL}/api/wheels/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/wheels?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(ID, body())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a create continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(ID, body({ baseVersion: 3 }), cookie)).json();
  assert.deepEqual(created, { id: ID, day: DAY, actual: ACTUAL, wanted: WANTED, version: 4, deleted: false });
  const res = await put(ID, body({ actual: OTHER, baseVersion: 1 }), cookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).version, 5, "a stale base is never refused");
  const again = await (await put(ID, body({ actual: OTHER, baseVersion: 1 }), cookie)).json();
  assert.equal(again.version, 5, "the same content is not a new version");
});

test("a day is set when the wheel is born and never changes", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  const moved = await (await put(ID, body({ day: "2026-10-15", actual: OTHER }), cookie)).json();
  assert.deepEqual([moved.day, moved.actual], [DAY, OTHER]);
});

test("a delete is a tombstone that always wins and is pulled like a change", async () => {
  const cookie = freshCookie();
  await put(ID, body(), cookie);
  await put(ID2, body({ actual: OTHER }), cookie);
  const gone = await (await put(ID, body({ deleted: true, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([gone.deleted, gone.version], [true, 2]);
  const late = await (await put(ID, body({ actual: OTHER }), cookie)).json();
  assert.deepEqual([late.deleted, late.actual, late.version], [true, ACTUAL, 2], "a write onto a tombstone returns it");
  const restored = await (await put(ID, body({ actual: OTHER, baseVersion: 2 }), cookie)).json();
  assert.deepEqual([restored.deleted, restored.actual, restored.version], [false, OTHER, 3], "a restore write names the tombstone's version (5)");
  await put(ID, body({ deleted: true, baseVersion: 3 }), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.wheels.map((w) => [w.id, w.deleted]), [[ID2, false], [ID, true]]);
  const later = await (await pull(all.cursor, cookie)).json();
  assert.deepEqual(later, { wheels: [], cursor: all.cursor });
});

test("a body that is not a wheel is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const seven = [1, 2, 3, 4, 5, 6, 7];
  const withScore = (score) => [score, null, null, null, null, null, null, null];
  const bads = [
    body({ day: "14 Oct" }),
    body({ actual: seven }),
    body({ wanted: [...seven, 8, 9] }),
    body({ actual: "6" }),
    body({ actual: null }),
    body({ actual: withScore(0) }),
    body({ wanted: withScore(11) }),
    body({ actual: withScore(1.5) }),
    body({ actual: withScore(true) }),
    body({ wanted: withScore("6") }),
    body({ baseVersion: true }),
    body({ deleted: "no" }),
  ];
  for (const bad of bads) {
    const res = await put(ID, bad, cookie);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await put("not-an-id", body(), cookie)).status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
  assert.deepEqual((await (await pull(0, cookie)).json()).wheels, [], "nothing refused was kept");
});

test("users never see each other's wheels", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(ID, body(), a);
  assert.deepEqual((await (await pull(0, b)).json()).wheels, []);
});
