import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

// The actor is driven with a fake ask, the shape the bus's `ask` returns (4.2).
function settle(actor) {
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready")) resolve(s);
    });
    actor.start();
  });
}

const rec = (over = {}) => ({
  seq: 1,
  at: 1000,
  tab: "01AAAAAAAAAAAAAAAAAA",
  kind: "event",
  name: "note.saved",
  from: "note-editor",
  to: ["notes"],
  ignored: [],
  outcome: "delivered",
  reason: null,
  cid: null,
  payload: { id: "x" },
  ...over,
});

test("the starting picture comes from trace: list, sorted", async () => {
  const records = [rec({ seq: 2, at: 2000 }), rec({ seq: 1, at: 1000 })];
  const asked = [];
  const ask = (...args) => (asked.push(args), Promise.resolve({ records }));
  const s = await settle(createActor(machine, { input: { ask } }));
  assert.deepEqual(s.context.records.map((r) => r.seq), [1, 2]);
  assert.deepEqual(asked, [["trace", "list", {}]]);
});

test("a later trace.recorded is appended, sorted, and deduped", async () => {
  const ask = () => Promise.resolve({ records: [rec({ seq: 1, at: 1000 })] });
  const actor = createActor(machine, { input: { ask } });
  const s = await settle(actor);
  actor.send({ type: "trace.recorded", ...rec({ seq: 3, at: 500 }) }); // earlier
  actor.send({ type: "trace.recorded", ...rec({ seq: 1, at: 1000 }) }); // duplicate
  const records = actor.getSnapshot().context.records;
  assert.deepEqual(records.map((r) => r.seq), [3, 1]);
  assert.ok(!("type" in records[0]));
});

test("a record arriving during load is not lost when the reply lands", async () => {
  // The reply resolves on a microtask, so an event sent right after start races it.
  let resolveReply;
  const ask = () => new Promise((r) => (resolveReply = r));
  const actor = createActor(machine, { input: { ask } });
  actor.start();
  actor.send({ type: "trace.recorded", ...rec({ seq: 9, at: 100 }) });
  resolveReply({ records: [rec({ seq: 1, at: 1000 })] });
  await new Promise((r) => setTimeout(r, 0));
  const seqs = actor.getSnapshot().context.records.map((r) => r.seq);
  assert.deepEqual(seqs, [9, 1]);
});

test("toggle opens a row and toggles it shut", async () => {
  const ask = () => Promise.resolve({ records: [rec()] });
  const actor = createActor(machine, { input: { ask } });
  await settle(actor);
  const id = "01AAAAAAAAAAAAAAAAAA:1";
  actor.send({ type: "_toggle", id });
  assert.equal(actor.getSnapshot().context.expanded, id);
  actor.send({ type: "_toggle", id });
  assert.equal(actor.getSnapshot().context.expanded, null);
});
