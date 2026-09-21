import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

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

// Valid ULIDs (^[0-9A-HJKMNP-TV-Z]{26}$). ANSWER equals the id in the progressed-*
// fixtures, so an injected ulid mints that id for the pending answer and the fixtures'
// completion.progressed events route to it.
const U = (s) => "01HQ8ZK7M4N5P6Q7R8S9T0V1" + s;
const ANSWER = U("W2");
const USER = U("W3");
const CHAT = U("W4");
const CHAT2 = U("W5");

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
    listValues,
    now,
  } = options;

  const calls = { saved: [], deleted: [], savedTools: [], completes: [], reads: [], list: 0 };
  let storeValue = stored;
  const idQueue = [...ids];
  let clock = 1000;
  const lists = listValues ? [...listValues] : null;

  const input = {
    session: () => {
      see({}, SESSION_READ.payload);
      return Promise.resolve(userId ? { userId, registrationOpen: true } : { userId: null, registrationOpen: true });
    },
    subject: () => {
      see({}, SUBJECT_READ.payload);
      return Promise.resolve({ subject });
    },
    complete: (request) => {
      see(request, COMPLETE.payload);
      calls.completes.push(request);
      return onComplete(request);
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
    ulid: () => idQueue.shift() || U("Z9"),
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
