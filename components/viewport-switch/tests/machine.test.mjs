import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake ask, the
// shape the bus's `ask` returns (4.2).
function settle(actor) {
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (!s.matches("loading")) resolve(s);
    });
    actor.start();
  });
}

test("asks viewport for the starting picture and becomes ready", async () => {
  const asked = [];
  const ask = (...args) => {
    asked.push(args);
    return Promise.resolve({ viewport: "phone" });
  };
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "ready");
  assert.equal(s.context.viewport, "phone");
  assert.deepEqual(asked, [["viewport", "read", {}]]);
});

test("an error reply fails the view", async () => {
  const ask = () => Promise.resolve({ error: "unavailable" });
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "failed");
});

test("a rejected ask fails the view", async () => {
  const ask = () => Promise.reject(new Error("boom"));
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "failed");
});

test("viewport.changed updates the shown viewport (4.3, fourth rule)", async () => {
  const ask = () => Promise.resolve({ viewport: "desk" });
  const actor = createActor(machine, { input: { ask } });
  await settle(actor);
  actor.send({ type: "viewport.changed", viewport: "phone" });
  assert.equal(actor.getSnapshot().context.viewport, "phone");
});

test("a select gesture emits viewport.selected as-is", async () => {
  const ask = () => Promise.resolve({ viewport: "desk" });
  const actor = createActor(machine, { input: { ask } });
  const emitted = [];
  actor.on("viewport.selected", (e) => emitted.push(e));
  await settle(actor);
  actor.send({ type: "_select", viewport: "phone" });
  assert.deepEqual(emitted, [{ type: "viewport.selected", viewport: "phone" }]);
});
