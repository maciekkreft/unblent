import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The server module is the far end of the same component (architecture.md 3), tested
// from here against the live check server. Every route needs a signed-in user (5), so
// the test forges the session cookie the server would set — an HMAC over the user id
// under SESSION_SECRET, which checks/check.py passes into the test env — rather than
// running a passkey ceremony. Each test uses its own user id, hence its own per-user
// database (5), so the tests never see each other's chats.
const BASE_URL = process.env.UNBLENT_URL;
assert.ok(BASE_URL, "UNBLENT_URL must be set");
const SECRET = process.env.SESSION_SECRET;
assert.ok(SECRET, "SESSION_SECRET must be set (checks/check.py reads it from .env)");
assert.ok(process.env.UNBLENT_DATA, "UNBLENT_DATA must name a throwaway data directory (checks/check.py sets it); never forge a cookie against the running server");

const cookieFor = (userId) =>
  `unblent_session=${userId}.${crypto.createHmac("sha256", SECRET).update(userId).digest("hex")}`;

let counter = 0;
const freshUser = () => `conv-test-${Date.now()}-${counter++}`;
const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const CHAT = U("W4");
const turn = (id, role, text, over = {}) => ({ id, role, text, ...over });

const put = (id, body, cookie) =>
  fetch(`${BASE_URL}/api/conversations/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
const get = (path, cookie) => fetch(`${BASE_URL}/api/conversations${path}`, { headers: cookie ? { Cookie: cookie } : {} });
const del = (id, cookie) => fetch(`${BASE_URL}/api/conversations/${id}`, { method: "DELETE", headers: cookie ? { Cookie: cookie } : {} });
const putTools = (body, cookie) =>
  fetch(`${BASE_URL}/api/conversations/tools`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });

const chat = (over = {}) => ({ title: "Hi", about: [{ kind: "book", id: "b1" }], start: "START", turns: [turn(U("A1"), "user", "hello")], ...over });

test("every route needs a signed-in user (401 without a cookie)", async () => {
  assert.equal((await get("")).status, 401);
  assert.equal((await put(CHAT, chat())).status, 401);
  assert.equal((await del(CHAT)).status, 401);
});

test("a chat is created and read back with its turns, links and start", async () => {
  const cookie = cookieFor(freshUser());
  const saved = await (await put(CHAT, chat(), cookie)).json();
  assert.ok(saved.updatedAt > 0);
  const got = await (await get(`/${CHAT}`, cookie)).json();
  assert.equal(got.title, "Hi");
  assert.deepEqual(got.about, [{ kind: "book", id: "b1" }]);
  assert.equal(got.start, "START");
  assert.equal(got.turns.length, 1);
  assert.equal(got.turns[0].text, "hello");
});

test("reading an unknown chat is a 404", async () => {
  const cookie = cookieFor(freshUser());
  assert.equal((await get(`/${CHAT}`, cookie)).status, 404);
});

test("a finished turn is added once and never rewritten (5)", async () => {
  const cookie = cookieFor(freshUser());
  await put(CHAT, chat({ turns: [turn(U("A1"), "assistant", "first", { status: "done" })] }), cookie);
  // A resend of the same id with different text is ignored: a finished turn never changes.
  await put(CHAT, chat({ turns: [turn(U("A1"), "assistant", "rewritten", { status: "done" })] }), cookie);
  const got = await (await get(`/${CHAT}`, cookie)).json();
  assert.equal(got.turns.length, 1);
  assert.equal(got.turns[0].text, "first", "the stored turn is kept, not overwritten");
});

test("turns added across writes are all kept, in save order", async () => {
  const cookie = cookieFor(freshUser());
  // A chat is remote-only: every turn needs the server, so turns reach it in the order
  // they were made. They are kept and returned in that save order (not by id, which two
  // components minting in the same millisecond cannot be trusted to sort right).
  await put(CHAT, chat({ turns: [turn(U("A1"), "user", "first")] }), cookie);
  await put(CHAT, chat({ turns: [turn(U("A2"), "assistant", "second", { status: "done" })] }), cookie);
  const got = await (await get(`/${CHAT}`, cookie)).json();
  assert.deepEqual(got.turns.map((t) => t.text), ["first", "second"], "both kept, in save order");
});

test("start is written once; title and links are last write wins", async () => {
  const cookie = cookieFor(freshUser());
  await put(CHAT, chat({ start: "FIRST", title: "T1" }), cookie);
  await put(CHAT, chat({ start: "SECOND", title: "T2", about: [{ kind: "book", id: "b2" }], turns: [] }), cookie);
  const got = await (await get(`/${CHAT}`, cookie)).json();
  assert.equal(got.start, "FIRST", "start never changes");
  assert.equal(got.title, "T2", "title is last write wins");
  assert.deepEqual(got.about, [{ kind: "book", id: "b2" }], "links are last write wins");
});

test("a pure resend is idempotent: no new turn, no reorder", async () => {
  const cookie = cookieFor(freshUser());
  const first = await (await put(CHAT, chat(), cookie)).json();
  const again = await (await put(CHAT, chat(), cookie)).json();
  assert.equal(again.updatedAt, first.updatedAt, "nothing changed, so updatedAt is unchanged");
});

test("a delete removes the chat and its turns", async () => {
  const cookie = cookieFor(freshUser());
  await put(CHAT, chat(), cookie);
  assert.equal((await del(CHAT, cookie)).status, 200);
  assert.equal((await get(`/${CHAT}`, cookie)).status, 404);
  const list = await (await get("", cookie)).json();
  assert.equal(list.conversations.find((c) => c.id === CHAT), undefined);
});

test("the list returns headings newest first, with the tool preferences", async () => {
  const cookie = cookieFor(freshUser());
  await put(U("B1"), chat({ title: "older" }), cookie);
  await put(U("B2"), chat({ title: "newer", turns: [turn(U("C1"), "user", "x")] }), cookie);
  const list = await (await get("", cookie)).json();
  assert.equal(list.conversations[0].title, "newer", "newest first");
  assert.equal(list.conversations[0].turns, undefined, "headings carry no turns");
  assert.deepEqual(list.tools, { tools: {}, approval: "auto" }, "the default tool preferences");
});

test("the list carries the latest answer that has text", async () => {
  const cookie = cookieFor(freshUser());
  await put(U("D1"), chat({ turns: [turn(U("E1"), "user", "q"), turn(U("E2"), "assistant", "\n\nFirst answer", { status: "done" }), turn(U("E3"), "user", "q2"), turn(U("E4"), "assistant", "  ", { status: "failed" })] }), cookie);
  await put(U("D2"), chat(), cookie);
  const list = await (await get("", cookie)).json();
  assert.equal(list.conversations.find((c) => c.id === U("D1")).answer, "First answer", "a blank later answer falls back to the one before");
  assert.equal(list.conversations.find((c) => c.id === U("D2")).answer, "", "no answer yet is empty");
});

test("the tool preferences round trip (7.7)", async () => {
  const cookie = cookieFor(freshUser());
  await putTools({ tools: { "notes: list": false }, approval: "auto" }, cookie);
  const list = await (await get("", cookie)).json();
  assert.deepEqual(list.tools, { tools: { "notes: list": false }, approval: "auto" });
});
