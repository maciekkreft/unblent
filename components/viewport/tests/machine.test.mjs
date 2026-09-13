import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2), so it is tested directly, with the
// environment faked: a stored value, apply that records, save that records.
function start(stored) {
  const applied = [];
  const saved = [];
  const emitted = [];
  const actor = createActor(machine, {
    input: { stored, apply: (v) => applied.push(v), save: (v) => saved.push(v) },
  });
  actor.on("viewport.changed", (e) => emitted.push(e));
  actor.start();
  return { actor, applied, saved, emitted };
}

test("applies the stored viewport on start, without emitting", () => {
  const { applied, emitted } = start(null);
  assert.deepEqual(applied, ["desk"]);
  assert.deepEqual(emitted, []);
});

test("a stored phone is honoured; anything unknown is desk", () => {
  assert.deepEqual(start("phone").applied, ["phone"]);
  assert.deepEqual(start("nonsense").applied, ["desk"]);
});

test("a selection applies, saves, and emits once", () => {
  const { actor, applied, saved, emitted } = start(null);
  actor.send({ type: "viewport.selected", viewport: "phone" });
  assert.deepEqual(applied, ["desk", "phone"]);
  assert.deepEqual(saved, ["phone"]);
  assert.deepEqual(emitted, [{ type: "viewport.changed", viewport: "phone" }]);
});

test("selecting the current viewport does nothing", () => {
  const { actor, applied, saved, emitted } = start(null);
  actor.send({ type: "viewport.selected", viewport: "desk" });
  assert.deepEqual(applied, ["desk"]);
  assert.deepEqual(saved, []);
  assert.deepEqual(emitted, []);
});

test("an unknown viewport is ignored", () => {
  const { actor, applied, saved, emitted } = start(null);
  actor.send({ type: "viewport.selected", viewport: "watch" });
  assert.deepEqual(applied, ["desk"]);
  assert.deepEqual(saved, []);
  assert.deepEqual(emitted, []);
});

test("read replies the current viewport", () => {
  const { actor } = start("phone");
  let reply;
  actor.send({ type: "read?", cid: "x", payload: {}, reply: (v) => (reply = v) });
  assert.deepEqual(reply, { viewport: "phone" });
});
