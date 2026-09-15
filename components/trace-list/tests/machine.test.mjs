import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, runs, RUN_GAP_MS } from "../machine.js";

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
  assert.ok(actor.getSnapshot().context.expanded.has(id));
  actor.send({ type: "_toggle", id });
  assert.ok(!actor.getSnapshot().context.expanded.has(id));
});

test("more than one row can be open at once", async () => {
  const ask = () => Promise.resolve({ records: [rec({ seq: 1 }), rec({ seq: 2, at: 2000 })] });
  const actor = createActor(machine, { input: { ask } });
  await settle(actor);
  actor.send({ type: "_toggle", id: "01AAAAAAAAAAAAAAAAAA:1" });
  actor.send({ type: "_toggle", id: "01AAAAAAAAAAAAAAAAAA:2" });
  const { expanded } = actor.getSnapshot().context;
  assert.ok(expanded.has("01AAAAAAAAAAAAAAAAAA:1") && expanded.has("01AAAAAAAAAAAAAAAAAA:2"));
});

test("clear empties what is shown; later traffic is shown again", async () => {
  const ask = () => Promise.resolve({ records: [rec()] });
  const actor = createActor(machine, { input: { ask } });
  await settle(actor);
  actor.send({ type: "_toggle", id: "01AAAAAAAAAAAAAAAAAA:1" });
  actor.send({ type: "_clear" });
  assert.deepEqual(actor.getSnapshot().context.records, []);
  assert.equal(actor.getSnapshot().context.expanded.size, 0);
  actor.send({ type: "trace.recorded", ...rec({ seq: 2, at: 2000 }) });
  assert.deepEqual(actor.getSnapshot().context.records.map((r) => r.seq), [2]);
});

// --- runs(): folding a burst into one line ---------------------------------------

test("an interleaved burst within the gap folds into runs by signature", () => {
  // A typing run: note.saved and note.changed alternate, 100 ms apart.
  const records = [];
  for (let i = 0; i < 3; i += 1) {
    records.push(rec({ seq: i * 2 + 1, at: 1000 + i * 200, name: "note.saved", from: "note-editor", to: ["notes"] }));
    records.push(rec({ seq: i * 2 + 2, at: 1100 + i * 200, name: "note.changed", from: "notes", to: ["note-editor"] }));
  }
  const grouped = runs(records);
  assert.equal(grouped.length, 2, "two runs, one per signature");
  assert.deepEqual(grouped.map((g) => g.length), [3, 3]);
  assert.equal(grouped[0][0].name, "note.saved", "listed where its first record fell");
  assert.equal(grouped[1][0].name, "note.changed");
});

test("a gap longer than RUN_GAP_MS splits a run; exactly the gap does not", () => {
  const within = runs([rec({ seq: 1, at: 1000 }), rec({ seq: 2, at: 1000 + RUN_GAP_MS })]);
  assert.deepEqual(within.map((g) => g.length), [2], "a record exactly the gap later joins");
  const beyond = runs([rec({ seq: 1, at: 1000 }), rec({ seq: 2, at: 1001 + RUN_GAP_MS })]);
  assert.deepEqual(beyond.map((g) => g.length), [1, 1], "a record past the gap opens a new run");
});

test("a differing field is its own run even inside the gap", () => {
  for (const field of [{ outcome: "ignored" }, { from: "elsewhere" }, { to: ["someone"] }, { tab: "01BBBBBBBBBBBBBBBBBB" }]) {
    const grouped = runs([rec({ seq: 1, at: 1000 }), rec({ seq: 2, at: 1050, ...field })]);
    assert.deepEqual(grouped.map((g) => g.length), [1, 1], `a different ${Object.keys(field)[0]} is a separate run`);
  }
});

test("a lone record is a run of one; no records is no runs", () => {
  assert.deepEqual(runs([rec()]).map((g) => g.length), [1]);
  assert.deepEqual(runs([]), []);
});

test("a run's row id toggles like any other", async () => {
  const ask = () => Promise.resolve({ records: [rec()] });
  const actor = createActor(machine, { input: { ask } });
  await settle(actor);
  const id = "run:01AAAAAAAAAAAAAAAAAA:1";
  actor.send({ type: "_toggle", id });
  assert.ok(actor.getSnapshot().context.expanded.has(id));
});
