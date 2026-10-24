import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own choice-point-checks.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`choice-point-checks-test-${Date.now()}-${counter++}`);

const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const EV2 = "0000000000000000000000YVAS";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G5PT1";
const KEY = "0123456789abcdef0123456789ab";

const question = { id: Q1, show: true, expect: O1, when: null, icons: { [O1]: "check", no: "none" } };
const boxBody = (over = {}) => ({ evaluator: EV, questions: [question], baseVersion: null, ...over });
const answers = [{ question: Q1, option: O1, name: "Behavioral goal", p: 0.9 }];

const put = (path, payload, cookie) =>
  fetch(`${BASE_URL}/api/choice-point-checks/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/choice-point-checks?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put("boxes/towards", boxBody())).status, 401);
  assert.equal((await put(`answers/${KEY}`, { answers })).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a box continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put("boxes/towards", boxBody({ baseVersion: 2 }), cookie)).json();
  assert.deepEqual(created, { field: "towards", evaluator: EV, questions: [question], also: [], version: 3 });
  const cleared = await (await put("boxes/towards", boxBody({ evaluator: null, questions: [], baseVersion: 1 }), cookie)).json();
  assert.deepEqual([cleared.evaluator, cleared.version], [null, 4], "a stale base is never refused");
  const again = await (await put("boxes/towards", boxBody({ evaluator: null, questions: [] }), cookie)).json();
  assert.equal(again.version, 4, "the same settings are not a new version");
});

test("a box keeps its further evaluators, and changing them is a new version", async () => {
  const cookie = freshCookie();
  const also = [{ evaluator: EV2, questions: [] }];
  const first = await (await put("boxes/towards", boxBody({ also }), cookie)).json();
  assert.deepEqual([first.also, first.version], [also, 1]);
  const same = await (await put("boxes/towards", boxBody({ also }), cookie)).json();
  assert.equal(same.version, 1, "the same further evaluators are not a new version");
  const none = await (await put("boxes/towards", boxBody({ also: [] }), cookie)).json();
  assert.deepEqual([none.also, none.version], [[], 2]);
  const pulled = await (await pull(0, cookie)).json();
  assert.deepEqual(pulled.boxes.map((b) => b.also), [[]]);
});

test("an answer is added once under its key and never changed; both are pulled by cursor", async () => {
  const cookie = freshCookie();
  assert.deepEqual(await (await put(`answers/${KEY}`, { answers }, cookie)).json(), { key: KEY, answers });
  const other = [{ question: Q1, option: "no", name: "No", p: 0.6 }];
  assert.deepEqual((await (await put(`answers/${KEY}`, { answers: other }, cookie)).json()).answers, answers, "the first answer stays");
  await put("boxes/away", boxBody(), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.answers, [{ key: KEY, answers }]);
  assert.deepEqual(all.boxes.map((b) => b.field), ["away"]);
  assert.deepEqual(await (await pull(all.cursor, cookie)).json(), { boxes: [], answers: [], cursor: all.cursor });
});

test("a body that is not a box or an answer is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bad = [
    put("boxes/elsewhere", boxBody(), cookie),
    put("boxes/towards", boxBody({ evaluator: "x" }), cookie),
    put("boxes/towards", boxBody({ questions: [{ ...question, icons: { [O1]: "star" } }] }), cookie),
    put("boxes/towards", boxBody({ baseVersion: true }), cookie),
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
  await put("boxes/towards", boxBody(), a);
  await put(`answers/${KEY}`, { answers }, a);
  assert.deepEqual(await (await pull(0, freshCookie())).json(), { boxes: [], answers: [], cursor: 0 });
});
