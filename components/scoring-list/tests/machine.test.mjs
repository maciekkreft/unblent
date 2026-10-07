import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, when } from "../machine.js";

const A = "01K6TEST000000000000000S0A";
const B = "01K6TEST000000000000000S0B";
const C = "01K6TEST000000000000000S0C";
const row = (id, at = 1) => ({ id, at, text: "A post", gauges: [] });

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async (scorings = [row(B), row(A)]) => {
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    clock,
    input: { ask: () => Promise.resolve({ scorings }), undoMs: 300 },
  });
  const emitted = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, clock, emitted };
};

test("the time word: the clock time today, Yesterday and the time, else the day and month", () => {
  const now = new Date(2026, 9, 7, 15, 0).getTime();
  assert.equal(when(new Date(2026, 9, 7, 14, 21).getTime(), now), "14:21");
  assert.equal(when(new Date(2026, 9, 6, 9, 40).getTime(), now), "Yesterday 09:40");
  assert.equal(when(new Date(2026, 9, 3, 9, 40).getTime(), now), "3 Oct");
});

test("the newest row is picked at load, as the stage shows it; a pick goes out", async () => {
  const { actor, emitted } = await start();
  assert.equal(actor.getSnapshot().context.open, B);
  actor.send({ type: "_pick", id: A });
  assert.equal(actor.getSnapshot().context.open, A);
  assert.deepEqual(emitted, [{ type: "scoring.selected", id: A }]);
  actor.send({ type: "_pick", id: C });
  assert.equal(emitted.length, 1, "a row that is not there cannot be picked");
});

test("a new scoring at the top becomes the picked row; a change below keeps the pick", async () => {
  const { actor } = await start();
  actor.send({ type: "_pick", id: A });
  actor.send({ type: "scoring.changed", scorings: [row(C), row(B), row(A)] });
  assert.equal(actor.getSnapshot().context.open, C);
  actor.send({ type: "_pick", id: A });
  actor.send({ type: "scoring.changed", scorings: [row(C), row(A)] });
  assert.equal(actor.getSnapshot().context.open, A);
  actor.send({ type: "scoring.changed", scorings: [row(C)] });
  assert.equal(actor.getSnapshot().context.open, null, "a deleted pick is no longer marked");
});

test("a delete waits out the undo window; Undo keeps the row", async () => {
  const { actor, clock, emitted } = await start();
  actor.send({ type: "_delete", id: A });
  assert.ok(actor.getSnapshot().context.deleting.has(A));
  clock.increment(200);
  actor.send({ type: "_undo", id: A });
  clock.increment(500);
  assert.deepEqual(emitted, [], "nothing is deleted after Undo");
  actor.send({ type: "_delete", id: A });
  clock.increment(299);
  assert.deepEqual(emitted, []);
  clock.increment(1);
  assert.deepEqual(emitted, [{ type: "scoring.discarded", id: A }]);
  assert.equal(actor.getSnapshot().context.deleting.size, 0);
});

test("scorings that cannot answer is a failure, not an empty list", async () => {
  const actor = createActor(machine, { input: { ask: () => Promise.resolve({ error: "no-answerer" }), undoMs: 1 } });
  actor.start();
  await flush();
  assert.ok(actor.getSnapshot().matches("failed"));
});
