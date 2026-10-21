import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, toMarkdown, commentsBlock, forModel, between, positionOf, byPosition } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (p) => JSON.parse(readFileSync(resolve(HERE, "..", p), "utf8"));
const loadFixture = (name) => JSON.parse(readFileSync(resolve(HERE, "fixtures", `${name}.json`), "utf8"));

// The schemas the machine's traffic must match (shape test, Testing). A schema owned by
// another component is read from its directory, not imported (a component may not import
// another's files, 11.2).
const EVENTS = {
  "conversation.changed": load("events/conversation.changed.json"),
  "conversation.deleted": load("events/conversation.deleted.json"),
  "conversation.opened": load("events/conversation.opened.json"),
  "tools.changed": load("events/tools.changed.json"),
};
const QUERIES = {
  list: load("queries/list.json"),
  read: load("queries/read.json"),
  open: load("queries/open.json"),
  tools: load("queries/tools.json"),
};
const other = (component, kind, name) =>
  JSON.parse(readFileSync(resolve(HERE, "..", "..", component, kind, `${name}.json`), "utf8"));
const SESSION_READ = other("session", "queries", "read");
const SUBJECT_READ = other("subject", "queries", "read");
const COMPLETE = other("llm", "queries", "complete");
const CONTRACTS = other("catalog", "queries", "contracts");
const BOOKS_CHAPTER = other("books", "queries", "chapter");

// A catalog: contracts reply carrying one query as a tool (7.7): what the loop reads to
// build the tool list and to convert a tool's HTML reply to markdown.
const toolQuery = (target, name, q) => ({ target, name, payload: q.payload, reply: q.reply, supersededBy: q.supersededBy ?? [], askers: [], tool: q.tool });
const CHAPTER_TOOL = toolQuery("books", "chapter", BOOKS_CHAPTER);
const SUBJECT_TOOL = toolQuery("subject", "read", SUBJECT_READ);

// Valid ULIDs (^[0-9A-HJKMNP-TV-Z]{26}$). ANSWER equals the id in the progressed-*
// fixtures, so an injected ulid mints that id for the pending answer and the fixtures'
// completion.progressed events route to it.
const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const ANSWER = U("W2");
const USER = U("W3");
const CHAT = U("W4");
const CHAT2 = U("W5");
const ANSWER2 = U("X1");
const RESULT1 = U("X2");
const BOOK = U("W6");

// A generator for the ids a test does not pin, so a loop that mints many turn ids gets
// distinct valid ULIDs (Crockford base32, no I L O U).
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const twoChar = (n) => B32[(n >> 5) & 31] + B32[n & 31];

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(pred, label = "condition") {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await flush();
  }
  throw new Error(`${label} never met`);
}

// Every message the machine emits or replies during a run, with the schema it must
// satisfy; the final test validates them all (Testing, shape test).
const recorded = [];
const see = (value, schema) => recorded.push({ value, schema });

function start(options = {}) {
  const {
    userId = "u1",
    conversations = [],
    tools = { tools: {}, approval: "auto" },
    subject = null,
    stored = null,
    ids = [ANSWER],
    chatsById = {},
    onComplete = (request) => Promise.resolve({ id: request.id }),
    onSave = () => Promise.resolve({ updatedAt: 900 }),
    contracts = { queries: [] },
    askTool = () => Promise.resolve({}),
    listValues,
    now,
    pinned = null,
  } = options;

  const calls = { saved: [], deleted: [], savedTools: [], completes: [], reads: [], tools: [], list: 0, contracts: 0 };
  let storeValue = stored;
  const idQueue = [...ids];
  let auto = 0;
  let clock = 1000;
  const lists = listValues ? [...listValues] : null;

  const input = {
    session: () => {
      see({}, SESSION_READ.payload);
      const who = typeof userId === "function" ? userId() : userId;
      return Promise.resolve(who ? { userId: who, registrationOpen: true } : { userId: null, registrationOpen: true });
    },
    subject: () => {
      see({}, SUBJECT_READ.payload);
      return Promise.resolve({ subject });
    },
    pins: () => Promise.resolve({ note: null, chat: pinned, evaluators: null }),
    complete: (request) => {
      see(request, COMPLETE.payload);
      calls.completes.push(request);
      return onComplete(request);
    },
    contracts: () => {
      see({}, CONTRACTS.payload);
      calls.contracts += 1;
      return Promise.resolve(contracts);
    },
    askTool: (target, name, payload) => {
      const q = (contracts.queries || []).find((x) => x.target === target && x.name === name);
      if (q) see(payload, q.payload);
      calls.tools.push({ target, name, payload });
      return askTool(target, name, payload);
    },
    list: () => {
      calls.list += 1;
      const value = lists ? lists.shift() ?? lists.at(-1) : { conversations, tools };
      return Promise.resolve(value);
    },
    read: (id) => {
      calls.reads.push(id);
      return chatsById[id] ? Promise.resolve(chatsById[id]) : Promise.reject(new Error("404"));
    },
    saveChat: (id, body) => {
      calls.saved.push({ id, body });
      return onSave(id, body, calls.saved.length);
    },
    deleteChat: (id) => {
      calls.deleted.push(id);
      return Promise.resolve();
    },
    saveTools: (body) => {
      calls.savedTools.push(body);
      return Promise.resolve();
    },
    store: { read: () => storeValue, write: (id) => (storeValue = id) },
    ulid: () => (idQueue.length ? idQueue.shift() : U(twoChar(auto++))),
    now: now || (() => clock++),
    subscribe: undefined,
  };

  const actor = createActor(machine, { input });
  const emitted = [];
  for (const name of Object.keys(EVENTS))
    actor.on(name, (e) => {
      emitted.push(e);
      see(e, EVENTS[name]);
    });
  actor.start();
  return { actor, calls, emitted, store: () => storeValue };
}

const ready = (h) => until(() => h.actor.getSnapshot().matches("ready"), "ready");

// A query as the bus delivers it (4.2): the answerer calls reply once.
const query = (actor, name, payload, schema) =>
  new Promise((resolve) =>
    actor.send({
      type: `${name}?`,
      cid: "cid",
      payload,
      reply: (value) => {
        see(value, schema);
        resolve(value);
      },
    }),
  );

const changes = (h) => h.emitted.filter((e) => e.type === "conversation.changed");
const lastChange = (h) => changes(h).at(-1);
const lastAssistant = (h) => {
  const turns = lastChange(h).turns;
  return turns[turns.length - 1];
};

const submit = (h, over = {}) =>
  h.actor.send({ type: "turn.submitted", conversationId: CHAT, turn: { id: USER, text: "hello" }, about: [], start: "You help with books.", ...over });

