import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own value-checks.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`value-checks-test-${Date.now()}-${counter++}`);

const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const EX = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const KEY = "0123456789abcdef0123456789ab";

const answers = [{ question: Q1, option: O1, name: "A value", p: 0.9 }];

const put = (path, payload, cookie) =>
  fetch(`${BASE_URL}/api/value-checks/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/value-checks?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put("settings", { values: EV, examples: null, baseVersion: null })).status, 401);
  assert.equal((await put(`answers/${KEY}`, { answers })).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("the settings continue from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put("settings", { values: EV, examples: EX, baseVersion: 2 }, cookie)).json();
  assert.deepEqual(created, { values: EV, examples: EX, version: 3 });
  const cleared = await (await put("settings", { values: null, examples: EX, baseVersion: 1 }, cookie)).json();
  assert.deepEqual(cleared, { values: null, examples: EX, version: 4 }, "a stale base is never refused");
  const again = await (await put("settings", { values: null, examples: EX, baseVersion: null }, cookie)).json();
  assert.equal(again.version, 4, "the same settings are not a new version");
});

test("an answer is added once under its key and never changed; both are pulled by cursor", async () => {
  const cookie = freshCookie();
  assert.deepEqual(await (await put(`answers/${KEY}`, { answers }, cookie)).json(), { key: KEY, answers });
  const other = [{ question: Q1, option: "no", name: "No", p: 0.6 }];
  assert.deepEqual((await (await put(`answers/${KEY}`, { answers: other }, cookie)).json()).answers, answers, "the first answer stays");
  await put("settings", { values: EV, examples: null, baseVersion: null }, cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.answers, [{ key: KEY, answers }]);
  assert.deepEqual(all.settings, { values: EV, examples: null, version: 1 });
  assert.deepEqual(await (await pull(all.cursor, cookie)).json(), { settings: null, answers: [], cursor: all.cursor });
});

test("a body that is not the settings or an answer is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bad = [
    put("settings", { values: "x", examples: null }, cookie),
    put("settings", { values: EV }, cookie),
    put("settings", { values: EV, examples: null, baseVersion: true }, cookie),
    put(`answers/${KEY}`, { answers: [{ ...answers[0], p: 2 }] }, cookie),
    put("answers/not-a-key", { answers }, cookie),
  ];
  for (const res of await Promise.all(bad)) {
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's checks", async () => {
  const a = freshCookie();
  await put("settings", { values: EV, examples: null, baseVersion: null }, a);
  await put(`answers/${KEY}`, { answers }, a);
  assert.deepEqual(await (await pull(0, freshCookie())).json(), { settings: null, answers: [], cursor: 0 });
});
