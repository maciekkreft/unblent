import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): driven with the children's names the
// view reads from the page.
const start = (views) => createActor(machine, { input: { views } }).start();

test("the first child is open by default", () => {
  const s = start(["a", "b"]).getSnapshot();
  assert.equal(s.value, "ready");
  assert.equal(s.context.open, "a");
});

test("no children means nothing is open", () => {
  assert.equal(start([]).getSnapshot().context.open, null);
});

test("_open switches to a known child", () => {
  const actor = start(["a", "b"]);
  actor.send({ type: "_open", name: "b" });
  assert.equal(actor.getSnapshot().context.open, "b");
});

test("_open ignores a name that is not a child", () => {
  const actor = start(["a", "b"]);
  actor.send({ type: "_open", name: "c" });
  assert.equal(actor.getSnapshot().context.open, "a");
});