async function feed(h, events) {
  for (const event of events) {
    h.actor.send(event);
    await flush();
  }
}

test("a new chat appends the user turn and a pending answer, opens it, and asks the model", async () => {
  const h = start();
  await ready(h);
  submit(h);
  await flush();
  const opened = h.emitted.filter((e) => e.type === "conversation.opened").at(-1);
  assert.equal(opened.id, CHAT);
  const turns = lastChange(h).turns;
  assert.equal(turns.length, 2);
  assert.deepEqual({ role: turns[0].role, text: turns[0].text }, { role: "user", text: "hello" });
  assert.equal(turns[1].role, "assistant");
  assert.equal(turns[1].status, "pending");
  const request = h.calls.completes[0];
  assert.equal(request.id, ANSWER);
  assert.deepEqual(request.tools, []);
  assert.equal(request.turns.length, 1, "the empty pending answer is not sent to the model");
  assert.equal(request.turns[0].id, USER);
  assert.ok(h.calls.saved.some((s) => s.body.turns.some((t) => t.id === USER)), "the user turn is saved at once");
});

test("a plain answer streams into the open turn and ends done, then is saved", async () => {
  const h = start();
  await ready(h);
  submit(h);
  await flush();
  await feed(h, loadFixture("progressed-plain"));
  const answer = lastAssistant(h);
  assert.equal(answer.status, "done");
  assert.equal(answer.text, "A plain answer.");
  assert.equal(answer.provider, "echo");
  assert.ok(answer.raw, "a done turn keeps raw for replay");
  assert.ok(answer.usage, "and the usage");
  await until(() => h.calls.saved.some((s) => s.body.turns.some((t) => t.id === ANSWER)), "answer saved");
  await flush();
  assert.equal(lastChange(h).pending, false, "once saved, the chat is not pending");
});

test("thinking accumulates alongside the text", async () => {
  const h = start();
  await ready(h);
  submit(h);
  await flush();
  await feed(h, loadFixture("progressed-think"));
  assert.equal(lastAssistant(h).thinking, "Considering the question and how to answer it…");
  assert.equal(lastAssistant(h).status, "done");
});

test("a provider failure ends the turn failed with the error", async () => {
  const h = start();
  await ready(h);
  submit(h);
  await flush();
  await feed(h, loadFixture("progressed-fail"));
  assert.equal(lastAssistant(h).status, "failed");
  assert.equal(lastAssistant(h).error, "echo-failure");
});

test("stop ends the turn stopped, keeping what had arrived", async () => {
  const h = start();
  await ready(h);
  submit(h);
  await flush();
  await feed(h, loadFixture("progressed-slow-stopped"));
  assert.equal(lastAssistant(h).status, "stopped");
  assert.equal(lastAssistant(h).text, "/slow this answer arrives slowly so ");
});

test("refused and truncated are stored as failed with the reason (Contracts)", async () => {
  const refused = start();
  await ready(refused);
  submit(refused);
  await flush();
  await feed(refused, [{ type: "completion.progressed", id: ANSWER, text: "I can't help with that.", calls: [], done: true, status: "refused", provider: "echo", model: "echo" }]);
  assert.equal(lastAssistant(refused).status, "failed");
  assert.equal(lastAssistant(refused).error, "refused");
  assert.equal(lastAssistant(refused).text, "I can't help with that.", "the explanation stays in the text");

  const truncated = start();
  await ready(truncated);
  submit(truncated);
  await flush();
  await feed(truncated, [{ type: "completion.progressed", id: ANSWER, text: "A long answer cut", calls: [], done: true, status: "truncated", provider: "echo", model: "echo" }]);
  assert.equal(truncated.emitted.filter((e) => e.type === "conversation.changed").at(-1).turns.at(-1).error, "truncated");
});

test("a complete refusal marks the pending answer failed", async () => {
  const h = start({ onComplete: () => Promise.resolve({ error: "no-key" }) });
  await ready(h);
  submit(h);
  await until(() => lastAssistant(h).status === "failed", "failed");
  assert.equal(lastAssistant(h).error, "no-key");
});

test("Continue asks the model again when the chat ends with a user turn", async () => {
  const chat = { id: CHAT, title: "t", about: [], start: "s", turns: [{ id: USER, role: "user", text: "continue" }], updatedAt: 5 };
  const h = start({ conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5 }], chatsById: { [CHAT]: chat }, ids: [ANSWER] });
  await ready(h);
  h.actor.send({ type: "conversation.selected", id: CHAT });
  await until(() => changes(h).length > 0, "loaded");
  h.actor.send({ type: "turn.steered", conversationId: CHAT, turnId: USER, action: "continue" });
  await flush();
  assert.equal(h.calls.completes.length, 1, "Continue asks the model");
  assert.equal(h.calls.completes[0].id, ANSWER);
  assert.equal(lastAssistant(h).status, "pending");
});

test("a failed save is retried when the tab regains focus", async () => {
  const h = start({ onSave: (id, body, n) => (n === 1 ? Promise.reject(new Error("offline")) : Promise.resolve({ updatedAt: 950 })) });
  await ready(h);
  submit(h);
  await until(() => h.calls.saved.length === 1, "first save tried");
  await flush();
  assert.equal(lastChange(h).pending, true, "an unsent turn keeps the chat pending");
  h.actor.send({ type: "_focus" });
  await until(() => h.calls.saved.length >= 2, "save retried on focus");
  await until(() => lastChange(h).pending === false, "retry clears pending");
});

test("a focus reload does not drop finished turns still waiting to be saved", async () => {
  // The open chat holds a turn the server has not confirmed. A reload would replace
  // memory with the server's copy, which lacks that turn, losing it while its id stays
  // unsent. onFocus must keep memory and only retry the save (5: nothing completed is lost).
  const h = start({
    onSave: () => Promise.reject(new Error("offline")),
    chatsById: { [CHAT]: { id: CHAT, title: "", about: [], start: "", turns: [], updatedAt: 0 } },
  });
  await ready(h);
  submit(h);
  await until(() => h.calls.saved.length === 1, "first save tried");
  await flush();
  assert.equal(lastChange(h).pending, true, "an unsent turn keeps the chat pending");
  const before = h.calls.saved.length;
  h.actor.send({ type: "_focus" });
  await until(() => h.calls.saved.length > before, "the save is retried on focus");
  await flush();
  assert.ok(!h.calls.reads.includes(CHAT), "the open chat with unsent turns is not reloaded from the server");
  const reply = await query(h.actor, "read", { id: CHAT }, QUERIES.read.reply);
  assert.ok(reply.conversation, "the chat is still in memory");
  assert.ok(reply.conversation.turns.some((t) => t.id === USER), "the unsent user turn survives the focus");
});

