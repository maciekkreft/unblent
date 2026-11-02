import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own line-checks.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`line-checks-test-${Date.now()}-${counter++}`);

const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const KEY = "0123456789abcdef0123456789ab";
const KEY2 = "ba9876543210fedcba9876543210";
const answers = [{ question: Q1, option: O1, name: "In my control", p: 0.9 }];

const put = (key, payload, cookie) =>
  fetch(`${BASE_URL}/api/line-checks/answers/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/line-checks?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(KEY, { answers })).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("an answer is added once under its key and never changed; answers are pulled by cursor", async () => {
  const cookie = freshCookie();
  assert.deepEqual(await (await put(KEY, { answers }, cookie)).json(), { key: KEY, answers });
  const other = [{ question: Q1, option: "no", name: "No", p: 0.6 }];
  assert.deepEqual((await (await put(KEY, { answers: other }, cookie)).json()).answers, answers, "the first answer stays");
  const first = await (await pull(0, cookie)).json();
  assert.deepEqual(first.answers, [{ key: KEY, answers }]);
  await put(KEY2, { answers: [] }, cookie);
  const later = await (await pull(first.cursor, cookie)).json();
  assert.deepEqual(later.answers, [{ key: KEY2, answers: [] }]);
  assert.deepEqual(await (await pull(later.cursor, cookie)).json(), { answers: [], cursor: later.cursor });
});

test("a body that is not an answer is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bad = [
    put(KEY, { answers: [{ ...answers[0], p: 2 }] }, cookie),
    put(KEY, { answers: [{ ...answers[0], option: "maybe" }] }, cookie),
    put(KEY, { answers: [{ ...answers[0], extra: 1 }] }, cookie),
    put(KEY, { answers: "x" }, cookie),
    put("not-a-key", { answers }, cookie),
  ];
  for (const res of await Promise.all(bad)) {
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's answers", async () => {
  await put(KEY, { answers }, freshCookie());
  assert.deepEqual(await (await pull(0, freshCookie())).json(), { answers: [], cursor: 0 });
});
