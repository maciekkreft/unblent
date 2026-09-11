import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2): it is driven with a fake ask, the
// shape the bus's `ask` returns (4.2), and a `current` the view would read from
// `location`.
function settle(actor) {
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (!s.matches("loading")) resolve(s);
    });
    actor.start();
  });
}

test("a listed set of pages makes the view ready and keeps current", async () => {
  const asked = [];
  const ask = (...args) => {
    asked.push(args);
    return Promise.resolve({ pages: [{ path: "/design/tokens" }, { path: "/design/components" }] });
  };
  const input = { ask, current: "/design/tokens" };
  const s = await settle(createActor(machine, { input }));
  assert.equal(s.value, "ready");
  assert.deepEqual(s.context.pages, [{ path: "/design/tokens" }, { path: "/design/components" }]);
  assert.equal(s.context.current, "/design/tokens");
  assert.deepEqual(asked, [["pages", "list", {}]]);
});

test("an error reply fails the view and keeps the reason", async () => {
  const ask = () => Promise.resolve({ error: "unavailable" });
  const s = await settle(createActor(machine, { input: { ask, current: "/design/tokens" } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "unavailable");
});

test("a rejected ask fails the view", async () => {
  const ask = () => Promise.reject(new Error("boom"));
  const s = await settle(createActor(machine, { input: { ask, current: "/design/tokens" } }));
  assert.equal(s.value, "failed");
  assert.equal(s.context.error, "unavailable");
});
