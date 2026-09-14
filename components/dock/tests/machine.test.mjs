import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is where decisions live (3.2), so it is tested directly, with the
// environment faked: a stored string and a save that records.
function start(stored) {
  const saved = [];
  const emitted = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v) } });
  actor.on("dock.changed", (e) => emitted.push(e));
  actor.start();
  return { actor, saved, emitted };
}

const arrange = (actor, layout) => actor.send({ type: "dock.arranged", ...layout });
const read = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: "x", payload: {}, reply: (v) => (reply = v) });
  return reply;
};

test("a stored layout is honoured", () => {
  const stored = { stage: "b", docks: { right: { open: true, views: ["a"] } } };
  const { actor } = start(JSON.stringify(stored));
  assert.deepEqual(read(actor), stored);
});

test("malformed or absent stored falls back to the empty layout", () => {
  for (const stored of [null, "{", '{"stage":3,"docks":5}']) {
    const { actor } = start(stored);
    assert.deepEqual(read(actor), { stage: null, docks: {} });
  }
});

test("arranged saves and emits once", () => {
  const { actor, saved, emitted } = start(null);
  const layout = { stage: "b", docks: { right: { open: true, views: ["a"] } } };
  arrange(actor, layout);
  assert.deepEqual(saved, [JSON.stringify(layout)]);
  assert.deepEqual(emitted, [{ type: "dock.changed", ...layout }]);
});

test("an identical arrangement does nothing", () => {
  const layout = { stage: "b", docks: { right: { open: true, views: ["a"] } } };
  const { actor, saved, emitted } = start(JSON.stringify(layout));
  arrange(actor, layout);
  assert.deepEqual(saved, []);
  assert.deepEqual(emitted, []);
});

test("a side's views are deduplicated", () => {
  const { actor, emitted } = start(null);
  arrange(actor, { stage: null, docks: { bottom: { open: false, views: ["a", "a", "b"] } } });
  assert.deepEqual(emitted, [
    { type: "dock.changed", stage: null, docks: { bottom: { open: false, views: ["a", "b"] } } },
  ]);
});

test("a view docked on two sides is kept only on the first", () => {
  const { actor, emitted } = start(null);
  arrange(actor, {
    stage: null,
    docks: { left: { open: true, views: ["a"] }, right: { open: true, views: ["a", "b"] } },
  });
  assert.deepEqual(emitted, [
    {
      type: "dock.changed",
      stage: null,
      docks: { left: { open: true, views: ["a"] }, right: { open: true, views: ["b"] } },
    },
  ]);
});

test("a side left empty is dropped", () => {
  const { actor, emitted } = start(null);
  arrange(actor, { stage: "a", docks: { right: { open: true, views: [] } } });
  assert.deepEqual(emitted, [{ type: "dock.changed", stage: "a", docks: {} }]);
});

test("read replies the current layout", () => {
  const { actor } = start(null);
  const layout = { stage: null, docks: { left: { open: true, views: ["a"] } } };
  arrange(actor, layout);
  assert.deepEqual(read(actor), layout);
});

test("a side's active is kept when it names one of its views, dropped otherwise", () => {
  const { actor, emitted } = start(null);
  arrange(actor, {
    stage: null,
    docks: { left: { open: true, views: ["a", "b"], active: "b" }, right: { open: true, views: ["c"], active: "zz" } },
  });
  assert.deepEqual(emitted[0].docks, {
    left: { open: true, views: ["a", "b"], active: "b" },
    right: { open: true, views: ["c"] },
  });
});

test("a change of active alone is a change", () => {
  const layout = { stage: null, docks: { left: { open: true, views: ["a", "b"], active: "a" } } };
  const { actor, emitted } = start(JSON.stringify(layout));
  arrange(actor, { ...layout, docks: { left: { ...layout.docks.left, active: "b" } } });
  assert.equal(emitted.length, 1);
});
