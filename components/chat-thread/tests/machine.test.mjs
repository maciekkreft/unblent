import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, parseMarkdown } from "../machine.js";

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

// The markdown renderer (10). It returns only data — text runs stay text — so the view
// can draw each run as an escaped node and no model markup becomes HTML.
const inlineText = (nodes) =>
  nodes.map((n) => (n.type === "text" ? n.value : n.type === "code" ? n.value : n.inline ? inlineText(n.inline) : "")).join("");

test("a heading becomes a heading block with its level and inline text", () => {
  const [block] = parseMarkdown("## The Argument");
  assert.equal(block.type, "heading");
  assert.equal(block.level, 2);
  assert.equal(inlineText(block.inline), "The Argument");
});

test("bold, italic and inline code parse as their own runs", () => {
  const [para] = parseMarkdown("A **bold** and *italic* word with `code`.");
  const types = para.inline.map((n) => n.type);
  assert.deepEqual(new Set(types.filter((t) => t !== "text")), new Set(["strong", "em", "code"]));
  assert.equal(para.inline.find((n) => n.type === "strong").inline[0].value, "bold");
  assert.equal(para.inline.find((n) => n.type === "code").value, "code");
});

test("a bulleted list and a numbered list keep their order flag and items", () => {
  const [ul] = parseMarkdown("- one\n- two");
  assert.equal(ul.type, "list");
  assert.equal(ul.ordered, false);
  assert.deepEqual(ul.items.map((i) => inlineText(i.blocks[0].inline)), ["one", "two"]);
  const [ol] = parseMarkdown("1. first\n2. second");
  assert.equal(ol.ordered, true);
  assert.equal(ol.items.length, 2);
});

test("an indented item nests under the item above it", () => {
  const [list] = parseMarkdown("- top\n  - nested");
  assert.equal(list.items.length, 1);
  const child = list.items[0].blocks.find((b) => b.type === "list");
  assert.ok(child, "the indented item became a nested list");
  assert.equal(inlineText(child.items[0].blocks[0].inline), "nested");
});

test("a blockquote holds its own blocks", () => {
  const [quote] = parseMarkdown("> quoted line");
  assert.equal(quote.type, "quote");
  assert.equal(inlineText(quote.blocks[0].inline), "quoted line");
});

test("a fenced code block keeps its text literally, without inline parsing", () => {
  const [code] = parseMarkdown("```\nlet x = **not bold**\n```");
  assert.equal(code.type, "code");
  assert.equal(code.text, "let x = **not bold**");
});

test("a link becomes its text alone", () => {
  const [para] = parseMarkdown("See [the chapter](https://example.com/x) here.");
  assert.equal(para.inline.some((n) => n.type !== "text" && n.type !== "break"), false, "no non-text run");
  assert.equal(inlineText(para.inline), "See the chapter here.");
});

test("a soft line break inside a paragraph becomes a hard break run", () => {
  const [para] = parseMarkdown("line one\nline two");
  assert.ok(para.inline.some((n) => n.type === "break"), "the newline is a break run");
  assert.equal(inlineText(para.inline), "line oneline two");
});

test("markup the model cannot control stays plain text (no HTML leaks)", () => {
  // Angle brackets and stray markers are text runs, never element nodes; the view escapes
  // them (10). A lone or spaced marker is not emphasis.
  const [para] = parseMarkdown("a <script>alert(1)</script> tag and a * b = c and snake_case");
  assert.ok(para.inline.every((n) => n.type === "text"), "every run is plain text");
  assert.equal(inlineText(para.inline), "a <script>alert(1)</script> tag and a * b = c and snake_case");
});

test("every query payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const result = new Validator(schema, "2020-12").validate(value);
    assert.ok(result.valid, `${JSON.stringify(value)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