test("the open chat follows the subject (12)", async () => {
  const conversations = [
    { id: CHAT, title: "older", about: [{ kind: "book", id: "b1" }], updatedAt: 5 },
    { id: CHAT2, title: "newer", about: [{ kind: "book", id: "b1" }], updatedAt: 10 },
  ];
  const h = start({ conversations, chatsById: { [CHAT2]: { id: CHAT2, title: "newer", about: [{ kind: "book", id: "b1" }], start: "", turns: [], updatedAt: 10 } } });
  await ready(h);
  h.actor.send({ type: "subject.changed", subject: { kind: "book", id: "b1", title: "A Book", view: "book-reader" } });
  await flush();
  const opened = h.emitted.filter((e) => e.type === "conversation.opened").at(-1);
  assert.equal(opened.id, CHAT2, "the most recently updated chat about the subject");
});

test("a stored open chat about the subject is kept when the subject settles after a reload (12)", async () => {
  // The reader had picked the older chat about book B. On a reload the stored open id is
  // read first and the subject arrives after, as a change from none to B. The chat the
  // reader chose must stay open, not be replaced by the newest chat about B.
  const conversations = [
    { id: CHAT, title: "older", about: [{ kind: "book", id: "b1" }], updatedAt: 5 },
    { id: CHAT2, title: "newer", about: [{ kind: "book", id: "b1" }], updatedAt: 10 },
  ];
  const h = start({ conversations, stored: CHAT, subject: null });
  await ready(h);
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT, "the stored chat is open at boot");
  h.actor.send({ type: "subject.changed", subject: { kind: "book", id: "b1", title: "A Book", view: "book-reader" } });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT, "and stays open when the subject settles");
  assert.ok(
    !h.emitted.some((e) => e.type === "conversation.opened" && e.id === CHAT2),
    "the newest chat was never opened over the reader's choice",
  );
});

test("a pinned open chat stays open when the subject changes; unpinned, the next change is followed (12)", async () => {
  const B1 = { kind: "book", id: "b1", title: "One", view: "book-reader" };
  const B2 = { kind: "book", id: "b2", title: "Two", view: "book-reader" };
  const conversations = [
    { id: CHAT, title: "about one", about: [{ kind: "book", id: "b1" }], updatedAt: 5 },
    { id: CHAT2, title: "about two", about: [{ kind: "book", id: "b2" }], updatedAt: 10 },
  ];
  const h = start({ conversations, stored: CHAT, subject: B1, pinned: CHAT });
  await ready(h);
  h.actor.send({ type: "subject.changed", subject: B2 });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT, "the pinned chat stays");
  assert.ok(!h.emitted.some((e) => e.type === "conversation.opened"), "nothing else was opened");

  h.actor.send({ type: "pins.changed", note: null, chat: null, evaluators: null });
  h.actor.send({ type: "subject.changed", subject: B1 });
  h.actor.send({ type: "subject.changed", subject: B2 });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT2, "unpinned, it follows the stage again");
});

test("a pin on another chat than the open one does not hold the open chat", async () => {
  const conversations = [
    { id: CHAT, title: "about one", about: [{ kind: "book", id: "b1" }], updatedAt: 5 },
    { id: CHAT2, title: "about two", about: [{ kind: "book", id: "b2" }], updatedAt: 10 },
  ];
  const h = start({ conversations, stored: CHAT, pinned: CHAT2 });
  await ready(h);
  h.actor.send({ type: "subject.changed", subject: { kind: "book", id: "b2", title: "Two", view: "book-reader" } });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT2);
});

test("a pinned new chat with no message follows the subject; after its first message it stays (12)", async () => {
  const B1 = { kind: "book", id: "b1", title: "One", view: "book-reader" };
  const B2 = { kind: "book", id: "b2", title: "Two", view: "book-reader" };
  const conversations = [{ id: CHAT2, title: "about two", about: [{ kind: "book", id: "b2" }], updatedAt: 10 }];
  const FRESH = U("NW");
  const h = start({ conversations, subject: B1, pinned: FRESH });
  await ready(h);
  h.actor.send({ type: "conversation.selected", id: FRESH });
  h.actor.send({ type: "subject.changed", subject: B2 });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT2, "the empty chat gave way to the book's chat");

  h.actor.send({ type: "conversation.selected", id: FRESH });
  submit(h, { conversationId: FRESH });
  h.actor.send({ type: "subject.changed", subject: B1 });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, FRESH, "with a message, the pinned chat stays");
});

test("a new chat open at a reload stays while the subject settles, and follows the next move (12)", async () => {
  const B1 = { kind: "book", id: "b1", title: "One", view: "book-reader" };
  const B2 = { kind: "book", id: "b2", title: "Two", view: "book-reader" };
  const conversations = [
    { id: CHAT, title: "about one", about: [{ kind: "book", id: "b1" }], updatedAt: 5 },
    { id: CHAT2, title: "about two", about: [{ kind: "book", id: "b2" }], updatedAt: 10 },
  ];
  const FRESH = U("NW");
  const h = start({ conversations, stored: FRESH, subject: null, pinned: FRESH });
  await ready(h);
  h.actor.send({ type: "subject.changed", subject: B1 });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, FRESH, "the new chat is still open");
  h.actor.send({ type: "subject.changed", subject: B2 });
  await flush();
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT2, "a real move is followed");
});

test("a focus reload picks up a chat added on another device", async () => {
  const first = { conversations: [{ id: CHAT, title: "one", about: [], updatedAt: 5 }], tools: { tools: {}, approval: "auto" } };
  const second = { conversations: [{ id: CHAT, title: "one", about: [], updatedAt: 5 }, { id: CHAT2, title: "two", about: [], updatedAt: 9 }], tools: { tools: {}, approval: "auto" } };
  const h = start({ listValues: [first, second] });
  await ready(h);
  assert.equal((await query(h.actor, "list", {}, QUERIES.list.reply)).conversations.length, 1);
  h.actor.send({ type: "_focus" });
  await until(() => h.calls.list >= 2, "list reloaded");
  await flush();
  assert.equal((await query(h.actor, "list", {}, QUERIES.list.reply)).conversations.length, 2, "the new chat appears");
});

