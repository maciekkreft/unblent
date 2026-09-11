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

const VOCAB = {
  events: [{ name: "color-scheme.changed", owner: "color-scheme", schema: {}, consumers: ["token-sheet"] }],
  queries: [{ target: "catalog", name: "list", payload: {}, reply: {}, askers: ["component-list"] }],
  commands: [],
};

test("a contracts reply makes the view ready with the vocabulary", async () => {
  const asked = [];
  const ask = (...args) => {
    asked.push(args);
    return Promise.resolve(VOCAB);
  };
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "ready");
  assert.deepEqual(s.context.events, VOCAB.events);
  assert.deepEqual(s.context.queries, VOCAB.queries);
  assert.deepEqual(s.context.commands, []);
  assert.deepEqual(asked, [["catalog", "contracts", {}]]);
});

test("an error reply fails the view and keeps the reason", async () => {
  const ask = () => Promise.resolve({ error: "unavailable" });
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "unavailable");
});

test("a rejected ask fails the view", async () => {
  const ask = () => Promise.reject(new Error("boom"));
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "unavailable");
});
