import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own experts.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`experts-test-${Date.now()}-${counter++}`);

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const BOOK2 = "01ARZ3NDEKTSV4RRFFQ69G5BK2";

const expert = (over = {}) => ({ prompt: "Speak as Seneca.", on: true, baseVersion: null, ...over });
const put = (id, payload, cookie) =>
  fetch(`${BASE_URL}/api/experts/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/experts?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put(BOOK, expert())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("an expert continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put(BOOK, expert({ baseVersion: 2 }), cookie)).json();
  assert.deepEqual(created, { id: BOOK, prompt: "Speak as Seneca.", on: true, version: 3 });
  const stale = await (await put(BOOK, expert({ on: false, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([stale.on, stale.version], [false, 4], "a stale base is never refused");
  const again = await (await put(BOOK, expert({ on: false }), cookie)).json();
  assert.equal(again.version, 4, "the same content is not a new version");
});

test("a pull returns what changed since the cursor, in the order written", async () => {
  const cookie = freshCookie();
  await put(BOOK, expert(), cookie);
  await put(BOOK2, expert({ prompt: "Stoic" }), cookie);
  await put(BOOK, expert({ prompt: "Seneca, briefly." }), cookie);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.experts.map((e) => [e.id, e.prompt, e.version]), [
    [BOOK2, "Stoic", 1],
    [BOOK, "Seneca, briefly.", 2],
  ]);
  assert.equal(all.cursor, 3);
  assert.deepEqual(await (await pull(all.cursor, cookie)).json(), { experts: [], cursor: 3 });
  assert.deepEqual((await (await pull(2, cookie)).json()).experts.map((e) => e.id), [BOOK]);
});

test("a body that is not an expert is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bad = [expert({ on: "yes" }), expert({ prompt: 3 }), expert({ prompt: undefined }), expert({ baseVersion: true }), expert({ baseVersion: 0 })];
  for (const payload of bad) {
    const res = await put(BOOK, payload, cookie);
    assert.equal(res.status, 400, JSON.stringify(payload));
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  const notObject = await fetch(`${BASE_URL}/api/experts/${BOOK}`, { method: "PUT", headers: { "content-type": "application/json", Cookie: cookie }, body: "[1]" });
  assert.equal(notObject.status, 400);
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's experts", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put(BOOK, expert(), a);
  assert.deepEqual(await (await pull(0, b)).json(), { experts: [], cursor: 0 });
});
