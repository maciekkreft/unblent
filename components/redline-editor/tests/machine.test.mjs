import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, parseMarkdown, pieces, trimRange, overlaps, toCriticMarkup, marks, normaliseText } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAVED = JSON.parse(readFileSync(resolve(HERE, "..", "events", "redline.saved.json"), "utf8"));
// The document this app was made to review, read as data: whatever it says, every run
// the parser makes of it must be an exact piece of it.
const ARCHITECTURE = readFileSync(resolve(HERE, "..", "..", "..", "architecture.md"), "utf8");

const FIXTURE = [
  "# Slip-box architecture",
  "",
  "A **component** is a note, *small* and `tested`; see [the bus](#bus).",
  "Second line of the same paragraph.",
  "",
  "> A quote with **bold**",
  "> on two lines",
  "",
  "1. First",
  "2. Second",
  "   - nested *item*",
  "",
  "| Luhmann | Here |",
  "|---|:---:|",
  "| The slip-box | The bus |",
  "| A pointer \\| more | `code` |",
  "",
  "```mermaid",
  "flowchart TB",
  "```",
  "",
  "---",
  "",
  "<div>raw html</div>",
].join("\n");

// Every text run, wherever it sits in the tree.
const runs = (blocks) => {
  const out = [];
  const inline = (nodes) => {
    for (const n of nodes) {
      if (n.type === "text" || n.type === "code") out.push(n);
      if (n.inline) inline(n.inline);
    }
  };
  const walk = (bs) => {
    for (const b of bs) {
      if (b.inline) inline(b.inline);
      if (b.blocks) walk(b.blocks);
      if (b.items) b.items.forEach((item) => walk(item.blocks));
      if (b.type === "code") out.push(...b.lines.filter((l) => l.value));
      if (b.type === "table") [b.head, ...b.rows].flat().forEach(inline);
    }
  };
  walk(blocks);
  return out;
};

test("every text run is the exact piece of the source its offset names", () => {
  for (const source of [FIXTURE, normaliseText(ARCHITECTURE)]) {
    const all = runs(parseMarkdown(source));
    assert.ok(all.length > 10);
    for (const r of all) assert.equal(source.slice(r.s, r.s + r.value.length), r.value, `run at ${r.s}`);
  }
});

test("the blocks are formatted: heading, paragraph, quote, lists, table, code, rule", () => {
  const blocks = parseMarkdown(FIXTURE);
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["heading", "paragraph", "quote", "list", "table", "code", "rule", "paragraph"],
  );
  const [heading, para, , list, table, code, , html] = blocks;
  assert.equal(heading.level, 1);
  assert.deepEqual(
    para.inline.map((n) => n.type),
    ["text", "strong", "text", "em", "text", "code", "text", "text", "text", "break", "text"],
  );
  assert.equal(para.inline[7].value, "the bus", "a link is its text");
  assert.equal(list.ordered, true);
  assert.equal(list.items[1].blocks[1].type, "list", "the indented item nests");
  assert.equal(table.head.length, 2);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][1][0].value, "The bus");
  assert.equal(table.rows[1][0][0].value, "A pointer \\| more", "an escaped bar stays in its cell");
  assert.equal(table.rows[1][1][0].type, "code");
  assert.deepEqual(code.lines.map((l) => l.value), ["flowchart TB"], "a mermaid diagram stays code");
  assert.equal(html.inline[0].value, "<div>raw html</div>", "raw HTML stays text");
});

test("a run is split at the edges of the comments over it", () => {
  // "A book was a path" starting at offset 10; comments cover "book" and "path".
  const ms = [
    { id: "b", start: 12, end: 16 },
    { id: "p", start: 23, end: 40 },
  ];
  assert.deepEqual(pieces("A book was a path", 10, ms), [
    { text: "A ", s: 10, id: null },
    { text: "book", s: 12, id: "b" },
    { text: " was a ", s: 16, id: null },
    { text: "path", s: 23, id: "p" },
  ]);
  assert.deepEqual(pieces("plain", 0, []), [{ text: "plain", s: 0, id: null }]);
});

