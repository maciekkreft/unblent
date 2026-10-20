import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, canPin, parseMarkdown, userParagraphs, pieces, trimRange, overlaps, lastAnswer, marks } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(resolve(HERE, "fixtures", `${name}.json`), "utf8"));
// A query schema owned by another component is read from its directory, not imported
// (a component may not import another's files, 11.2).
const other = (component, name) =>
  JSON.parse(readFileSync(resolve(HERE, "..", "..", component, "queries", `${name}.json`), "utf8"));
const OPEN = other("conversations", "open");
const READ = other("conversations", "read");
const PIN_TOGGLED = JSON.parse(readFileSync(resolve(HERE, "..", "events", "pin.toggled.json"), "utf8"));
const MARKS_EDITED = JSON.parse(readFileSync(resolve(HERE, "..", "events", "marks.edited.json"), "utf8"));

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

// The top state only: showing has substates of its own (the comment being written).
const state = (h) => {
  const value = h.actor.getSnapshot().value;
  return typeof value === "string" ? value : Object.keys(value)[0];
};
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
  assert.deepEqual(code.lines.map((l) => l.value), ["let x = **not bold**"]);
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

test("a user message splits into paragraphs on blank lines, one gap per blank line", () => {
  assert.deepEqual(userParagraphs("one"), ["one"]);
  assert.deepEqual(userParagraphs("one\ntwo"), ["one\ntwo"], "a single line break stays inside the paragraph");
  assert.deepEqual(userParagraphs("one\n\ntwo\nthree"), ["one", "", "two\nthree"]);
  assert.deepEqual(userParagraphs("one\n\n\ntwo"), ["one", "", "", "two"], "extra blank lines are extra space");
  assert.deepEqual(userParagraphs("\n\none\r\n\r\ntwo\n\n"), ["one", "", "two"], "ends trimmed, CRLF read as LF");
  assert.deepEqual(userParagraphs("<b>x</b>"), ["<b>x</b>"], "text stays text");
});

test("every text run is the exact piece of the answer its offset names", () => {
  const source = "# Title\r\n\r\nA **bold** and *em* with `code`; [a link](x).\nSecond line.\n\n> quoted\n\n1. one\n   - two\n\n| a | b |\n|---|---|\n| c | `d` |\n\n```\ncode\n```\n\n---";
  const all = [];
  const inline = (nodes) => nodes.forEach((n) => (n.type === "text" || n.type === "code" ? all.push(n) : n.inline && inline(n.inline)));
  const walk = (bs) =>
    bs.forEach((b) => {
      if (b.inline) inline(b.inline);
      if (b.blocks) walk(b.blocks);
      if (b.items) b.items.forEach((item) => walk(item.blocks));
      if (b.type === "code") all.push(...b.lines);
      if (b.type === "table") [b.head, ...b.rows].flat().forEach(inline);
    });
  const blocks = parseMarkdown(source);
  walk(blocks);
  assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "quote", "list", "table", "code", "rule"]);
  assert.ok(all.length > 10);
  for (const r of all) assert.equal(source.slice(r.s, r.s + r.value.length), r.value, `run at ${r.s}`);
});

test("a run is split at the edges of the comments; a selection loses its white space", () => {
  assert.deepEqual(pieces("A book was", 10, [{ id: "b", start: 12, end: 16 }]), [
    { text: "A ", s: 10, id: null },
    { text: "book", s: 12, id: "b" },
    { text: " was", s: 16, id: null },
  ]);
  assert.deepEqual(trimRange("a word here", 1, 7), { start: 2, end: 6 });
  assert.equal(trimRange("a   b", 1, 4), null);
  assert.equal(overlaps([{ start: 5, end: 10 }], 9, 12), true);
  assert.equal(overlaps([{ start: 5, end: 10 }], 10, 12), false);
});

// --- Comments on the last answer ---------------------------------------------------------

