import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// value-checks as an owner of steps (12, Undo): one choice in Settings of who checks the
// values or the examples is one step, applied back only while the settings are as the
// step left them. The store is a fake whose rows outlive the machine, as IndexedDB
// outlives a reload.

const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const EV2 = "01ARZ3NDEKTSV4RRFFQ69G5EV2";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore() {
  const answers = new Map();
  const outbox = new Map();
  const meta = new Map();
  const held = { settings: null };
  return {
    held,
    settingsGet: async () => held.settings,
    settingsPut: async (r) => void (held.settings = r),
    answerAll: async () => [...answers.values()],
    answerPut: async (r) => void answers.set(r.key, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
  };
}

const ask = (target, name, payload) => {
  if (target === "session") return Promise.resolve({ userId: null, registrationOpen: false });
  if (target === "llm" && name === "read") return Promise.resolve({ jev: { keySet: false } });
  if (target === "evaluators") return Promise.resolve({ evaluators: [] });
  if (target === "values") return Promise.resolve({ day: payload.day, values: [], changedSince: false });
  return Promise.resolve({ error: "no-answerer" });
};

async function start(store = fakeStore()) {
  const actor = createActor(machine, { input: { store, ask } });
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
  actor.start();
  await flush();
  return { actor, store, steps, settled };
}

const settings = (actor) =>
  new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: {}, reply })).then((r) => r.settings);
const edit = (actor, values, examples = null) => actor.send({ type: "value-checks.edited", values, examples });
const undo = (actor, step) => actor.send({ type: "step.undone", id: step.id, owner: "value-checks", payload: step.undo });
const redo = (actor, step) => actor.send({ type: "step.redone", id: step.id, owner: "value-checks", payload: step.redo });

test("a choice is one step, and Undo then Redo bring the settings back exactly", async () => {
  const { actor, steps, settled } = await start();
  edit(actor, EV);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "choose who checks your values");
  undo(actor, steps[0]);
  assert.deepEqual(await settings(actor), { values: null, examples: null });
  redo(actor, steps[0]);
  assert.deepEqual(await settings(actor), { values: EV, examples: null });
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("several choices undo in a row, also after a reload", async () => {
  const one = await start();
  edit(one.actor, EV);
  edit(one.actor, EV, EV2);
  await flush();
  const two = await start(one.store);
  undo(two.actor, one.steps[1]);
  undo(two.actor, one.steps[0]);
  assert.deepEqual(two.settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.deepEqual(await settings(two.actor), { values: null, examples: null });
});

test("a step is refused when the settings were changed since by anything else", async () => {
  const { actor, store, steps } = await start();
  edit(actor, EV);
  await flush();
  // Settings another device wrote, pulled from the server, carry no stamp of this browser.
  store.held.settings = { values: EV2, examples: null, version: 2 };
  const again = await start(store);
  undo(again.actor, steps[0]);
  assert.deepEqual(again.settled.at(-1), { id: steps[0].id, owner: "value-checks", outcome: "refused", reason: "changed" });
});