test("a selection loses the white space at its ends; overlap is refused", () => {
  assert.deepEqual(trimRange("a word here", 1, 7), { start: 2, end: 6 });
  assert.equal(trimRange("a   b", 1, 4), null);
  assert.equal(overlaps([{ start: 5, end: 10 }], 9, 12), true);
  assert.equal(overlaps([{ start: 5, end: 10 }], 10, 12), false);
});

test("the copy is the text with each comment in CriticMarkup, nothing else changed", () => {
  const text = "A book was a path through the box.";
  const comments = [
    { id: "1", start: 2, end: 6, quote: "book", text: "say app" },
    { id: "2", start: 13, end: 17, quote: "path", text: " shorter " },
  ];
  assert.equal(toCriticMarkup(text, comments), "A {==book==}{>>say app<<} was a {==path==}{>>shorter<<} through the box.");
  assert.equal(toCriticMarkup(text, []), text);
});

test("the comment being written is painted in its place among the saved ones", () => {
  const redline = { text: "x", comments: [{ id: "a", start: 0, end: 2, text: "old" }, { id: "c", start: 9, end: 10, text: "" }] };
  assert.deepEqual(marks({ redline, draft: { id: "b", start: 4, end: 6, text: "" } }).map((m) => m.id), ["a", "b", "c"]);
  assert.equal(marks({ redline, draft: { id: "a", start: 0, end: 2, text: "new" } })[0].text, "new");
});

// --- The machine ------------------------------------------------------------------------

const UNDO_MS = 100;
const IDS = ["01ARZ3NDEKTSV4RRFFQ69G5FA0", "01ARZ3NDEKTSV4RRFFQ69G5FA1", "01ARZ3NDEKTSV4RRFFQ69G5FA2"];
const TEXT = "# Title\n\nA book was a path through the box.";
const tick = () => new Promise((r) => setTimeout(r, 0));
const recorded = [];

async function editor(redline = null) {
  const clock = new SimulatedClock();
  let n = 0;
  const actor = createActor(machine, {
    input: { ask: () => Promise.resolve({ redline }), mint: () => IDS[n++], undoMs: UNDO_MS },
    clock,
  });
  const emitted = [];
  actor.on("redline.saved", (e) => {
    emitted.push(e);
    recorded.push(e);
  });
  actor.start();
  await tick();
  return { actor, emitted, clock, state: () => actor.getSnapshot(), ctx: () => actor.getSnapshot().context };
}

const at = (word) => ({ start: TEXT.indexOf(word), end: TEXT.indexOf(word) + word.length });

test("nothing under review: a paste saves the text and shows it", async () => {
  const { actor, emitted, state } = await editor();
  assert.ok(state().matches("empty"));
  actor.send({ type: "_pasted", text: "   \n" });
  assert.equal(emitted.length, 0, "an empty paste is no text");
  actor.send({ type: "_pasted", text: "# T\r\nbody" });
  assert.ok(state().matches("marking"));
  assert.deepEqual(emitted.at(-1), { type: "redline.saved", text: "# T\nbody", comments: [] });
});

test("a selection opens a comment; typing saves it at a throttle, one save per window", async () => {
  const { actor, emitted, clock, state, ctx } = await editor({ text: TEXT, comments: [] });
  actor.send({ type: "_selected", start: at("book").start - 1, end: at("book").end + 1 });
  assert.ok(state().matches({ marking: "commenting" }));
  assert.deepEqual([ctx().draft.start, ctx().draft.end, ctx().draft.quote], [at("book").start, at("book").end, "book"]);
  actor.send({ type: "_typed", text: "s" });
  actor.send({ type: "_typed", text: "sa" });
  actor.send({ type: "_typed", text: "say" });
  assert.equal(emitted.length, 0);
  clock.increment(200);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].comments[0].text, "say");
  assert.equal(emitted[0].comments[0].quote, "book");
  actor.send({ type: "_closed" });
  assert.equal(emitted.length, 1, "closing what was saved saves nothing more");
  assert.ok(state().matches({ marking: "idle" }));
});

test("the first key typed over a selection opens the comment with that key in it", async () => {
  const { actor, emitted, clock } = await editor({ text: TEXT, comments: [] });
  actor.send({ type: "_selected", ...at("path"), text: "W" });
  clock.increment(200);
  assert.equal(emitted.at(-1).comments[0].text, "W");
});

