import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// choice-point-checks as an owner of steps (12, Undo): one change of a box in Settings is
// one step, and an Undo or Redo is applied only while the box is as the step left it. The
// store is a fake whose rows outlive the machine, as IndexedDB outlives a reload.

const EV = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const EV2 = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5Q01";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore() {
  const boxes = new Map();
  const answers = new Map();
  const outbox = new Map();
  const meta = new Map();
  return {
    boxes,
    boxAll: async () => [...boxes.values()],
    boxPut: async (r) => void boxes.set(r.field, r),
    answerAll: async () => [...answers.values()],
    answerPut: async (r) => void answers.set(r.key, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
  };
}

const ask = (target) => {
  if (target === "session") return Promise.resolve({ userId: null, registrationOpen: false });
  if (target === "evaluators") return Promise.resolve({ evaluators: [] });
  if (target === "choice-points") return Promise.resolve({ choicePoints: [] });
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
const edit = (actor, evaluator) =>
  actor.send({ type: "checks.edited", field: "towards", evaluator, questions: [{ id: Q1, show: true, expect: "yes", when: null, icons: {} }] });
const undo = (actor, step) => actor.send({ type: "step.undone", id: step.id, owner: "choice-point-checks", payload: step.undo });
const redo = (actor, step) => actor.send({ type: "step.redone", id: step.id, owner: "choice-point-checks", payload: step.redo });

test("a box change is one step, and Undo then Redo bring the box back exactly", async () => {
  const { actor, steps, settled } = await start();
  edit(actor, EV);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "change how the Towards box is checked");
  const after = (await settings(actor)).towards;
  undo(actor, steps[0]);
  assert.equal((await settings(actor)).towards.evaluator, null);
  redo(actor, steps[0]);
  assert.deepEqual((await settings(actor)).towards, after);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("several changes undo in a row, also after a reload", async () => {
  const one = await start();
  edit(one.actor, EV);
  edit(one.actor, EV2);
  await flush();
  const two = await start(one.store);
  undo(two.actor, one.steps[1]);
  assert.equal((await settings(two.actor)).towards.evaluator, EV);
  undo(two.actor, one.steps[0]);
  assert.equal((await settings(two.actor)).towards.evaluator, null);
  assert.deepEqual(two.settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("a step is refused when the box was changed since by anything else", async () => {
  const { actor, store, steps } = await start();
  edit(actor, EV);
  await flush();
  // A box another device wrote, pulled from the server, carries no stamp of this browser.
  const { step: _, ...pulled } = store.boxes.get("towards");
  store.boxes.set("towards", { ...pulled, evaluator: EV2, version: 2 });
  const again = await start(store);
  undo(again.actor, steps[0]);
  assert.deepEqual(again.settled.at(-1), { id: steps[0].id, owner: "choice-point-checks", outcome: "refused", reason: "changed" });
});
