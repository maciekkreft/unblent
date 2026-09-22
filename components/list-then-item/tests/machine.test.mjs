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

test("a remembered shown is kept when it names an item, dropped otherwise", () => {
  assert.equal(start(NOTES, "note-editor").getSnapshot().context.shown, "note-editor");
  assert.equal(start(NOTES, "gone").getSnapshot().context.shown, null);
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
