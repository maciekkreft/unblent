import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, keyOf } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const STEP = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", label: "remove value Courage" };

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, defaultPrevented: false, ...mods });

test("Cmd or Ctrl with Z undoes, with Shift redoes, whatever the Vim keys", () => {
  for (const vimKeys of [false, true]) {
    assert.equal(keyOf(key("z", { metaKey: true }), { vimKeys }), "undo");
    assert.equal(keyOf(key("z", { ctrlKey: true }), { vimKeys }), "undo");
    assert.equal(keyOf(key("Z", { metaKey: true, shiftKey: true }), { vimKeys }), "redo");
    assert.equal(keyOf(key("Z", { ctrlKey: true, shiftKey: true }), { vimKeys }), "redo");
  }
});

test("u and Ctrl+R work only with Vim keys on", () => {
  assert.equal(keyOf(key("u")), null);
  assert.equal(keyOf(key("r", { ctrlKey: true })), null);
  assert.equal(keyOf(key("u"), { vimKeys: true }), "undo");
  assert.equal(keyOf(key("r", { ctrlKey: true }), { vimKeys: true }), "redo");
  assert.equal(keyOf(key("U"), { vimKeys: true }), null);
  assert.equal(keyOf(key("r", { metaKey: true }), { vimKeys: true }), null, "Cmd+R stays the browser's");
});

test("a key a view used, or one typed in a text box, is left alone", () => {
  assert.equal(keyOf(key("z", { ctrlKey: true, defaultPrevented: true })), null);
  assert.equal(keyOf(key("z", { ctrlKey: true }), { editable: true }), null);
  assert.equal(keyOf(key("u"), { vimKeys: true, editable: true }), null);
  assert.equal(keyOf(key("z", { ctrlKey: true, altKey: true })), null);
});

function start({ undo = null, redo = null, vimKeys = false } = {}) {
  const ask = (target) => Promise.resolve(target === "undo" ? { undo, redo } : { vimKeys });
  const actor = createActor(machine, { input: { ask } });
  const requested = [];
  actor.on("step.requested", (e) => requested.push(e.direction));
  actor.start();
  return { actor, requested };
}

test("a press asks for a step only when there is one, and follows undo.changed", async () => {
  const { actor, requested } = start({ undo: STEP, vimKeys: true });
  await flush();
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "_request", direction: "redo" });
  actor.send({ type: "_request", direction: "undo" });
  assert.deepEqual(requested, ["undo"]);

  actor.send({ type: "undo.changed", undo: null, redo: STEP });
  actor.send({ type: "_request", direction: "undo" });
  actor.send({ type: "_request", direction: "redo" });
  assert.deepEqual(requested, ["undo", "redo"]);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
});

test("a page without undo leaves both greyed", async () => {
  const actor = createActor(machine, { input: { ask: () => Promise.resolve({ error: "no-answerer" }) } });
  actor.start();
  await flush();
  assert.equal(actor.getSnapshot().context.undo, null);
  assert.equal(actor.getSnapshot().context.redo, null);
});
