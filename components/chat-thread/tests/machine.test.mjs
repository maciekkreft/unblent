import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(resolve(HERE, "fixtures", `${name}.json`), "utf8"));
// A query schema owned by another component is read from its directory, not imported
// (a component may not import another's files, 11.2).
const other = (component, name) =>
  JSON.parse(readFileSync(resolve(HERE, "..", "..", component, "queries", `${name}.json`), "utf8"));
const OPEN = other("conversations", "open");
const READ = other("conversations", "read");

const CHAT = "01HQ8ZK7M4N5P6Q7R8S9T0V1W4";
const CHAT2 = "01HQ8ZK7M4N5P6Q7R8S9T0V1W5";

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(pred, label = "condition") {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await flush();
  }
  throw new Error(`${label} never met`);
}

// Every query payload the machine asks, with the schema it must satisfy (shape test).
const recorded = [];
const see = (value, schema) => recorded.push({ value, schema });

function start(options = {}) {
  const { openId = null, chatsById = {}, readError = {} } = options;
  const input = {
    ask: (target, name, payload) => {
      const key = `${target}: ${name}`;
      if (key === "conversations: open") {
        see(payload, OPEN.payload);
        return Promise.resolve({ id: openId });
      }
      if (key === "conversations: read") {
        see(payload, READ.payload);
        if (readError[payload.id]) return Promise.resolve({ error: readError[payload.id] });
        const conversation = chatsById[payload.id];
        return Promise.resolve(conversation ? { conversation } : { error: "not-found" });
      }
      throw new Error(`unexpected ask ${key}`);
    },
  };
  const actor = createActor(machine, { input });
  actor.start();
  return { actor };
}

const state = (h) => h.actor.getSnapshot().value;
const conv = (h) => h.actor.getSnapshot().context.conversation;
const emptyChat = (id, over = {}) => ({ id, title: "", about: [], start: "", turns: [], pending: false, updatedAt: 0, ...over });

test("no chat open lands on the empty page", async () => {
  const h = start({ openId: null });
  await until(() => state(h) === "empty", "empty");
  assert.equal(conv(h), null);
});

test("an open chat is read and shown", async () => {
  const chat = emptyChat(CHAT, { title: "hi", turns: [{ id: "01HQ8ZK7M4N5P6Q7R8S9T0V1W3", role: "user", text: "hi" }] });
  const h = start({ openId: CHAT, chatsById: { [CHAT]: chat } });
  await until(() => state(h) === "showing", "showing");
  assert.equal(conv(h).title, "hi");
  assert.equal(conv(h).turns.length, 1);
});

test("conversation.changed for the open chat is adopted whole", async () => {
  const h = start({ openId: CHAT, chatsById: { [CHAT]: emptyChat(CHAT) } });
  await until(() => state(h) === "showing", "showing");
  const [, , third] = loadFixture("changed-done"); // one with streaming text
  h.actor.send(third);
  await flush();
  assert.equal(conv(h).turns.at(-1).text, "A plain answ");
});

test("a change for another chat is ignored", async () => {
  const h = start({ openId: CHAT, chatsById: { [CHAT]: emptyChat(CHAT, { title: "mine" }) } });
  await until(() => state(h) === "showing", "showing");
  h.actor.send({ type: "conversation.changed", id: CHAT2, title: "other", about: [], start: "", turns: [], pending: false, updatedAt: 1 });
  await flush();
  assert.equal(conv(h).title, "mine", "the other chat's change did not overwrite the open one");
});

test("conversation.opened switches to the new chat, and to the empty page for null", async () => {
  const h = start({ openId: CHAT, chatsById: { [CHAT]: emptyChat(CHAT, { title: "first" }), [CHAT2]: emptyChat(CHAT2, { title: "second" }) } });
  await until(() => state(h) === "showing", "showing");
  h.actor.send({ type: "conversation.opened", id: CHAT2 });
  await until(() => conv(h)?.title === "second", "second loaded");
  h.actor.send({ type: "conversation.opened", id: null });
  await until(() => state(h) === "empty", "empty");
  assert.equal(conv(h), null);
});

test("the open chat deleted falls back to the empty page", async () => {
  const h = start({ openId: CHAT, chatsById: { [CHAT]: emptyChat(CHAT) } });
  await until(() => state(h) === "showing", "showing");
  h.actor.send({ type: "conversation.deleted", id: CHAT });
  await until(() => state(h) === "empty", "empty");
});

test("an unavailable read says the server cannot be reached", async () => {
  const h = start({ openId: CHAT, readError: { [CHAT]: "unavailable" } });
  await until(() => state(h) === "unavailable", "unavailable");
});

test("a chat the server has no record of is an empty page", async () => {
  const h = start({ openId: CHAT, chatsById: {} });
  await until(() => state(h) === "empty", "empty");
});

// The seam fixtures recorded by conversations (Testing): the exact conversation.changed
// events of a whole exchange. Feeding the final one, the thread shows the finished turn.
test("the recorded exchanges end in a done, stopped and failed turn (replayed seam fixtures)", async () => {
  for (const [name, status] of [["done", "done"], ["stopped", "stopped"], ["failed", "failed"]]) {
    const h = start({ openId: CHAT, chatsById: { [CHAT]: emptyChat(CHAT) } });
    await until(() => state(h) === "showing", "showing");
    for (const event of loadFixture(`changed-${name}`)) {
      h.actor.send(event);
      await flush();
    }
    assert.equal(conv(h).turns.at(-1).status, status, `changed-${name} ends ${status}`);
  }
});

// The tool-run seam: replaying the whole exchange, the open chat ends with a done answer
// that carries the labelled lookup, which the view renders as a dim line (7.7).
test("a tool exchange leaves the answer carrying its labelled lookup", async () => {
  const h = start({ openId: CHAT, chatsById: { [CHAT]: emptyChat(CHAT) } });
  await until(() => state(h) === "showing", "showing");
  for (const event of loadFixture("changed-tools")) {
    h.actor.send(event);
    await flush();
  }
  const withCalls = conv(h).turns.find((t) => t.role === "assistant" && t.calls);
  assert.ok(withCalls, "the answer that asked for a lookup is kept");
  assert.equal(withCalls.calls[0].label, "Reading a chapter");
  assert.equal(conv(h).turns.at(-1).status, "done");
});

test("every query payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const result = new Validator(schema, "2020-12").validate(value);
    assert.ok(result.valid, `${JSON.stringify(value)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
