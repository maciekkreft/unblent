import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// experts as an owner of steps (12, Undo): an On switch is one step, and a stretch of
// typing in a prompt is one step until the box is left; a step is applied back only
// while the expert is as the step left it. The store is a fake whose rows outlive the
// machine, as IndexedDB outlives a reload.
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const changedSchema = schema("../events/expert.changed.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore() {
  const rows = new Map();
  const outbox = new Map();
  const meta = new Map();
  return {
    rows,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
  };
}

const ask = (target) => Promise.resolve(target === "session" ? { userId: null, registrationOpen: false } : { error: "no-answerer" });

async function start(store = fakeStore()) {
  const actor = createActor(machine, { input: { store, ask }, clock: new SimulatedClock() });
  const steps = [];
  const settled = [];
  actor.on("step.recorded", (e) => {
    const { type: _, ...payload } = e;
    assert.ok(recordedSchema.validate(payload).valid, JSON.stringify(e));
    steps.push(payload);
  });
  actor.on("step.settled", (e) => {
    const { type: _, ...payload } = e;
    assert.ok(settledSchema.validate(payload).valid, JSON.stringify(e));
    settled.push(payload);
  });
  actor.on("expert.changed", (e) => assert.ok(changedSchema.validate({ expert: e.expert }).valid, JSON.stringify(e)));
  actor.start();
  await flush();
  return { actor, store, steps, settled };
}

const expert = async (actor) => {
  const r = await new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }));
  return r.experts.find((e) => e.id === BOOK);
};
const edit = (actor, over) => actor.send({ type: "expert.edited", id: BOOK, ...over });
const undo = (actor, step) => actor.send({ type: "step.undone", id: step.id, owner: "experts", payload: step.undo });
const redo = (actor, step) => actor.send({ type: "step.redone", id: step.id, owner: "experts", payload: step.redo });
const last = (steps, id) => steps.filter((s) => s.id === id).at(-1);
const ids = (steps) => [...new Set(steps.map((s) => s.id))];

test("typing on in the prompt is one step until the box is left; the next typing starts another", async () => {
  const { actor, steps } = await start();
  edit(actor, { prompt: "Speak" });
  edit(actor, { prompt: "Speak as Seneca" });
  edit(actor, { left: true });
  edit(actor, { prompt: "Speak as Seneca." });
  const [first, second] = ids(steps);
  assert.equal(ids(steps).length, 2);
  assert.deepEqual(last(steps, first).undo.fields, { prompt: "" });
  assert.deepEqual(last(steps, first).redo.fields, { prompt: "Speak as Seneca" });
  assert.equal(last(steps, first).label, "edit a book expert");
  assert.deepEqual(last(steps, second).undo.fields, { prompt: "Speak as Seneca" });
});

test("a left that comes with the last keystroke still closes the stretch", async () => {
  const { actor, steps } = await start();
  edit(actor, { prompt: "A" });
  edit(actor, { prompt: "AB", left: true });
  edit(actor, { prompt: "ABC" });
  assert.equal(ids(steps).length, 2);
});

test("On is a step of its own, and Undo then Redo bring the expert back exactly", async () => {
  const { actor, steps, settled } = await start();
  edit(actor, { prompt: "Stoic" });
  edit(actor, { on: true });
  edit(actor, { prompt: "Stoic!" });
  assert.equal(ids(steps).length, 3, "the switch ends the stretch");
  const on = last(steps, ids(steps)[1]);
  assert.equal(on.label, "switch on a book expert");
  assert.deepEqual(on.undo.fields, { on: false });
  const typed = last(steps, ids(steps)[2]);
  undo(actor, typed);
  undo(actor, on);
  assert.deepEqual([(await expert(actor)).prompt, (await expert(actor)).on], ["Stoic", false]);
  redo(actor, on);
  redo(actor, typed);
  assert.deepEqual([(await expert(actor)).prompt, (await expert(actor)).on], ["Stoic!", true]);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied", "applied", "applied"]);
});

test("several steps undo in a row, also after a reload", async () => {
  const one = await start();
  edit(one.actor, { prompt: "Stoic" });
  edit(one.actor, { on: true });
  await flush();
  const two = await start(one.store);
  undo(two.actor, last(one.steps, ids(one.steps)[1]));
  undo(two.actor, last(one.steps, ids(one.steps)[0]));
  assert.deepEqual(two.settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.deepEqual([(await expert(two.actor)).prompt, (await expert(two.actor)).on], ["", false]);
});

test("a step is refused when the expert was changed since by anything else", async () => {
  const { actor, store, steps } = await start();
  edit(actor, { prompt: "Stoic" });
  await flush();
  // An expert another device wrote, pulled from the server, carries no stamp of this browser.
  const { step: _, ...pulled } = store.rows.get(BOOK);
  store.rows.set(BOOK, { ...pulled, prompt: "Cynic", version: 3 });
  const again = await start(store);
  undo(again.actor, steps[0]);
  assert.deepEqual(again.settled.at(-1), { id: steps[0].id, owner: "experts", outcome: "refused", reason: "changed" });
  assert.equal((await expert(again.actor)).prompt, "Cynic");
});

test("a step of another owner is not answered", async () => {
  const { actor, steps, settled } = await start();
  edit(actor, { prompt: "Stoic" });
  actor.send({ type: "step.undone", id: steps[0].id, owner: "generators", payload: steps[0].undo });
  assert.deepEqual(settled, []);
});
