import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// generators as an owner of steps (12, Undo): a switch, a model and a stretch of typing in
// a name or a prompt are each one step, applied back only while the generator is as the
// step left it. The store is a fake whose rows outlive the machine, as IndexedDB outlives
// a reload.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const generatorSchema = schema("../events/generator.changed.json");

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
  actor.on("generator.changed", (e) => assert.ok(generatorSchema.validate({ generator: e.generator }).valid, JSON.stringify(e)));
  actor.start();
  await flush();
  return { actor, store, steps, settled };
}

const titles = async (actor) => {
  const r = await new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }));
  return r.generators.find((g) => g.id === "chat-title");
};
const edit = (actor, over) => actor.send({ type: "generator.edited", id: "chat-title", ...over });
const undo = (actor, step) => actor.send({ type: "step.undone", id: step.id, owner: "generators", payload: step.undo });
const redo = (actor, step) => actor.send({ type: "step.redone", id: step.id, owner: "generators", payload: step.redo });
const last = (steps, id) => steps.filter((s) => s.id === id).at(-1);

test("a switch is one step, and Undo then Redo bring the generator back exactly", async () => {
  const { actor, steps, settled } = await start();
  const before = await titles(actor);
  edit(actor, { on: false });
  assert.equal(steps.length, 1);
  assert.match(steps[0].label, /^switch off /);
  undo(actor, steps[0]);
  assert.deepEqual({ ...(await titles(actor)), version: 0 }, { ...before, version: 0 });
  redo(actor, steps[0]);
  assert.equal((await titles(actor)).on, false);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("typing on in the prompt is one step; another field starts the next", async () => {
  const { actor, steps } = await start();
  const before = await titles(actor);
  edit(actor, { prompt: "Name" });
  edit(actor, { prompt: "Name the chat" });
  edit(actor, { model: "claude-opus-5" });
  const ids = [...new Set(steps.map((s) => s.id))];
  assert.equal(ids.length, 2);
  assert.deepEqual(last(steps, ids[0]).undo.fields, { prompt: before.prompt });
  assert.deepEqual(last(steps, ids[0]).redo.fields, { prompt: "Name the chat" });
});

test("several steps undo in a row, also after a reload", async () => {
  const one = await start();
  const before = await titles(one.actor);
  edit(one.actor, { name: "Titles" });
  edit(one.actor, { on: false });
  await flush();
  const two = await start(one.store);
  undo(two.actor, one.steps[1]);
  undo(two.actor, one.steps[0]);
  assert.deepEqual(two.settled.map((s) => s.outcome), ["applied", "applied"]);
  const now = await titles(two.actor);
  assert.equal(now.name, before.name);
  assert.equal(now.on, true);
});

test("a step is refused when the generator was changed since by anything else", async () => {
  const { actor, store, steps } = await start();
  edit(actor, { on: false });
  await flush();
  // A generator another device wrote, pulled from the server, carries no stamp of this browser.
  const { step: _, ...pulled } = store.rows.get("chat-title");
  store.rows.set("chat-title", { ...pulled, on: true, version: 3 });
  const again = await start(store);
  undo(again.actor, steps[0]);
  assert.deepEqual(again.settled.at(-1), { id: steps[0].id, owner: "generators", outcome: "refused", reason: "changed" });
});
