import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, addToNote, holdingOf, slipBoxShown } from "../machine.js";

// Add to note on a highlight's bubble: whether it shows, whether it can be pressed and
// why not, and the passage.added it announces. Decisions of the actor, so in Node.

const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HL = "01ARZ3NDEKTSV4RRFFQ69G5H01";
const HL2 = "01ARZ3NDEKTSV4RRFFQ69G5H02";
const NOTE = "01ARZ3NDEKTSV4RRFFQ69G5N01";
const NOTE2 = "01ARZ3NDEKTSV4RRFFQ69G5N02";

const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const PLACE = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } };
const highlight = (id) => ({ id, title: "", about: [{ kind: "book", id: BOOK, place: PLACE, quote: { exact: "Hello", prefix: "", suffix: "" } }] });
const note = (id, held = []) => ({ id, title: "A note", about: held.map((h) => ({ kind: "highlight", id: h })) });

const bookReply = {
  book: { id: BOOK, title: "T", author: "A", chapters: [{ title: "One" }], position: { chapter: 0, block: 0 }, version: 1, contentVersion: 1 },
};

async function open({ notes = [highlight(HL), highlight(HL2)], hidden = [], flags, openNote = null } = {}) {
  const ask = (target, name) => {
    if (target === "flags") return Promise.resolve(flags ?? { off: [], hidden, released: [], shown: [] });
    if (target === "notes" && name === "list") return Promise.resolve({ notes });
    if (target === "notes" && name === "open") return Promise.resolve({ note: openNote });
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "read") return Promise.resolve(bookReply);
    if (name === "chapter") return Promise.resolve({ title: "t", html: "<p>Hello</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask, mint: () => HL, highlighting: true } });
  const added = [];
  actor.on("passage.added", (e) => added.push(e));
  actor.start();
  await flush();
  actor.send({ type: "book.opened", id: BOOK });
  await flush();
  return { actor, added, ctx: () => actor.getSnapshot().context };
}

test("Slip-Box shows only once flags answers and does not hide it", () => {
  assert.equal(slipBoxShown(null), false);
  assert.equal(slipBoxShown(["slip-box"]), false);
  assert.equal(slipBoxShown([]), true);
});

test("holdingOf keeps the passages of every note that holds any", () => {
  assert.deepEqual(holdingOf([note(NOTE, [HL]), note(NOTE2), highlight(HL)]), { [NOTE]: [HL] });
});

test("with Slip-Box hidden, or no flags on the page, the bubble has no Add to note", async () => {
  const hidden = await open({ hidden: ["slip-box"] });
  hidden.actor.send({ type: "note.opened", id: NOTE });
  assert.equal(addToNote(hidden.ctx(), HL), null);
  const none = await open({ flags: { error: "no-answerer" } });
  none.actor.send({ type: "note.opened", id: NOTE });
  assert.equal(addToNote(none.ctx(), HL), null);
  none.actor.send({ type: "_addToNote", id: HL });
  assert.deepEqual(none.added, [], "nothing is announced");
});

test("with no note open it is greyed: Open a note first", async () => {
  const { actor, added, ctx } = await open();
  assert.deepEqual(addToNote(ctx(), HL), { enabled: false, why: "Open a note first" });
  actor.send({ type: "_addToNote", id: HL });
  assert.deepEqual(added, []);
});

test("the note open when the reader starts counts, unless a note.opened came first", async () => {
  const { ctx } = await open({ openNote: note(NOTE) });
  assert.deepEqual(addToNote(ctx(), HL), { enabled: true, why: null });
});

test("a press adds the passage to the open note, and the note's news greys it", async () => {
  const { actor, added, ctx } = await open({ notes: [highlight(HL), highlight(HL2), note(NOTE, [HL2])] });
  actor.send({ type: "note.opened", id: NOTE });
  assert.deepEqual(addToNote(ctx(), HL2), { enabled: false, why: "Already in this note" }, "a passage the note holds");
  assert.deepEqual(addToNote(ctx(), HL), { enabled: true, why: null });
  actor.send({ type: "_addToNote", id: HL });
  assert.deepEqual(added, [{ type: "passage.added", note: NOTE, highlight: HL }]);
  actor.send({ type: "note.changed", ...note(NOTE, [HL2, HL]), body: "", version: 2, pending: false, updatedAt: 1 });
  assert.deepEqual(addToNote(ctx(), HL), { enabled: false, why: "Already in this note" });
  actor.send({ type: "_addToNote", id: HL });
  assert.equal(added.length, 1, "not added twice");
  // Undo takes the link back out: the button can be pressed again.
  actor.send({ type: "note.changed", ...note(NOTE, [HL2]), body: "", version: 3, pending: false, updatedAt: 2 });
  assert.equal(addToNote(ctx(), HL).enabled, true);
});

test("another note opened, or none, follows the panel", async () => {
  const { actor, ctx } = await open({ notes: [highlight(HL), note(NOTE, [HL])] });
  actor.send({ type: "note.opened", id: NOTE });
  assert.equal(addToNote(ctx(), HL).enabled, false);
  actor.send({ type: "note.opened", id: NOTE2 });
  assert.equal(addToNote(ctx(), HL).enabled, true);
  actor.send({ type: "note.opened", id: null });
  assert.equal(addToNote(ctx(), HL).why, "Open a note first");
});

test("a highlight open in the panel is never added to itself", async () => {
  const { actor, added, ctx } = await open();
  actor.send({ type: "note.opened", id: HL });
  assert.equal(addToNote(ctx(), HL).why, "Already in this note");
  actor.send({ type: "_addToNote", id: HL });
  assert.deepEqual(added, []);
});
