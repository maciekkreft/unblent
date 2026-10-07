import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module is the far end of the same component (architecture.md 3). Every
// route needs a signed-in user (7.7), so the test forges the session cookie the
// server would set — an HMAC over the user id under SESSION_SECRET, which
// checks/check.py passes into the test env — rather than running a passkey ceremony.
// Each test uses its own user id, hence its own per-user database, so tests never see
// each other's settings. No test uses the Anthropic adapter: every completion is Echo,
// so the suite spends nothing.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshUser = () => `llm-test-${Date.now()}-${counter++}`;
const ulid = (n) => `01TEST${String(n).padStart(20, "0")}`;

const read = (cookie) =>
  fetch(`${BASE_URL}/api/llm`, { headers: cookie ? { Cookie: cookie } : {} });
const edit = (body, cookie) =>
  fetch(`${BASE_URL}/api/llm`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const complete = (body, cookie) =>
  fetch(`${BASE_URL}/api/llm/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

const pieces = async (res) =>
  (await res.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

const ask = (turn, extra = {}) => ({ id: ulid(1), start: "you are a test", turns: [{ id: ulid(2), role: "user", text: turn }], tools: [], ...extra });

test("every route needs a signed-in user (401 without a cookie)", async () => {
  assert.equal((await read()).status, 401);
  assert.equal((await edit({ provider: "echo" })).status, 401);
  assert.equal((await complete(ask("hello"))).status, 401);
});

test("a fresh account reads default settings", async () => {
  const cookie = cookieFor(freshUser());
  const picture = await (await read(cookie)).json();
  assert.equal(picture.provider, "anthropic");
  assert.equal(picture.effort, "default");
  assert.equal(picture.ttl, "1h");
  assert.deepEqual(picture.models, [], "no key, so no models to choose");
  assert.equal(picture.providers.find((p) => p.id === "anthropic").keySet, false);
});

test("settings round trip: provider, model and effort are kept", async () => {
  const cookie = cookieFor(freshUser());
  await edit({ provider: "echo", effort: "high" }, cookie);
  const picture = await (await read(cookie)).json();
  assert.equal(picture.provider, "echo");
  assert.equal(picture.effort, "high");
  assert.equal(picture.model, "echo", "echo's one model is picked as the default");
  assert.deepEqual(picture.models, [{ id: "echo", label: "Echo" }]);
});

test("a saved key sets keySet but never comes back", async () => {
  const cookie = cookieFor(freshUser());
  const res = await edit({ provider: "anthropic", key: "sk-ant-secret-value" }, cookie);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes("sk-ant-secret-value"), "the key is never in the reply");
  const picture = JSON.parse(text);
  assert.equal(picture.providers.find((p) => p.id === "anthropic").keySet, true);
  const again = await (await read(cookie)).text();
  assert.ok(!again.includes("sk-ant-secret-value"), "nor on a later read");
});

test("an empty key removes it", async () => {
  const cookie = cookieFor(freshUser());
  await edit({ provider: "anthropic", key: "sk-ant-secret-value" }, cookie);
  const picture = await (await edit({ provider: "anthropic", key: "" }, cookie)).json();
  assert.equal(picture.providers.find((p) => p.id === "anthropic").keySet, false);
});

test("a bad PUT is refused with 400 and does not echo the key", async () => {
  const cookie = cookieFor(freshUser());
  const res = await edit({ ttl: "bad", key: "sk-ant-would-leak" }, cookie);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(!text.includes("sk-ant-would-leak"), "a rejected body never echoes the key");
});

test("Echo streams the answer in pieces and ends done", async () => {
  const cookie = cookieFor(freshUser());
  await edit({ provider: "echo" }, cookie);
  const parts = await pieces(await complete(ask("hello there"), cookie));
  const text = parts.filter((p) => p.type === "text").map((p) => p.text).join("");
  assert.equal(text, "hello there", "Echo repeats the last user text");
  const end = parts.at(-1);
  assert.equal(end.type, "end");
  assert.equal(end.status, "done");
  assert.equal(end.provider, "echo");
  assert.ok(end.usage.cache_read_input_tokens > 0, "Echo reports a made-up cache read");
});

test("/fail ends failed, for the chat's Try again", async () => {
  const cookie = cookieFor(freshUser());
  await edit({ provider: "echo" }, cookie);
  const parts = await pieces(await complete(ask("/fail"), cookie));
  const end = parts.at(-1);
  assert.equal(end.status, "failed");
  assert.ok(end.error, "a failed end carries an error");
});

test("/think streams thinking before the text", async () => {
  const cookie = cookieFor(freshUser());
  await edit({ provider: "echo" }, cookie);
  const parts = await pieces(await complete(ask("/think about it"), cookie));
  assert.ok(parts.some((p) => p.type === "thinking"), "Echo streams thinking pieces");
  assert.equal(parts.at(-1).status, "done");
});

test("a tool call with a bad payload is marked invalid", async () => {
  const cookie = cookieFor(freshUser());
  await edit({ provider: "echo" }, cookie);
  const tools = [
    { target: "demo", name: "thing", description: "a demo tool", payload: { type: "object", properties: { index: { type: "integer" } }, required: ["index"], additionalProperties: false } },
  ];
  const parts = await pieces(await complete(ask('/tool demo: thing {"index": "not a number"}', { tools }), cookie));
  const call = parts.find((p) => p.type === "call");
  assert.equal(call.target, "demo");
  assert.equal(call.name, "thing");
  assert.ok(call.invalid, "the model's proposed input is validated and marked invalid (7.7)");
});

test("a valid tool call carries the mapped target and name, no invalid", async () => {
  const cookie = cookieFor(freshUser());
  await edit({ provider: "echo" }, cookie);
  const tools = [
    { target: "demo", name: "thing", description: "a demo tool", payload: { type: "object", properties: { index: { type: "integer" } }, required: ["index"], additionalProperties: false } },
  ];
  const parts = await pieces(await complete(ask('/tool demo: thing {"index": 3}', { tools }), cookie));
  const call = parts.find((p) => p.type === "call");
  assert.equal(call.target, "demo");
  assert.deepEqual(call.payload, { index: 3 });
  assert.ok(!("invalid" in call), "a valid input is not marked");
});

const decide = (body, cookie) =>
  fetch(`${BASE_URL}/api/llm/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
// No test reaches typesafe.ai: every decide below stops before the call (no key, or a
// refused body).
const DECISION = { state: { post: "hello" }, questions: [{ id: "q", instructions: "Is it a greeting?" }] };

test("a Jev key is saved beside the provider's, shown only as keySet, and removed by an empty one", async () => {
  const cookie = cookieFor(freshUser());
  assert.deepEqual((await (await read(cookie)).json()).jev, { keySet: false });
  const res = await edit({ jevKey: "jev-secret-value" }, cookie);
  const text = await res.text();
  assert.ok(!text.includes("jev-secret-value"), "the key is never in the reply");
  assert.deepEqual(JSON.parse(text).jev, { keySet: true });
  assert.deepEqual((await (await read(cookie)).json()).jev, { keySet: true });
  assert.equal((await (await read(cookie)).json()).providers.find((p) => p.id === "anthropic").keySet, false, "independent of the provider's key");
  assert.deepEqual((await (await edit({ jevKey: "" }, cookie)).json()).jev, { keySet: false });
});

test("decide needs a user, replies no-key without a key, and refuses a bad body with 400", async () => {
  assert.equal((await decide(DECISION)).status, 401);
  const cookie = cookieFor(freshUser());
  const res = await decide(DECISION, cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { error: "no-key" });
  assert.equal((await decide({ state: "text", questions: [] }, cookie)).status, 400);
  assert.equal((await decide({ state: {}, questions: [{ id: 1, instructions: "x" }] }, cookie)).status, 400);
});
