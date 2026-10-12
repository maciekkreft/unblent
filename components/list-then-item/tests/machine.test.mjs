import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, drawsBar } from "../machine.js";

// The actor is where decisions live (3.2): driven with the children's names the view
// reads from the page, and a remembered `shown` from localStorage (3.1).
const start = (items, shown = null, list = "the-list", opensOn = null) =>
  createActor(machine, { input: { list, items, shown, opensOn } }).start();

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

// Two levels (the journal's Detectors dock): an outer container whose item is an inner
// one, each its own actor with its own remembered child.
const OUTER = [{ name: "list-then-item#project-detectors", showsOn: "detector-project.selected" }];
const INNER = [{ name: "detector-editor", showsOn: "detector.selected" }];
const PROJECT = { id: "01K7SEED00000000000000JP01" };
const DETECTOR = { id: "01K7SEED00000000000000JD01", project: PROJECT.id };

test("a project pick shows the inner container, and a detector pick shows its editor", () => {
  const outer = start(OUTER, null, "detector-projects");
  const inner = start(INNER, null, "detector-list", "detector-project.selected");
  for (const event of [{ type: "detector-project.selected", ...PROJECT }, { type: "detector.selected", ...DETECTOR }]) {
    outer.send(event);
    inner.send(event);
  }
  assert.equal(outer.getSnapshot().context.shown, "list-then-item#project-detectors", "the outer level stays on the inner container");
  assert.equal(inner.getSnapshot().context.shown, "detector-editor");
  inner.send({ type: "_back" });
  assert.equal(inner.getSnapshot().context.shown, null, "Back from the editor shows the project's detectors");
  outer.send({ type: "_back" });
  assert.equal(outer.getSnapshot().context.shown, null, "Back from the detectors shows the projects");
});

test("picking a project again opens the inner container at its list, not at the detector left open", () => {
  const inner = start(INNER, "detector-editor", "detector-list", "detector-project.selected");
  assert.equal(inner.getSnapshot().context.shown, "detector-editor", "a reload keeps the editor shown");
  inner.send({ type: "detector-project.selected", ...PROJECT });
  assert.equal(inner.getSnapshot().context.shown, null);
});

test("a container's own gesture opens it at its list only when it is nested (opensOn)", () => {
  const top = start(INNER, "detector-editor", "detector-list");
  assert.equal(top.getSnapshot().can({ type: "detector-project.selected", ...PROJECT }), false);
  const item = start([{ name: "book-reader", showsOn: "book.selected" }], null, "book-shelf", "book.selected");
  item.send({ type: "book.selected", id: "x" });
  assert.equal(item.getSnapshot().context.shown, "book-reader", "an item declaring the gesture still wins");
});

test("one Back bar at a time: none on the list, and none while a nested container shows an item", () => {
  assert.equal(drawsBar(null, false), false);
  assert.equal(drawsBar("detector-editor", false), true);
  assert.equal(drawsBar("list-then-item#project-detectors", false), true);
  assert.equal(drawsBar("list-then-item#project-detectors", true), false);
});
