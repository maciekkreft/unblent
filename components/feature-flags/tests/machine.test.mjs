import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, onOf, settle } from "../machine.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

test("a waiting switch shows what was asked; the next picture settles or refuses it", () => {
  const context = { off: ["chats"], waiting: { evaluators: false } };
  assert.equal(onOf(context, "chats"), false);
  assert.equal(onOf(context, "evaluators"), false, "shown as asked while it waits");
  assert.equal(onOf(context, "highlights"), true);
  assert.deepEqual(settle({ evaluators: false }, ["evaluators"]), { waiting: {}, refused: null });
  assert.deepEqual(settle({ evaluators: false }, []), { waiting: {}, refused: "evaluators" });
});

test("it asks flags at start, emits each switch and follows flags.changed", async () => {
  const asked = [];
  const emitted = [];
  const actor = createActor(machine, { input: { ask: async (...a) => (asked.push(a), { off: [], hidden: [] }) } });
  actor.on("flag.switched", (e) => emitted.push({ feature: e.feature, on: e.on }));
  actor.start();
  await flush();
  assert.deepEqual(asked, [["flags", "read", {}]]);
  actor.send({ type: "_switch", feature: "chats", on: false });
  assert.deepEqual(emitted, [{ feature: "chats", on: false }]);
  assert.equal(onOf(actor.getSnapshot().context, "chats"), false);
  actor.send({ type: "flags.changed", off: [], hidden: [] });
  assert.equal(actor.getSnapshot().context.refused, "chats");
  assert.equal(onOf(actor.getSnapshot().context, "chats"), true, "a refused switch goes back");
  actor.send({ type: "_switch", feature: "chats", on: false });
  assert.equal(actor.getSnapshot().context.refused, null, "the next switch clears the line");
});