test("a tool result rides as its size, not its content (4.3)", async () => {
  const chat = { id: CHAT, title: "t", about: [], start: "s", updatedAt: 5, turns: [{ id: USER, role: "user", text: "", results: [{ callId: "c1", content: "HELLO", isError: false }] }] };
  const h = start({ conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5 }], chatsById: { [CHAT]: chat } });
  await ready(h);
  h.actor.send({ type: "conversation.selected", id: CHAT });
  await until(() => changes(h).length > 0, "loaded");
  const result = lastChange(h).turns[0].results[0];
  assert.deepEqual(result, { callId: "c1", size: 5, isError: false }, "content is dropped, size is sent");
  const reply = await query(h.actor, "read", { id: CHAT }, QUERIES.read.reply);
  assert.equal(reply.conversation.turns[0].results[0].content, undefined, "read never carries content either");
  assert.equal(reply.conversation.turns[0].results[0].size, 5);
});

test("a chat's subtitle is its latest answer's first line, as plain text", async () => {
  const chat = { id: CHAT, title: "t", about: [], start: "s", updatedAt: 5, turns: [
    { id: USER, role: "user", text: "q" },
    { id: ANSWER, role: "assistant", text: "\n## Summary\n\n- **Bold** start of `it`\nmore", status: "done" },
    { id: U("X9"), role: "user", text: "q2" },
    { id: ANSWER2, role: "assistant", text: "", status: "failed" },
  ] };
  const h = start({ conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5, answer: "## Heading only" }, { id: CHAT2, title: "u", about: [], updatedAt: 4, answer: "" }], chatsById: { [CHAT]: chat } });
  await ready(h);
  const listed = (await query(h.actor, "list", {}, QUERIES.list.reply)).conversations;
  assert.deepEqual(listed.map((c) => c.subtitle), ["Heading only", ""], "derived from the server's answer; a heading alone still shows");
  h.actor.send({ type: "conversation.selected", id: CHAT });
  await until(() => changes(h).length > 0, "loaded");
  assert.equal(lastChange(h).subtitle, "Bold start of it", "the heading is skipped; an empty later answer falls back to the one before");
  assert.equal((await query(h.actor, "list", {}, QUERIES.list.reply)).conversations[0].subtitle, "Bold start of it");
  assert.equal((await query(h.actor, "read", { id: CHAT }, QUERIES.read.reply)).conversation.subtitle, undefined, "read has no subtitle");
});

test("list?, open? and tools? answer the boot picture", async () => {
  const h = start({ conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5 }], tools: { tools: { "notes: list": false }, approval: "auto" }, stored: CHAT });
  await ready(h);
  assert.equal((await query(h.actor, "list", {}, QUERIES.list.reply)).conversations[0].id, CHAT);
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, CHAT, "the stored open id");
  const t = await query(h.actor, "tools", {}, QUERIES.tools.reply);
  assert.deepEqual(t, { tools: { "notes: list": false }, approval: "auto" });
});

test("read? for an unknown id is an empty new chat", async () => {
  const h = start();
  await ready(h);
  const reply = await query(h.actor, "read", { id: CHAT }, QUERIES.read.reply);
  assert.deepEqual(reply.conversation.turns, []);
  assert.equal(reply.conversation.id, CHAT);
});

test("signed out reads nothing from the server", async () => {
  const h = start({ userId: null });
  await ready(h);
  assert.deepEqual((await query(h.actor, "list", {}, QUERIES.list.reply)).conversations, []);
  assert.equal((await query(h.actor, "open", {}, QUERIES.open.reply)).id, null);
  assert.equal(h.calls.list, 0, "no server call while signed out");
});

test("signing out lets go of the open chat, and signing in again opens it (12)", async () => {
  let who = "u1";
  const h = start({ userId: () => who, conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5 }], stored: CHAT });
  await ready(h);
  const opened = () => h.emitted.filter((e) => e.type === "conversation.opened").map((e) => e.id);
  assert.deepEqual(opened(), [], "the first boot is the starting picture, asked with open");
  who = null;
  h.actor.send({ type: "session.changed", userId: null });
  await ready(h);
  await until(() => opened().length === 1, "signed-out announcement");
  assert.deepEqual(opened(), [null]);
  assert.equal(h.store(), CHAT, "the device keeps which chat was open for the next sign-in");
  who = "u1";
  h.actor.send({ type: "session.changed", userId: "u1" });
  await until(() => opened().length === 2, "signed-in announcement");
  assert.deepEqual(opened(), [null, CHAT]);
});

test("discarding a chat deletes it and announces it gone", async () => {
  const chat = { id: CHAT, title: "t", about: [], start: "s", turns: [], updatedAt: 5 };
  const h = start({ conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5 }], chatsById: { [CHAT]: chat }, stored: CHAT });
  await ready(h);
  h.actor.send({ type: "conversation.discarded", id: CHAT });
  await flush();
  assert.ok(h.emitted.some((e) => e.type === "conversation.deleted" && e.id === CHAT));
  assert.deepEqual(h.calls.deleted, [CHAT]);
  assert.equal((await query(h.actor, "list", {}, QUERIES.list.reply)).conversations.length, 0);
});

test("tools.edited saves the preferences and announces them", async () => {
  const h = start();
  await ready(h);
  h.actor.send({ type: "tools.edited", tools: { "notes: list": false } });
  await flush();
  assert.deepEqual(h.calls.savedTools.at(-1), { tools: { "notes: list": false }, approval: "auto" });
  assert.ok(h.emitted.some((e) => e.type === "tools.changed" && e.tools["notes: list"] === false));
});

// --- the markdown converter (7.7) ---------------------------------------------------

test("toMarkdown turns a chapter's XHTML into plain markdown", () => {
  assert.equal(toMarkdown("<h1>Title</h1>"), "# Title");
  assert.equal(toMarkdown("<h3>Sub</h3>"), "### Sub");
  assert.equal(toMarkdown("<p>One.</p><p>Two.</p>"), "One.\n\nTwo.");
  assert.equal(toMarkdown("<p>A <em>word</em> and <strong>bold</strong>.</p>"), "A *word* and **bold**.");
  assert.equal(toMarkdown("<p>line one<br/>line two</p>"), "line one\nline two");
  assert.equal(toMarkdown("<ul><li>a</li><li>b</li></ul>"), "- a\n\n- b");
  assert.equal(toMarkdown("<ol><li>first</li><li>second</li></ol>"), "1. first\n\n2. second");
  assert.equal(toMarkdown("<blockquote><p>quoted</p></blockquote>"), "> quoted");
  assert.equal(toMarkdown('<p>see <a href="http://x">the link</a> here</p>'), "see the link here", "a link becomes its text");
  assert.equal(toMarkdown('<p><img src="x.png" alt="a cat"/></p>'), "[image: a cat]");
  assert.equal(toMarkdown("<p>Tom &amp; Jerry &#38; &#x26; friends &lt;3</p>"), "Tom & Jerry & & friends <3");
  assert.equal(toMarkdown("<?xml version='1.0'?><p>fragment</p>"), "fragment", "a processing instruction is dropped");
});

