import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// dock as an owner of steps (12, Undo): moving a view between the stage and the sides is
// one step, and moving around is none. Storage is a fake shared by two machines, as two
// tabs share localStorage.

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

let n = 0;
const mint = () => `01ARZ3NDEKTSV4RRFFQ69G5${String(++n).padStart(3, "0")}`.replace(/[ILOU]/g, "0");

function storage() {
  const keys = new Map();
  const io = (key) => ({ read: () => keys.get(key) ?? null, write: (v) => void keys.set(key, v) });
  return { keys, io };
}

function start(disk) {
  const store = disk.io("dock:/");
  const stamp = disk.io("dock:step:/");
  const actor = createActor(machine, {
    input: { stored: store.read(), save: store.write, stamp: stamp.read(), load: store.read, stampLoad: stamp.read, stampSave: stamp.write, mint },
  });
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
  return { actor, steps, settled };
}

const layout = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  return reply;
};
const arrange = (actor, stage, docks) => actor.send({ type: "dock.arranged", stage, docks });
const undo = (actor, step) => actor.send({ type: "step.undone", id: step.id, owner: "dock", payload: step.undo });
const redo = (actor, step) => actor.send({ type: "step.redone", id: step.id, owner: "dock", payload: step.redo });

const START = { stage: "notes", docks: { left: { open: true, views: ["chat"] } } };
const MOVED = { stage: "notes", docks: { right: { open: true, views: ["chat"], active: "chat" } } };

test("moving a view is one step, and Undo then Redo bring the layout back exactly", () => {
  const disk = storage();
  disk.keys.set("dock:/", JSON.stringify(START));
  const { actor, steps, settled } = start(disk);
  arrange(actor, MOVED.stage, MOVED.docks);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "arrange the desk");
  undo(actor, steps[0]);
  assert.deepEqual(layout(actor), START);
  redo(actor, steps[0]);
  assert.deepEqual(layout(actor), MOVED);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("picking a tab, folding and staging are no steps, and keep the step undoable", () => {
  const disk = storage();
  disk.keys.set("dock:/", JSON.stringify(START));
  const { actor, steps, settled } = start(disk);
  arrange(actor, MOVED.stage, MOVED.docks);
  arrange(actor, "book", { right: { open: false, views: ["chat"] } });
  assert.equal(steps.length, 1);
  undo(actor, steps[0]);
  assert.equal(settled.at(-1).outcome, "applied");
  assert.deepEqual(layout(actor), START);
});

test("several arrangements undo in a row, also after a reload", () => {
  const disk = storage();
  disk.keys.set("dock:/", JSON.stringify(START));
  const one = start(disk);
  arrange(one.actor, MOVED.stage, MOVED.docks);
  arrange(one.actor, "chat", {});
  const [a, b] = one.steps;
  const two = start(disk);
  undo(two.actor, b);
  undo(two.actor, a);
  assert.deepEqual(two.settled.map((s) => s.outcome), ["applied", "applied"]);
  assert.deepEqual(layout(two.actor), START);
});

test("a step is refused when another tab arranged the desk since", () => {
  const disk = storage();
  disk.keys.set("dock:/", JSON.stringify(START));
  const one = start(disk);
  const two = start(disk);
  arrange(one.actor, MOVED.stage, MOVED.docks);
  arrange(two.actor, "chat", {});
  undo(one.actor, one.steps[0]);
  assert.deepEqual(one.settled.at(-1), { id: one.steps[0].id, owner: "dock", outcome: "refused", reason: "changed" });
});
