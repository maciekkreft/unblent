import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, labelOf } from "../machine.js";

// values as an owner of steps (12, Undo): what it records for each change, and how it
// applies an Undo or Redo `undo` names to it. Signed out, so no network is involved.

const A = "01ARZ3NDEKTSV4RRFFQ69G5VA1";
const B = "01ARZ3NDEKTSV4RRFFQ69G5VA2";
const C = "01ARZ3NDEKTSV4RRFFQ69G5VA3";
const courage = { id: A, name: "Courage", meaning: "" };
const health = { id: B, name: "Health", meaning: "Moving every day" };
const play = { id: C, name: "Play", meaning: "" };

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const recordedSchema = new Validator(schema("../events/step.recorded.json"), "2020-12");
const settledSchema = new Validator(schema("../events/step.settled.json"), "2020-12");

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const noon = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).getTime();
};

function memory(initial = []) {
  const rows = new Map(initial.map((r) => [r.day, r]));
  const places = new Map();
  return {
    rows,
    places,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.day, r),
    placesAll: async () => [...places.values()],
    placePut: async (p) => void places.set(p.day, p),
    outboxAll: async () => [],
    outboxPut: async () => {},
    outboxDelete: async () => {},
    metaGet: async () => undefined,
    metaPut: async () => {},
  };
}

async function start({ store = memory(), day = "2026-10-14" } = {}) {
  const clock = new SimulatedClock();
  clock.set(noon(day));
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  const actor = createActor(machine, { input: { store, mint, now: () => clock.now() }, clock });
  const steps = [];
  const settled = [];
  const changed = [];
  actor.on("step.recorded", ({ type, ...p }) => {
    assert.ok(recordedSchema.validate(p).valid, JSON.stringify(p));
    steps.push(p);
  });
  actor.on("step.settled", ({ type, ...p }) => {
    assert.ok(settledSchema.validate(p).valid, JSON.stringify(p));
    settled.push(p);
  });
  actor.on("values.changed", (e) => changed.push(e));
  actor.start();
  await flush();
  return { actor, steps, settled, changed, clock, store };
}

const save = (values, finished) => ({ type: "values.saved", day: "2026-10-14", values, ...(finished ? { finished } : {}) });
const read = (actor) => new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: {}, reply }));
const undo = (step) => ({ type: "step.undone", id: step.id, owner: "values", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "values", payload: step.redo });

test("a stretch of typing is one step, closed when its row is left", async () => {
  const { actor, steps } = await start();
  actor.send(save([{ ...courage, name: "Cou" }]));
  actor.send(save([courage]));
  actor.send(save([courage], [A]));
  assert.deepEqual(new Set(steps.map((s) => s.id)).size, 1);
  assert.equal(steps.at(-1).label, "add value Courage");
  assert.deepEqual(steps.at(-1).undo, { kind: "values", values: [] });
  assert.deepEqual(steps.at(-1).redo, { kind: "values", values: [courage] });

  actor.send(save([{ ...courage, meaning: "Speaking up" }]));
  assert.notEqual(steps.at(-1).id, steps[0].id, "the next stretch is a new step");
  assert.equal(steps.at(-1).label, "change value Courage");
});

test("typing in another row while a stretch is open starts a new step", async () => {
  const { actor, steps } = await start();
  actor.send(save([courage, health], [A, B]));
  actor.send(save([{ ...courage, name: "Courage!" }, health]));
  actor.send(save([{ ...courage, name: "Courage!" }, { ...health, name: "Health!" }]));
  assert.equal(new Set(steps.map((s) => s.id)).size, 3);
});

test("removing a value is its own step and asks for the notice; a move is its own step", async () => {
  const { actor, steps } = await start();
  actor.send(save([courage, health, play], [A, B, C]));
  actor.send(save([courage, play]));
  assert.equal(steps.at(-1).label, "remove value Health");
  assert.equal(steps.at(-1).notice, true);
  actor.send(save([play, courage]));
  assert.equal(steps.at(-1).label, "move value Play");
  assert.equal(steps.at(-1).notice, undefined);
  assert.equal(new Set(steps.map((s) => s.id)).size, 3);
});

test("undo puts the list back, redo makes it again, and neither is a step", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save([courage, health], [A, B]));
  actor.send(save([courage]));
  const removal = steps.at(-1);
  const count = steps.length;
  actor.send(undo(removal));
  assert.deepEqual((await read(actor)).values, [courage, health]);
  assert.deepEqual(settled.at(-1), { id: removal.id, owner: "values", outcome: "applied" });
  actor.send(redo(removal));
  assert.deepEqual((await read(actor)).values, [courage]);
  assert.deepEqual(settled.at(-1), { id: removal.id, owner: "values", outcome: "applied" });
  assert.equal(steps.length, count, "applying records nothing");
});

test("a step whose list was written since is refused as changed", async () => {
  const { actor, steps, settled } = await start();
  actor.send(save([courage, health], [A, B]));
  const first = steps.at(-1);
  actor.send(save([courage]));
  actor.send(undo(first));
  assert.deepEqual(settled.at(-1), { id: first.id, owner: "values", outcome: "refused", reason: "changed" });
  assert.deepEqual((await read(actor)).values, [courage]);
  actor.send({ type: "step.undone", id: first.id, owner: "notes", payload: first.undo });
  assert.equal(settled.length, 1, "another owner's step is not this fact's to answer");
});

test("a step from an earlier day applies its list to today's version", async () => {
  const store = memory();
  const { actor, steps, clock } = await start({ store });
  actor.send(save([courage, health], [A, B]));
  actor.send(save([courage]));
  const removal = steps.at(-1);
  clock.set(noon("2026-10-15"));
  actor.send(undo(removal));
  assert.deepEqual((await read(actor)).values, [courage, health]);
  assert.equal((await read(actor)).day, "2026-10-15");
  assert.deepEqual(store.rows.get("2026-10-14").values, [courage], "the earlier day keeps its version");
});

test("placing the panel is a step; one from another day is refused as closed", async () => {
  const { actor, steps, settled, clock } = await start();
  actor.send({ type: "values.placed", day: "2026-10-14", placed: true });
  const step = steps.at(-1);
  assert.equal(step.label, "add Your values to the day");
  actor.send(undo(step));
  assert.deepEqual(settled.at(-1), { id: step.id, owner: "values", outcome: "applied" });
  actor.send({ type: "read?", cid: "c", payload: { day: "2026-10-14" }, reply: (r) => assert.equal(r.placed, false) });
  actor.send(redo(step));
  clock.set(noon("2026-10-15"));
  actor.send(undo(step));
  assert.deepEqual(settled.at(-1), { id: step.id, owner: "values", outcome: "refused", reason: "closed" });
});

test("a step's label names what changed", () => {
  assert.equal(labelOf([courage, health], [courage]), "remove value Health");
  assert.equal(labelOf([courage, health, play], [courage]), "remove 2 values");
  assert.equal(labelOf([], [{ ...courage, name: "" , meaning: "Speak up" }]), "add value Speak up");
  assert.equal(labelOf([courage], [{ ...courage, name: "" }]), "change value Courage");
  assert.equal(labelOf([courage, health], [{ ...courage, name: "Bravery" }, { ...health, name: "Body" }]), "change values");
});