// --- the tool loop (7.7) ------------------------------------------------------------

const TOOLS = { queries: [CHAPTER_TOOL, SUBJECT_TOOL] };
// An assistant answer that ends done and asks for one lookup (as `llm` reports it: no
// label; `conversations` adds the label from the catalog).
const callAnswer = (id, call) => ({ type: "completion.progressed", id, text: "", calls: [call], done: true, status: "done", raw: [{ type: "text", text: "" }], provider: "echo", model: "echo", usage: { input_tokens: 1, output_tokens: 1 } });
const chapterCall = (callId) => ({ id: callId, target: "books", name: "chapter", payload: { id: BOOK, chapter: 0 } });
const subjectCall = (callId) => ({ id: callId, target: "subject", name: "read", payload: {} });
const plainAnswer = (id, text) => ({ type: "completion.progressed", id, text, calls: [], done: true, status: "done", raw: [{ type: "text", text }], provider: "echo", model: "echo", usage: { input_tokens: 1, output_tokens: 1 } });
const CHAPTER = "<h1>One</h1><p>A <em>short</em> chapter.</p>";

test("a tool round asks the lookup and feeds its result back to the model (7.7)", async () => {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS, askTool: () => Promise.resolve({ title: "One", html: CHAPTER }) });
  await ready(h);
  submit(h);
  await flush();
  const first = h.calls.completes[0];
  assert.equal(first.tools.length, 2, "the question is asked with the marked tools");
  assert.deepEqual(
    first.tools.map((t) => `${t.target}: ${t.name}`),
    ["books: chapter", "subject: read"],
    "sorted by name so the provider caches a stable order",
  );
  await feed(h, [callAnswer(ANSWER, chapterCall("call-1"))]);
  await until(() => h.calls.completes.length === 2, "the model is asked again with the result");
  assert.deepEqual(h.calls.tools, [{ target: "books", name: "chapter", payload: { id: BOOK, chapter: 0 } }], "the tool query was asked");
  const second = h.calls.completes[1];
  const results = second.turns.find((t) => t.role === "user" && t.results)?.results;
  assert.ok(results && results[0].content.includes("# One"), "the chapter came back as markdown");
  const answerTurn = second.turns.find((t) => t.role === "assistant" && t.calls);
  assert.ok(answerTurn && answerTurn.calls[0].label === "Reading a chapter", "the assistant turn carries the calls, labelled, only when followed by their results");
  await feed(h, [plainAnswer(ANSWER2, "The chapter is titled One.")]);
  assert.equal(lastAssistant(h).status, "done");
  assert.equal(lastAssistant(h).text, "The chapter is titled One.");
});

test("two rounds in a row", async () => {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS, askTool: () => Promise.resolve({ subject: null }) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, [callAnswer(ANSWER, subjectCall("c1"))]);
  await until(() => h.calls.completes.length === 2, "second complete");
  await feed(h, [callAnswer(ANSWER2, subjectCall("c2"))]);
  await until(() => h.calls.completes.length === 3, "third complete");
  const last = h.calls.completes[2];
  assert.equal(last.turns.filter((t) => t.role === "user" && t.results).length, 2, "both rounds' results are sent");
});

test("a call the catalog does not list is rejected, not asked", async () => {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS });
  await ready(h);
  submit(h);
  await flush();
  const unknown = { id: "u1", target: "made", name: "up", payload: {}, invalid: "unknown tool" };
  await feed(h, [callAnswer(ANSWER, unknown)]);
  await until(() => h.calls.completes.length === 2, "the round still runs");
  assert.deepEqual(h.calls.tools, [], "the invalid call was never asked");
  const results = h.calls.completes[1].turns.find((t) => t.results)?.results;
  assert.equal(results[0].isError, true);
  assert.match(results[0].content, /could not be used: unknown tool/);
  const stored = lastChange(h).turns.find((t) => t.role === "assistant" && t.calls);
  assert.equal(stored.calls[0].label, "made: up", "the label is the literal tool name, not a made-up activity");
});

// A tool the user keeps off (7.7) is never offered; a model that asks for it anyway gets
// a call `llm`'s server marks "unknown tool" (its api test), which is refused with an
// error result and never asked.
test("a tool switched off is not offered, and its call is refused", async () => {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS, tools: { tools: { "subject: read": false }, approval: "auto" } });
  await ready(h);
  submit(h);
  await flush();
  assert.deepEqual(h.calls.completes[0].tools.map((t) => `${t.target}: ${t.name}`), ["books: chapter"], "the off tool is not offered");
  await feed(h, [callAnswer(ANSWER, { ...subjectCall("off-1"), invalid: "unknown tool" })]);
  await until(() => h.calls.completes.length === 2, "the round still runs");
  assert.deepEqual(h.calls.tools, [], "the off tool was never asked");
  const results = h.calls.completes[1].turns.find((t) => t.results)?.results;
  assert.equal(results[0].isError, true);
  assert.equal(results[0].content, "This tool could not be used: unknown tool.");
  const stored = lastChange(h).turns.find((t) => t.role === "assistant" && t.calls);
  assert.equal(stored.calls[0].invalid, "unknown tool", "the stored call stays marked, so the thread never names it as a lookup");
});

test("a tool that errors is fed back as an error result", async () => {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS, askTool: () => Promise.resolve({ error: "not-found" }) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, [callAnswer(ANSWER, chapterCall("c1"))]);
  await until(() => h.calls.completes.length === 2, "second complete");
  const results = h.calls.completes[1].turns.find((t) => t.results)?.results;
  assert.equal(results[0].isError, true);
  assert.match(results[0].content, /returned an error: not-found/);
});

test("a result is cut at the guard length (7.7)", async () => {
  const huge = "<p>" + "x".repeat(130000) + "</p>";
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS, askTool: () => Promise.resolve({ title: "Big", html: huge }) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, [callAnswer(ANSWER, chapterCall("c1"))]);
  await until(() => h.calls.completes.length === 2, "second complete");
  const content = h.calls.completes[1].turns.find((t) => t.results).results[0].content;
  assert.ok(content.length <= 120000 + 60, "the content is cut near the guard");
  assert.match(content, /cut off at 120,000 characters/);
});