test("a whitespace-only selection, or one over a comment, opens nothing", async () => {
  const comments = [{ id: IDS[2], ...at("book"), quote: "book", text: "x" }];
  const { actor, state } = await editor({ text: TEXT, comments });
  actor.send({ type: "_selected", start: 7, end: 9 });
  assert.ok(state().matches({ marking: "idle" }));
  actor.send({ type: "_selected", start: at("A book").start, end: at("was").end });
  assert.ok(state().matches({ marking: "idle" }), "crosses the comment on book");
});

test("closing an empty comment leaves no comment, and removes one emptied", async () => {
  const comments = [{ id: IDS[2], ...at("book"), quote: "book", text: "x" }];
  const { actor, emitted, ctx } = await editor({ text: TEXT, comments });
  actor.send({ type: "_selected", ...at("path") });
  actor.send({ type: "_closed" });
  assert.equal(emitted.length, 0, "a new empty comment is dropped");
  actor.send({ type: "_opened", id: IDS[2] });
  assert.equal(ctx().draft.text, "x");
  actor.send({ type: "_typed", text: "" });
  actor.send({ type: "_closed" });
  assert.deepEqual(emitted.at(-1).comments, []);
});

test("selecting elsewhere while writing saves the open comment first", async () => {
  const { actor, emitted, ctx } = await editor({ text: TEXT, comments: [] });
  actor.send({ type: "_selected", ...at("book") });
  actor.send({ type: "_typed", text: "one" });
  actor.send({ type: "_selected", ...at("path") });
  assert.equal(emitted.at(-1).comments.length, 1);
  assert.equal(ctx().draft.quote, "path");
});

test("removing a comment waits out the undo window; undo keeps it", async () => {
  const comments = [{ id: IDS[2], ...at("book"), quote: "book", text: "x" }];
  const { actor, emitted, clock, ctx, state } = await editor({ text: TEXT, comments });
  actor.send({ type: "_opened", id: IDS[2] });
  actor.send({ type: "_remove", id: IDS[2] });
  assert.ok(state().matches({ marking: "idle" }), "the popover closes");
  assert.ok(ctx().discarding.has(IDS[2]));
  actor.send({ type: "_opened", id: IDS[2] });
  assert.equal(ctx().discarding.size, 0, "a click on the dimmed mark is the undo");
  clock.increment(UNDO_MS);
  assert.equal(emitted.length, 0);
  actor.send({ type: "_remove", id: IDS[2] });
  clock.increment(UNDO_MS);
  assert.deepEqual(emitted.at(-1).comments, []);
});

test("New text empties the page, and clears the text only when the undo window ends", async () => {
  const { actor, emitted, clock, state } = await editor({ text: TEXT, comments: [] });
  actor.send({ type: "_clear" });
  assert.ok(state().matches("clearing"));
  actor.send({ type: "_undoClear" });
  assert.ok(state().matches("marking"));
  clock.increment(UNDO_MS);
  assert.equal(emitted.length, 0);
  actor.send({ type: "_clear" });
  clock.increment(UNDO_MS);
  assert.ok(state().matches("empty"));
  assert.deepEqual(emitted.at(-1), { type: "redline.saved", text: "", comments: [] });
});

test("another tab's change is followed, and a clear there empties the page", async () => {
  const { actor, state, ctx } = await editor();
  actor.send({ type: "redline.changed", redline: { text: TEXT, comments: [] } });
  assert.ok(state().matches("marking"));
  actor.send({ type: "redline.changed", redline: null });
  assert.ok(state().matches("empty"));
  assert.equal(ctx().redline, null);
});

test("a refused paste is said for a moment", async () => {
  const { actor, clock, state } = await editor();
  actor.send({ type: "_pasteRefused" });
  assert.ok(state().matches({ empty: "refused" }));
  clock.increment(UNDO_MS);
  assert.ok(state().matches({ empty: "idle" }));
});

test("every redline.saved matches its schema", () => {
  assert.ok(recorded.length > 0);
  for (const { type, ...rest } of recorded) {
    const result = new Validator(SAVED, "2020-12").validate(rest);
    assert.ok(result.valid, JSON.stringify(result.errors?.[0]));
  }
});