const UNDO_MS = 100;
const IDS = ["01ARZ3NDEKTSV4RRFFQ69G5FA0", "01ARZ3NDEKTSV4RRFFQ69G5FA1", "01ARZ3NDEKTSV4RRFFQ69G5FA2"];
const ANSWER_TEXT = "# Title\n\nA book was a path through the box.";
const ASK = { id: "01HQ8ZK7M4N5P6Q7R8S9T0V1Q1", role: "user", text: "tell me" };
const ANSWER = { id: "01HQ8ZK7M4N5P6Q7R8S9T0V1A1", role: "assistant", text: ANSWER_TEXT, status: "done" };
const at = (word) => ({ start: ANSWER_TEXT.indexOf(word), end: ANSWER_TEXT.indexOf(word) + word.length });
const SAVED = { id: IDS[2], ...at("book"), quote: "book", comment: "x" };
const answered = (over = {}) => emptyChat(CHAT, { title: "tell me", turns: [ASK, ANSWER], ...over });

async function commenting(chat = answered(), more = {}) {
  const clock = new SimulatedClock();
  let n = 0;
  const actor = createActor(machine, {
    input: {
      ask: (target, name) => {
        if (target === "pins") return Promise.resolve({ note: null, chat: null, evaluators: null });
        if (name === "open") return Promise.resolve({ id: CHAT });
        return Promise.resolve({ conversation: chat, ...more });
      },
      mint: () => IDS[n++],
      undoMs: UNDO_MS,
    },
    clock,
  });
  const emitted = [];
  actor.on("marks.edited", (e) => {
    emitted.push(e);
    const { type, ...rest } = e;
    see(rest, MARKS_EDITED);
  });
  actor.start();
  await until(() => actor.getSnapshot().matches("showing"), "showing");
  return { actor, emitted, clock, state: () => actor.getSnapshot(), ctx: () => actor.getSnapshot().context };
}

test("only a finished last answer with text and no lookups takes comments", () => {
  assert.equal(lastAnswer(answered())?.id, ANSWER.id);
  assert.equal(lastAnswer(answered({ turns: [ASK, { ...ANSWER, status: "pending" }] })), null, "still arriving");
  assert.equal(lastAnswer(answered({ turns: [ASK, { ...ANSWER, calls: [{ callId: "c", name: "x", input: {} }] }] })), null);
  assert.equal(lastAnswer(answered({ turns: [ASK, ANSWER, ASK] })), null, "a question after it");
  assert.equal(lastAnswer(answered({ turns: [ASK, { ...ANSWER, status: "failed" }] })), null);
});

test("a selection opens a comment; typing saves the whole list at a throttle", async () => {
  const { actor, emitted, clock, state, ctx } = await commenting();
  actor.send({ type: "_selected", start: at("book").start - 1, end: at("book").end + 1 });
  assert.ok(state().matches({ showing: "commenting" }));
  assert.deepEqual([ctx().draft.start, ctx().draft.end, ctx().draft.quote], [at("book").start, at("book").end, "book"]);
  actor.send({ type: "_typed", text: "s" });
  actor.send({ type: "_typed", text: "sa" });
  actor.send({ type: "_typed", text: "say" });
  assert.equal(emitted.length, 0);
  clock.increment(200);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], {
    type: "marks.edited",
    conversationId: CHAT,
    answerId: ANSWER.id,
    marks: [{ id: IDS[0], ...at("book"), quote: "book", comment: "say" }],
  });
  assert.deepEqual(ctx().conversation.marks, { answerId: ANSWER.id, marks: emitted[0].marks }, "shown at once, before the echo");
  actor.send({ type: "_closed" });
  assert.equal(emitted.length, 1, "closing what was saved saves nothing more");
  assert.ok(state().matches({ showing: "idle" }));
});

test("the first key typed over a selection opens the comment with that key in it", async () => {
  const { actor, emitted, clock } = await commenting();
  actor.send({ type: "_selected", ...at("path"), text: "W" });
  clock.increment(200);
  assert.equal(emitted.at(-1).marks[0].comment, "W");
});

test("a white-space selection, one over a comment, or one on an answer still arriving opens nothing", async () => {
  const { actor, state } = await commenting(answered({ marks: { answerId: ANSWER.id, marks: [SAVED] } }));
  actor.send({ type: "_selected", start: 7, end: 9 });
  assert.ok(state().matches({ showing: "idle" }));
  actor.send({ type: "_selected", start: at("A book").start, end: at("was").end });
  assert.ok(state().matches({ showing: "idle" }), "crosses the comment on book");
  const arriving = await commenting(answered({ turns: [ASK, { ...ANSWER, status: "pending" }] }));
  arriving.actor.send({ type: "_selected", ...at("path") });
  assert.ok(arriving.state().matches({ showing: "idle" }));
});