test("a huge result never bloats what rides the bus (results ride as size, 4.3)", async () => {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS, askTool: () => Promise.resolve({ title: "Big", html: "<p>" + "x".repeat(120000) + "</p>" }) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, [callAnswer(ANSWER, chapterCall("c1"))]);
  await until(() => h.calls.completes.length === 2, "second complete");
  for (const change of changes(h)) assert.ok(JSON.stringify(change).length < 20000, "conversation.changed stays small");
});

test("the round limit stops the chat after too many lookups (7.7)", async () => {
  const h = start({ contracts: TOOLS, askTool: () => Promise.resolve({ subject: null }) });
  await ready(h);
  submit(h);
  await flush();
  for (let i = 0; i < 9; i++) {
    await until(() => h.calls.completes.length >= i + 1, `complete ${i + 1}`);
    await feed(h, [callAnswer(h.calls.completes[i].id, subjectCall(`c${i}`))]);
    await flush();
  }
  await flush();
  assert.equal(h.calls.completes.length, 9, "at most eight rounds of lookups run");
  assert.equal(lastAssistant(h).status, "failed");
  assert.equal(lastAssistant(h).error, "too-many-lookups");
});

test("the round limit is per question, not per chat: many questions each with a lookup all run", async () => {
  // Nine questions in one chat, each answered after a single lookup. The eight-round limit
  // is per question (7.7), so the count resets each question and none fails — the fault the
  // review of session 8 found, where the count spanned the whole chat.
  const h = start({ ids: [], contracts: TOOLS, askTool: () => Promise.resolve({ subject: null }) });
  await ready(h);
  for (let q = 0; q < 9; q++) {
    const before = h.calls.completes.length;
    h.actor.send({ type: "turn.submitted", conversationId: CHAT, turn: { id: U(twoChar(200 + q)), text: "q" }, about: [], start: "s" });
    await until(() => h.calls.completes.length === before + 1, `question ${q} asked`);
    await feed(h, [callAnswer(h.calls.completes[before].id, subjectCall(`q${q}`))]);
    await until(() => h.calls.completes.length === before + 2, `question ${q} round ran`);
    await feed(h, [plainAnswer(h.calls.completes[before + 1].id, `answer ${q}`)]);
    await until(() => lastAssistant(h).status === "done", `question ${q} answered`);
  }
  assert.equal(h.calls.completes.length, 18, "two completes per question across nine questions");
  assert.ok(!lastChange(h).turns.some((t) => t.error === "too-many-lookups"), "no question failed for lookups");
});

test("a plain done answer is replayed to the next question with its own raw (A2)", async () => {
  // A done answer with no calls carries `raw`/provider so the same model replays exactly
  // what it produced and its cache holds; only an answer with unanswered calls is stripped.
  const h = start({ ids: [ANSWER], contracts: { queries: [] } });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, loadFixture("progressed-plain"));
  await until(() => lastAssistant(h).status === "done", "first answer done");
  h.actor.send({ type: "turn.submitted", conversationId: CHAT, turn: { id: U("Y1"), text: "again" } });
  await until(() => h.calls.completes.length === 2, "the second question is asked");
  const prior = h.calls.completes[1].turns.find((t) => t.role === "assistant");
  assert.ok(prior.raw, "the earlier plain answer is replayed with its raw");
  assert.equal(prior.provider, "echo", "and its provider");
  assert.ok(!prior.calls, "it had no calls");
});

test("a done answer whose calls were never run is sent as text alone (A2)", async () => {
  // After a Stop during a lookup a chat rests at a done answer with unrun calls (case b);
  // if the reader types a new question instead of Continue, that answer's tool_use blocks
  // must not be replayed without their results, so its `calls` and `raw` are dropped.
  const chat = {
    id: CHAT, title: "t", about: [], start: "s", updatedAt: 5,
    turns: [
      { id: USER, role: "user", text: "first" },
      { id: ANSWER, role: "assistant", text: "let me look", status: "done", calls: [{ id: "c1", target: "subject", name: "read", payload: {}, label: "Checking what's open" }], raw: [{ type: "text", text: "let me look" }], provider: "echo", model: "echo" },
    ],
  };
  const h = start({ conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5 }], chatsById: { [CHAT]: chat }, contracts: { queries: [] } });
  await ready(h);
  h.actor.send({ type: "conversation.selected", id: CHAT });
  await until(() => changes(h).length > 0, "loaded");
  h.actor.send({ type: "turn.submitted", conversationId: CHAT, turn: { id: U("Y2"), text: "never mind" } });
  await until(() => h.calls.completes.length === 1, "the new question is asked");
  const prior = h.calls.completes[0].turns.find((t) => t.id === ANSWER);
  assert.ok(prior, "the earlier answer is still sent");
  assert.ok(!prior.calls, "but without its unrun calls");
  assert.ok(!prior.raw, "and without its raw (tool_use blocks demand results)");
  assert.equal(prior.text, "let me look");
});

test("Stop during the lookups leaves the answer with its calls for Continue (case b)", async () => {
  // The lookup never replies, so the round is stuck waiting: Stop is conversations' to act
  // on then (llm is not running), and it ends the round rather than the stream (12).
  const h = start({ ids: [ANSWER, ANSWER2], contracts: TOOLS, askTool: () => new Promise(() => {}) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, [callAnswer(ANSWER, chapterCall("c1"))]);
  await flush();
  assert.equal(lastAssistant(h).status, "pending", "the next answer is pending while the lookup runs");
  h.actor.send({ type: "turn.steered", conversationId: CHAT, turnId: ANSWER2, action: "stop" });
  await flush();
  const turns = lastChange(h).turns;
  const last = turns[turns.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.status, "done");
  assert.ok(last.calls && last.calls.length, "the chat rests at the done answer with its unrun calls");
  assert.equal(h.calls.completes.length, 1, "no further round was asked");
});

test("a reload during a round finds the answer with its calls saved (case b)", async () => {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], contracts: TOOLS, askTool: () => Promise.resolve({ subject: null }) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, [callAnswer(ANSWER, subjectCall("c1"))]);
  await until(() => h.calls.saved.some((s) => s.body.turns.some((t) => t.id === ANSWER)), "the done answer is saved");
  const saved = h.calls.saved.flatMap((s) => s.body.turns).find((t) => t.id === ANSWER);
  assert.ok(saved.calls && saved.calls.length, "the saved answer carries its calls, so a reload can Continue");
});

