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

test("a listed catalog makes the view ready with the components", async () => {
  const asked = [];
  const ask = (...args) => {
    asked.push(args);
    return Promise.resolve({ components: [{ name: "a" }, { name: "b" }] });
  };
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "ready");
  assert.deepEqual(s.context.components, [{ name: "a" }, { name: "b" }]);
  assert.deepEqual(asked, [["catalog", "list", {}]]);
});

test("an error reply fails the view and keeps the reason", async () => {
  const ask = () => Promise.resolve({ error: "no-answerer" });
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "no-answerer");
});

test("a rejected ask fails the view", async () => {
  const ask = () => Promise.reject(new Error("boom"));
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "unavailable");
});
