import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with the children's names the view
// reads from the page, and a remembered `shown` from localStorage (3.1).
const start = (items, shown = null, list = "the-list") =>
  createActor(machine, { input: { list, items, shown } }).start();

const NOTES = [{ name: "note-editor", showsOn: "note.selected" }];

test("a matching selection shows the item", () => {
  const a = start(NOTES);
  assert.equal(a.getSnapshot().context.shown, null);
  a.send({ type: "note.selected", id: "x" });
  assert.equal(a.getSnapshot().context.shown, "note-editor");
});

test("a selection no item declares is not handled (6.4)", () => {
  const a = start(NOTES);
  assert.equal(a.getSnapshot().can({ type: "book.selected", id: "x" }), false);
  a.send({ type: "book.selected", id: "x" });
  assert.equal(a.getSnapshot().context.shown, null);
});

test("_back shows the list again", () => {
  const a = start(NOTES);
  a.send({ type: "note.selected" });
  a.send({ type: "_back" });
  assert.equal(a.getSnapshot().context.shown, null);
});

test("_back with the list already shown leaves it shown (Escape on the list is harmless)", () => {
  const a = start(NOTES);
  a.send({ type: "_back" });
  assert.equal(a.getSnapshot().context.shown, null);
});

test("a remembered shown is kept when it names an item, dropped otherwise", () => {
  assert.equal(start(NOTES, "note-editor").getSnapshot().context.shown, "note-editor");
  assert.equal(start(NOTES, "gone").getSnapshot().context.shown, null);
});

test("two items on different gestures each show their own item, and back shows the list", () => {
  const items = [
    { name: "note-editor", showsOn: "note.selected" },
    { name: "highlight-notes", showsOn: "highlights.selected" },
  ];
  const a = start(items);
  a.send({ type: "note.selected", id: "x" });
  assert.equal(a.getSnapshot().context.shown, "note-editor", "a note pick shows the editor");
  a.send({ type: "highlights.selected", about: { kind: "book", id: "bk1" } });
  assert.equal(a.getSnapshot().context.shown, "highlight-notes", "the Highlights pick shows the document");
  a.send({ type: "_back" });
  assert.equal(a.getSnapshot().context.shown, null, "back shows the list");
});

test("two items sharing a gesture: the last one wins", () => {
  const items = [
    { name: "reader", showsOn: "note.selected" },
    { name: "editor", showsOn: "note.selected" },
  ];
  const a = start(items);
  a.send({ type: "note.selected" });
  assert.equal(a.getSnapshot().context.shown, "editor");
});

test("_children keeps a still-present shown and drops one that is gone (3.6)", () => {
  const a = start(NOTES, "note-editor");
  a.send({ type: "_children", list: "the-list", items: [{ name: "note-editor", showsOn: "note.selected" }] });
  assert.equal(a.getSnapshot().context.shown, "note-editor");
  a.send({ type: "_children", list: "the-list", items: [{ name: "other", showsOn: "note.selected" }] });
  assert.equal(a.getSnapshot().context.shown, null);
});

test("the container emits nothing and asks nothing (6.4)", () => {
  assert.deepEqual(machine.config.meta.emits, []);
  assert.deepEqual(machine.config.meta.asks, []);
});

test("a tool pick shows the tool editor, and without one the list stays", () => {
  const a = start([{ name: "rubric-editor", showsOn: "rubric.selected" }]);
  a.send({ type: "rubric.selected", id: "01K6SEED00000000000000RB01" });
  assert.equal(a.getSnapshot().context.shown, "rubric-editor");
  const bare = start([]);
  assert.equal(bare.getSnapshot().can({ type: "rubric.selected", id: "01K6SEED00000000000000RB01" }), false);
});
