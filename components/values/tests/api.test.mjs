import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own values.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`values-test-${Date.now()}-${counter++}`);

const DAY = "2026-10-14";
const parent = { id: "01ARZ3NDEKTSV4RRFFQ69G5VA1", name: "Being a present parent", meaning: "" };
const health = { id: "01ARZ3NDEKTSV4RRFFQ69G5VA2", name: "Health", meaning: "Moving every day" };

const put = (day, payload, cookie) =>
  fetch(`${BASE_URL}/api/values/${day}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/values?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(DAY, { values: [], baseVersion: null })).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a day's first write continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(DAY, { values: [parent], baseVersion: 3 }, cookie)).json();
  assert.deepEqual(created, { day: DAY, values: [parent], version: 4 });
  const res = await put(DAY, { values: [parent, health], baseVersion: 1 }, cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { day: DAY, values: [parent, health], version: 5 }, "a stale base is never refused");
  const again = await (await put(DAY, { values: [parent, health], baseVersion: 1 }, cookie)).json();
  assert.equal(again.version, 5, "the same values are not a new version");
});

test("each day is its own version, pulled in the order written", async () => {
  const cookie = freshCookie();
  await put("2026-10-12", { values: [health], baseVersion: null }, cookie);
  await put(DAY, { values: [parent], baseVersion: null }, cookie);
  await put("2026-10-12", { values: [health, parent], baseVersion: 1 }, cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.versions.map((v) => [v.day, v.version]), [[DAY, 1], ["2026-10-12", 2]]);
  assert.deepEqual(await (await pull(all.cursor, cookie)).json(), { versions: [], cursor: all.cursor });
});

test("a body that is not a version of the values is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bad = [
    { values: "Health" },
    { values: [{ ...parent, id: "x" }] },
    { values: [{ ...parent, name: 3 }] },
    { values: [{ id: parent.id, name: "Health" }] },
    { values: [{ ...parent, extra: true }] },
    { values: [], baseVersion: true },
  ];
  for (const body of bad) {
    const res = await put(DAY, body, cookie);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await put("14 Oct", { values: [] }, cookie)).status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's values", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(DAY, { values: [parent], baseVersion: null }, a);
  assert.deepEqual((await (await pull(0, b)).json()).versions, []);
});
