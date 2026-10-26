import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module, tested against the check's throwaway server with a forged session
// cookie (an HMAC over the user id under SESSION_SECRET). Each test has its own user,
// hence its own generators.db (5).
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshCookie = () => cookieFor(`generators-test-${Date.now()}-${counter++}`);

const CHAT = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const SOURCE = "c".repeat(64);

const generator = (over = {}) => ({ name: "Chat title", on: true, model: "claude-haiku-5-5", prompt: "Name it.", baseVersion: null, ...over });
const result = (over = {}) => ({ generator: "chat-title", item: CHAT, text: "Breakfast ideas", source: SOURCE, baseVersion: null, ...over });
const put = (path, payload, cookie) =>
  fetch(`${BASE_URL}/api/generators/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  });
const pull = (since, cookie) => fetch(`${BASE_URL}/api/generators?since=${since}`, { headers: cookie ? { Cookie: cookie } : {} });

test("every route needs a signed-in user", async () => {
  assert.equal((await put("generators/chat-title", generator())).status, 401);
  assert.equal((await put(`results/chat-title:${CHAT}`, result())).status, 401);
  assert.equal((await pull(0)).status, 401);
});

test("a generator continues from the base the browser held, and any later write wins", async () => {
  const cookie = freshCookie();
  const created = await (await put("generators/chat-title", generator({ baseVersion: 2 }), cookie)).json();
  assert.deepEqual(created, { id: "chat-title", name: "Chat title", on: true, model: "claude-haiku-5-5", prompt: "Name it.", version: 3 });
  const stale = await (await put("generators/chat-title", generator({ on: false, baseVersion: 1 }), cookie)).json();
  assert.deepEqual([stale.on, stale.version], [false, 4], "a stale base is never refused");
  const again = await (await put("generators/chat-title", generator({ on: false }), cookie)).json();
  assert.equal(again.version, 4, "the same content is not a new version");
});

test("a result is kept per generator and item, and a pull returns both kinds in order", async () => {
  const cookie = freshCookie();
  const made = await (await put(`results/chat-title:${CHAT}`, result(), cookie)).json();
  assert.deepEqual(made, { id: `chat-title:${CHAT}`, generator: "chat-title", item: CHAT, text: "Breakfast ideas", source: SOURCE, version: 1 });
  await put("generators/journal-summary", generator({ name: "Journal summary" }), cookie);
  const redone = await (await put(`results/chat-title:${CHAT}`, result({ text: "Breakfast plans" }), cookie)).json();
  assert.equal(redone.version, 2);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.generators.map((g) => g.id), ["journal-summary"]);
  assert.deepEqual(all.results.map((r) => r.text), ["Breakfast plans"]);
  assert.equal(all.cursor, 3);
  assert.deepEqual(await (await pull(all.cursor, cookie)).json(), { generators: [], results: [], cursor: 3 });
});

test("Could be's generator and its results, one per value, are kept like the others", async () => {
  const cookie = freshCookie();
  const VALUE = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
  const g = await (await put("generators/value-suggestion", generator({ name: "Could be" }), cookie)).json();
  assert.deepEqual([g.id, g.name, g.version], ["value-suggestion", "Could be", 1]);
  const r = await (await put(`results/value-suggestion:${VALUE}`, result({ generator: "value-suggestion", item: VALUE, text: "Contributing" }), cookie)).json();
  assert.deepEqual([r.id, r.text, r.version], [`value-suggestion:${VALUE}`, "Contributing", 1]);
  const all = await (await pull(0, cookie)).json();
  assert.deepEqual(all.results.map((x) => x.id), [`value-suggestion:${VALUE}`]);
});

test("a body that is not a generator or a result is refused with a fixed reply", async () => {
  const cookie = freshCookie();
  const bad = [
    ["generators/other", generator()],
    ["generators/chat-title", generator({ on: "yes" })],
    ["generators/chat-title", generator({ model: "" })],
    ["generators/chat-title", generator({ baseVersion: true })],
    [`results/chat-title:${CHAT}`, result({ source: "short" })],
    [`results/chat-title:${CHAT}`, result({ item: "other" })],
    [`results/other:${CHAT}`, result({ generator: "other" })],
    [`results/chat-title:${CHAT}`, result({ text: 3 })],
  ];
  for (const [path, payload] of bad) {
    const res = await put(path, payload, cookie);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(payload)}`);
    assert.deepEqual(await res.json(), { error: "bad-request" });
  }
  assert.equal((await pull("x", cookie)).status, 400);
});

test("users never see each other's generators or results", async () => {
  const a = freshCookie();
  const b = freshCookie();
  await put("generators/chat-title", generator(), a);
  await put(`results/chat-title:${CHAT}`, result(), a);
  assert.deepEqual(await (await pull(0, b)).json(), { generators: [], results: [], cursor: 0 });
});
