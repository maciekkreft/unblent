import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, canPin, parseMarkdown, userParagraphs } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(resolve(HERE, "fixtures", `${name}.json`), "utf8"));
// A query schema owned by another component is read from its directory, not imported
// (a component may not import another's files, 11.2).
const other = (component, name) =>
  JSON.parse(readFileSync(resolve(HERE, "..", "..", component, "queries", `${name}.json`), "utf8"));
const OPEN = other("conversations", "open");
const READ = other("conversations", "read");
const PIN_TOGGLED = JSON.parse(readFileSync(resolve(HERE, "..", "events", "pin.toggled.json"), "utf8"));

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
  const { openId = null, chatsById = {}, readError = {}, pinned = null } = options;
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
      if (key === "pins: read") return Promise.resolve({ note: null, chat: pinned, evaluators: null });
      throw new Error(`unexpected ask ${key}`);
    },
  };
  const actor = createActor(machine, { input });
  const toggled = [];
  actor.on("pin.toggled", (e) => {
    toggled.push(e.id);
    see({ what: e.what, id: e.id }, PIN_TOGGLED);
  });
  actor.start();
  return { actor, toggled };
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

const TURN = { id: "01HQ8ZK7M4N5P6Q7R8S9T0V1W3", role: "user", text: "hi" };
const asked = (id) => emptyChat(id, { title: "hi", turns: [TURN] });

test("the pin pins the open chat and unpins it; with no chat open it does nothing", async () => {
  const h = start({ openId: CHAT, chatsById: { [CHAT]: asked(CHAT) } });
  await until(() => state(h) === "showing", "showing");
  h.actor.send({ type: "_togglePin" });
  assert.equal(h.actor.getSnapshot().context.pin, CHAT);
  h.actor.send({ type: "_togglePin" });
  assert.deepEqual(h.toggled, [CHAT, null]);
  h.actor.send({ type: "conversation.opened", id: null });
  await until(() => state(h) === "empty", "empty");
  assert.equal(h.actor.getSnapshot().can({ type: "_togglePin" }), false);
});

test("a chat with no message yet cannot be pinned, even while pins holds it; its first message makes it pinned", async () => {
  const h = start({ openId: CHAT, pinned: CHAT, chatsById: { [CHAT]: emptyChat(CHAT) } });
  await until(() => state(h) === "showing", "showing");
  assert.equal(canPin(h.actor.getSnapshot().context), false);
  assert.equal(h.actor.getSnapshot().can({ type: "_togglePin" }), false);
  h.actor.send({ type: "conversation.changed", ...asked(CHAT) });
  assert.equal(canPin(h.actor.getSnapshot().context), true);
  assert.equal(h.actor.getSnapshot().context.pin, CHAT, "on by default once it has a message");
  assert.deepEqual(h.toggled, [], "no press, so nothing was sent");
});

test("opening or deleting the pinned chat sends no pin.toggled: only a press does, and pins follows the chat itself", async () => {
  const h = start({ openId: CHAT, pinned: CHAT, chatsById: { [CHAT]: emptyChat(CHAT), [CHAT2]: emptyChat(CHAT2) } });
  await until(() => state(h) === "showing", "showing");
  assert.equal(h.actor.getSnapshot().context.pin, CHAT, "the pin from pins");
  h.actor.send({ type: "conversation.opened", id: CHAT2 });
  await until(() => state(h) === "showing", "showing");
  h.actor.send({ type: "conversation.deleted", id: CHAT2 });
  assert.deepEqual(h.toggled, []);
});

test("opening another chat while not pinned leaves the pins alone", async () => {
  const h = start({ openId: CHAT, pinned: CHAT2, chatsById: { [CHAT]: emptyChat(CHAT), [CHAT2]: emptyChat(CHAT2) } });
  await until(() => state(h) === "showing", "showing");
  h.actor.send({ type: "conversation.opened", id: CHAT2 });
  h.actor.send({ type: "pins.changed", note: null, chat: null, evaluators: null });
  h.actor.send({ type: "conversation.opened", id: CHAT });
  assert.deepEqual(h.toggled, []);
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

test("numbered points spaced apart by blank lines stay one list", () => {
  const blocks = parseMarkdown("Intro:\n\n1. first\n\n2. second\n\n3. third\n\nAfter.");
  assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "list", "paragraph"]);
  assert.equal(blocks[1].items.length, 3);
  assert.equal(blocks[1].start, 1);
});

test("a numbered list keeps the number it starts at", () => {
  const [list] = parseMarkdown("3. third\n4. fourth");
  assert.equal(list.start, 3);
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

test("a user message splits into paragraphs on blank lines, one gap per blank line", () => {
  assert.deepEqual(userParagraphs("one"), ["one"]);
  assert.deepEqual(userParagraphs("one\ntwo"), ["one\ntwo"], "a single line break stays inside the paragraph");
  assert.deepEqual(userParagraphs("one\n\ntwo\nthree"), ["one", "", "two\nthree"]);
  assert.deepEqual(userParagraphs("one\n\n\ntwo"), ["one", "", "", "two"], "extra blank lines are extra space");
  assert.deepEqual(userParagraphs("\n\none\r\n\r\ntwo\n\n"), ["one", "", "two"], "ends trimmed, CRLF read as LF");
  assert.deepEqual(userParagraphs("<b>x</b>"), ["<b>x</b>"], "text stays text");
});