// The seam fixtures sessions 6 and 10 replay into the views (Testing): the exact
// conversation.changed events this machine emits across a whole exchange — the pending
// answer, its arriving text, its end, then the save clearing pending. RECORD=1 rewrites
// them from the machine; otherwise the committed files are checked to still be what it
// emits, so the two sides never drift. A fixed clock keeps the timestamps stable.
async function exchange(fixture) {
  const h = start({ ids: [ANSWER], now: () => 1, onSave: () => Promise.resolve({ updatedAt: 900 }) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, loadFixture(fixture));
  await until(() => h.calls.saved.some((s) => s.body.turns.some((t) => t.id === ANSWER)), "saved");
  await flush();
  await flush();
  return changes(h);
}

test("the recorded conversation.changed exchanges are what the machine emits (seam for sessions 6 and 10)", async () => {
  const runs = [
    ["done", "progressed-plain"],
    ["stopped", "progressed-slow-stopped"],
    ["failed", "progressed-fail"],
  ];
  for (const [name, fixture] of runs) {
    const events = await exchange(fixture);
    const file = resolve(HERE, "fixtures", `changed-${name}.json`);
    if (process.env.RECORD === "1") {
      writeFileSync(file, JSON.stringify(events, null, 2) + "\n");
      continue;
    }
    assert.deepEqual(events, JSON.parse(readFileSync(file, "utf8")), `changed-${name}.json is stale; re-run with RECORD=1`);
  }
});

// A tool-run seam: a whole exchange with one lookup, recorded as the conversation.changed
// events the machine emits, for the views to replay against the same bytes (Testing).
async function toolExchange() {
  const h = start({ ids: [ANSWER, ANSWER2, RESULT1], now: () => 1, onSave: () => Promise.resolve({ updatedAt: 900 }), contracts: TOOLS, askTool: () => Promise.resolve({ title: "One", html: CHAPTER }) });
  await ready(h);
  submit(h);
  await flush();
  await feed(h, [callAnswer(ANSWER, chapterCall("call-1"))]);
  await until(() => h.calls.completes.length === 2, "second complete");
  await feed(h, [plainAnswer(ANSWER2, "The chapter is titled One.")]);
  await until(() => h.calls.saved.some((s) => s.body.turns.some((t) => t.id === ANSWER2)), "final answer saved");
  await flush();
  await flush();
  return changes(h);
}

test("the recorded tool exchange is what the machine emits (seam for the views)", async () => {
  const events = await toolExchange();
  const file = resolve(HERE, "fixtures", "changed-tools.json");
  if (process.env.RECORD === "1") {
    writeFileSync(file, JSON.stringify(events, null, 2) + "\n");
    return;
  }
  assert.deepEqual(events, JSON.parse(readFileSync(file, "utf8")), "changed-tools.json is stale; re-run with RECORD=1");
});

// --- comments on the last answer ---------------------------------------------------

const MARK1 = U("Y1");
const MARK2 = U("Y2");
const mark = (id, start, end, quote, comment) => ({ id, start, end, quote, comment });
const ANSWER_TEXT = "Cats sleep a lot. Dogs bark. Cats purr when happy.";

// A chat loaded from the server whose last turn is a finished answer, ready to comment on.
async function answered(over = {}) {
  const chat = { id: CHAT, title: "t", about: [], start: "s", turns: [{ id: USER, role: "user", text: "q" }, { id: ANSWER2, role: "assistant", text: ANSWER_TEXT, status: "done" }], updatedAt: 5, ...over };
  const h = start({ conversations: [{ id: CHAT, title: "t", about: [], updatedAt: 5 }], chatsById: { [CHAT]: chat }, ids: [ANSWER] });
  await ready(h);
  h.actor.send({ type: "conversation.selected", id: CHAT });
  await until(() => changes(h).length > 0, "loaded");
  return h;
}

test("comments on the last answer are kept and saved; on an older answer they are ignored", async () => {
  const h = await answered();
  const marks = [mark(MARK1, 0, 4, "Cats", "Which cats?")];
  h.actor.send({ type: "marks.edited", conversationId: CHAT, answerId: USER, marks });
  await flush();
  assert.equal(lastChange(h).marks, undefined, "a list for another turn is ignored");
  h.actor.send({ type: "marks.edited", conversationId: CHAT, answerId: ANSWER2, marks });
  await flush();
  assert.deepEqual(lastChange(h).marks, { answerId: ANSWER2, marks });
  assert.equal(lastChange(h).pending, false, "unsent comments do not make the chat pending");
  await until(() => h.calls.saved.some((s) => s.body.marks), "comments saved");
  assert.deepEqual(h.calls.saved.at(-1).body.marks, { answerId: ANSWER2, marks });
  assert.deepEqual(h.calls.saved.at(-1).body.turns, [], "no turn is resent with them");
  h.actor.send({ type: "marks.edited", conversationId: CHAT, answerId: ANSWER2, marks: [] });
  await until(() => h.calls.saved.some((s) => s.body.marks === null), "cleared on the server");
  assert.equal(lastChange(h).marks, undefined, "an empty list removes them");
});

test("sending moves the comments onto the new message and clears them from the chat", async () => {
  const h = await answered();
  const marks = [mark(MARK1, 0, 4, "Cats", "Which cats?")];
  h.actor.send({ type: "marks.edited", conversationId: CHAT, answerId: ANSWER2, marks });
  await flush();
  submit(h, { turn: { id: U("Y3"), text: "" } });
  await flush();
  const change = lastChange(h);
  assert.equal(change.marks, undefined, "the chat holds no unsent comments");
  assert.deepEqual(change.turns.find((t) => t.id === U("Y3")).marks, marks, "the message carries them");
  await until(() => h.calls.saved.some((s) => s.body.turns.some((t) => t.id === U("Y3"))), "message saved");
  const saved = h.calls.saved.find((s) => s.body.turns.some((t) => t.id === U("Y3")));
  assert.deepEqual(saved.body.turns.find((t) => t.id === U("Y3")).marks, marks);
  await until(() => h.calls.saved.some((s) => s.body.marks === null), "cleared on the server");
});

test("Continue drops the unsent comments", async () => {
  const marks = [mark(MARK1, 0, 4, "Cats", "Which cats?")];
  const h = await answered({ turns: [{ id: USER, role: "user", text: "q" }], marks: { answerId: ANSWER2, marks } });
  assert.deepEqual(lastChange(h).marks, { answerId: ANSWER2, marks }, "loaded from the server");
  h.actor.send({ type: "turn.steered", conversationId: CHAT, turnId: USER, action: "continue" });
  await flush();
  assert.equal(lastChange(h).marks, undefined);
  await until(() => h.calls.saved.some((s) => s.body.marks === null), "cleared on the server");
});

test("commentsBlock numbers the comments in reading order, with the sentence only for a repeated quote", () => {
  const block = commentsBlock(ANSWER_TEXT, [mark(MARK2, 29, 33, "Cats", "And these?"), mark(MARK1, 18, 28, "Dogs bark.", "Loudly?")]);
  assert.equal(
    block,
    "<comments_on_your_last_answer>\n" +
      "The user selected passages of your previous answer and commented on them. The\n" +
      "numbers were added by the interface to tie each comment to its passage. They are\n" +
      "not in your answer, you did not write them, and you should not number passages or\n" +
      "add notes like these in your own answers. Answer the comments as part of your reply.\n" +
      "\n" +
      '¹ "Dogs bark."\n' +
      "Comment: Loudly?\n" +
      "\n" +
      '² "Cats"\n' +
      'In: "Cats purr when happy."\n' +
      "Comment: And these?\n" +
      "</comments_on_your_last_answer>",
  );
  assert.equal(commentsBlock(ANSWER_TEXT, []), "");
  const many = Array.from({ length: 12 }, (_, i) => mark(U("Z" + B32[i]), i, i + 1, ANSWER_TEXT[i], "c"));
  assert.match(commentsBlock(ANSWER_TEXT, many), /\n¹² "/, "numbers above 9 are composed");
});

test("forModel sends the comments before the message, the same bytes every time, and leaves the answer alone", () => {
  const marks = [mark(MARK1, 18, 28, "Dogs bark.", "Loudly?")];
  const answer = { id: ANSWER2, role: "assistant", text: ANSWER_TEXT, status: "done", raw: [{ type: "text", text: ANSWER_TEXT }] };
  const turns = [{ id: USER, role: "user", text: "q" }, answer, { id: U("Y3"), role: "user", text: "Also, birds?", marks }];
  const first = forModel(turns);
  assert.equal(first[2].text, commentsBlock(ANSWER_TEXT, marks) + "\n\nAlso, birds?");
  assert.equal(first[2].marks, undefined, "the model gets text only");
  assert.equal(JSON.stringify(forModel(turns)), JSON.stringify(first), "the same bytes on every call");
  assert.equal(first[1].text, ANSWER_TEXT, "the answer is sent as stored");
  assert.deepEqual(first[1].raw, answer.raw);
  const empty = forModel([...turns.slice(0, 2), { id: U("Y3"), role: "user", text: "", marks }]);
  assert.equal(empty[2].text, commentsBlock(ANSWER_TEXT, marks), "an empty message is the block alone");
});

// --- A chat's place in the list (5: last write wins) -------------------------------

const CHAT3 = U("W7");
const heading = (id, updatedAt, over = {}) => ({ id, title: id.slice(-2), about: [], updatedAt, answer: "", ...over });
const listOrder = async (h) => (await query(h.actor, "list", {}, QUERIES.list.reply)).conversations.map((c) => c.id);

test("between makes a key strictly between its neighbours, and chats from before places keep newest first", () => {
  const keys = [between(null, null)];
  for (let i = 0; i < 30; i += 1) keys.unshift(between(null, keys[0]));
  for (let i = 0; i < 30; i += 1) keys.splice(31, 0, between(keys[30], keys[31] ?? null));
  for (let i = 1; i < keys.length; i += 1) assert.ok(keys[i - 1] < keys[i], `${keys[i - 1]} < ${keys[i]}`);
  const old = [heading(CHAT, 500), heading(CHAT2, 600)].map((c) => ({ id: c.id, position: positionOf(c) }));
  assert.deepEqual([...old].sort(byPosition).map((c) => c.id), [CHAT2, CHAT]);
  assert.ok(between(null, old[1].position) < old[1].position);
});

test("a new chat goes first, a message never moves a chat, and a move is saved alone", async () => {
  const h = start({
    conversations: [heading(CHAT, 500), heading(CHAT2, 600)],
    chatsById: { [CHAT]: { id: CHAT, title: "W4", about: [], start: "", turns: [], updatedAt: 500 } },
  });
  await ready(h);
  assert.deepEqual(await listOrder(h), [CHAT2, CHAT]);
  // A message in the older chat: it is written down where it shows, and stays there.
  h.actor.send({ type: "conversation.selected", id: CHAT });
  await until(() => h.calls.reads.includes(CHAT) && changes(h).length > 0, "loaded");
  submit(h);
  await flush();
  await feed(h, loadFixture("progressed-plain"));
  await until(() => h.calls.saved.some((s) => s.body.turns?.some((t) => t.id === ANSWER)), "answer saved");
  await flush();
  assert.deepEqual(await listOrder(h), [CHAT2, CHAT]);
  assert.ok(h.calls.saved[0].body.position.startsWith("z"), "the place it had rides the first save");
  // A new chat goes first.
  submit(h, { conversationId: CHAT3, turn: { id: U("Y7"), text: "new" } });
  await flush();
  assert.deepEqual(await listOrder(h), [CHAT3, CHAT2, CHAT]);
  assert.ok(lastChange(h).position < positionOf(heading(CHAT2, 600)));
  // A move to the end: announced for the chat in memory, saved as its place alone.
  const saves = h.calls.saved.length;
  h.actor.send({ type: "conversation.moved", id: CHAT3, after: CHAT, before: null });
  await until(() => h.calls.saved.length > saves, "move saved");
  assert.deepEqual(await listOrder(h), [CHAT2, CHAT, CHAT3]);
  assert.deepEqual(Object.keys(h.calls.saved.at(-1).body), ["position"]);
  assert.equal(lastChange(h).id, CHAT3);
  // A chat not in memory is moved too, and only listed in its new place.
  h.actor.send({ type: "conversation.moved", id: CHAT2, after: CHAT3, before: null });
  await flush();
  assert.deepEqual(await listOrder(h), [CHAT, CHAT3, CHAT2]);
  assert.equal(h.calls.saved.at(-1).id, CHAT2);
});

test("a delete the corner notice settles removes the chat", async () => {
  const h = start({ conversations: [heading(CHAT, 500)] });
  await ready(h);
  h.actor.send({ type: "removal.settled", kind: "note", id: CHAT });
  await flush();
  assert.deepEqual(h.calls.deleted, [], "another kind is not a chat");
  h.actor.send({ type: "removal.settled", kind: "conversation", id: CHAT });
  await flush();
  assert.deepEqual(h.calls.deleted, [CHAT]);
  assert.equal(h.emitted.at(-1).type, "conversation.deleted");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    // The bus validates an event without its `type` (schemas close the object and
    // never list `type`); replies and payloads carry none. Strip it either way.
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(
      result.valid,
      `${JSON.stringify(value).slice(0, 140)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`,
    );
  }
});