test("comments kept for an earlier answer are not shown on the last one", async () => {
  const { ctx } = await commenting(answered({ marks: { answerId: ASK.id, marks: [SAVED] } }));
  assert.deepEqual(marks(ctx()), []);
});

test("closing an empty comment leaves no comment, and removes one emptied", async () => {
  const { actor, emitted, ctx } = await commenting(answered({ marks: { answerId: ANSWER.id, marks: [SAVED] } }));
  actor.send({ type: "_selected", ...at("path") });
  actor.send({ type: "_closed" });
  assert.equal(emitted.length, 0, "a new empty comment is dropped");
  actor.send({ type: "_opened", id: SAVED.id });
  assert.equal(ctx().draft.comment, "x");
  actor.send({ type: "_typed", text: "" });
  actor.send({ type: "_closed" });
  assert.deepEqual(emitted.at(-1).marks, []);
  assert.equal("marks" in ctx().conversation, false, "no comments, no marks on the chat");
});

test("selecting elsewhere while writing saves the open comment first", async () => {
  const { actor, emitted, ctx } = await commenting();
  actor.send({ type: "_selected", ...at("book") });
  actor.send({ type: "_typed", text: "one" });
  actor.send({ type: "_selected", ...at("path") });
  assert.equal(emitted.at(-1).marks.length, 1);
  assert.equal(ctx().draft.quote, "path");
});

test("removing a comment takes it off the saved list at once; undo puts it back", async () => {
  const { actor, emitted, clock, ctx, state } = await commenting(answered({ marks: { answerId: ANSWER.id, marks: [SAVED] } }));
  actor.send({ type: "_opened", id: SAVED.id });
  actor.send({ type: "_remove", id: SAVED.id });
  assert.ok(state().matches({ showing: "idle" }), "the box closes");
  assert.ok(ctx().discarding.has(SAVED.id), "it stays dimmed for the undo window");
  assert.deepEqual(emitted.at(-1).marks, [], "a message sent now does not carry it");
  actor.send({ type: "_undo", id: SAVED.id });
  assert.equal(ctx().discarding.size, 0);
  assert.deepEqual(emitted.at(-1).marks, [SAVED]);
  const count = emitted.length;
  actor.send({ type: "_remove", id: SAVED.id });
  clock.increment(UNDO_MS);
  assert.equal(ctx().discarding.size, 0, "the window ends");
  assert.equal(emitted.length, count + 1, "nothing more is sent when it ends");
  actor.send({ type: "_undo", id: SAVED.id });
  assert.equal(emitted.length, count + 1, "too late to undo");
});

test("a new last answer drops the comment being written", async () => {
  const { actor, state, ctx } = await commenting();
  actor.send({ type: "_selected", ...at("book") });
  actor.send({ type: "_typed", text: "half" });
  const next = { ...ANSWER, id: "01HQ8ZK7M4N5P6Q7R8S9T0V1A2", status: "pending", text: "" };
  actor.send({ type: "conversation.changed", ...answered({ turns: [ASK, ANSWER, ASK, next] }) });
  assert.ok(state().matches({ showing: "idle" }));
  assert.equal(ctx().draft, null);
});

test("opening another chat saves the comment being written and carries out a waiting removal", async () => {
  const other = { id: IDS[1], ...at("path"), quote: "path", comment: "y" };
  const { actor, emitted } = await commenting(answered({ marks: { answerId: ANSWER.id, marks: [SAVED, other] } }));
  actor.send({ type: "_remove", id: SAVED.id });
  actor.send({ type: "_opened", id: other.id });
  actor.send({ type: "_typed", text: "yes" });
  actor.send({ type: "conversation.opened", id: CHAT2 });
  assert.deepEqual(emitted.at(-1).marks, [{ ...other, comment: "yes" }]);
});

test("every query payload and marks.edited matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const result = new Validator(schema, "2020-12").validate(value);
    assert.ok(result.valid, `${JSON.stringify(value)} against ${schema.description ?? "schema"}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
