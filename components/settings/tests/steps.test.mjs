import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// settings as an owner of steps (12, Undo): one change in Settings is one step on the
// copy of its profile, and an Undo or Redo is applied only while that copy is as the
// step left it. Storage is a fake shared by two machines, as two tabs share localStorage.

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

function start(disk, product = true) {
  const w = disk.io("settings");
  const p = disk.io("settings:product");
  const sw = disk.io("settings:step");
  const sp = disk.io("settings:product:step");
  const actor = createActor(machine, {
    input: {
      product,
      stored: { workshop: w.read(), product: p.read(), profile: null },
      save: { workshop: w.write, product: p.write, profile: () => {} },
      stamps: { workshop: sw.read(), product: sp.read() },
      load: { workshop: w.read, product: p.read },
      stampLoad: { workshop: sw.read, product: sp.read },
      stampSave: { workshop: sw.write, product: sp.write },
      mint,
    },
  });
  const steps = [];
  const settled = [];
  const changed = [];
  actor.on("step.recorded", (e) => {
    const { type: _, ...payload } = e;
    assert.ok(recordedSchema.validate(payload).valid, JSON.stringify(e));
    steps.push(e);
  });
  actor.on("step.settled", (e) => {
    const { type: _, ...payload } = e;
    assert.ok(settledSchema.validate(payload).valid, JSON.stringify(e));
    settled.push(payload);
  });
  actor.on("settings.changed", (e) => changed.push(e));
  actor.start();
  return { actor, steps, settled, changed };
}

const read = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  return reply;
};
const edit = (actor, over) => {
  const { profile: _, ...now } = read(actor);
  actor.send({ type: "settings.edited", ...now, ...over });
};
const undo = (actor, step) => actor.send({ type: "step.undone", id: step.id, owner: "settings", payload: step.undo });
const redo = (actor, step) => actor.send({ type: "step.redone", id: step.id, owner: "settings", payload: step.redo });

test("a switch is one step, and Undo then Redo bring the copy back exactly", () => {
  const { actor, steps, settled } = start(storage());
  edit(actor, { vimKeys: true });
  assert.equal(steps.length, 1);
  assert.equal(steps[0].label, "switch Vim keys on");
  assert.deepEqual(steps[0].undo.fields, { vimKeys: false });
  undo(actor, steps[0]);
  assert.equal(read(actor).vimKeys, false);
  redo(actor, steps[0]);
  assert.equal(read(actor).vimKeys, true);
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("several steps undo in a row, and a reload can still undo them", () => {
  const disk = storage();
  const first = start(disk);
  edit(first.actor, { vimKeys: true });
  edit(first.actor, { keepOpen: true });
  const [a, b] = first.steps;
  const again = start(disk);
  undo(again.actor, b);
  undo(again.actor, a);
  assert.deepEqual(again.settled.map((s) => s.outcome), ["applied", "applied"]);
  const now = read(again.actor);
  assert.equal(now.vimKeys, false);
  assert.equal(now.keepOpen, false);
  redo(again.actor, a);
  redo(again.actor, b);
  assert.equal(read(again.actor).keepOpen, true);
});

test("a step is refused when another tab changed the copy since", () => {
  const disk = storage();
  const one = start(disk);
  const two = start(disk);
  edit(one.actor, { vimKeys: true });
  edit(two.actor, { keepOpen: true });
  undo(one.actor, one.steps[0]);
  assert.deepEqual(one.settled.at(-1), { id: one.steps[0].id, owner: "settings", outcome: "refused", reason: "changed" });
});

test("a step another tab took is undone here, and lands in its own profile's copy", () => {
  const disk = storage();
  const one = start(disk);
  edit(one.actor, { vimKeys: true });
  const two = start(disk);
  undo(two.actor, one.steps[0]);
  assert.equal(two.settled.at(-1).outcome, "applied");
  assert.equal(JSON.parse(disk.keys.get("settings:product")).vimKeys, false);
  assert.equal(disk.keys.get("settings"), undefined, "the workshop copy is untouched");
});

test("arranging from the layout switch and the profile switch are no steps", () => {
  const { actor, steps, settled } = start(storage());
  edit(actor, { layoutSwitchHidden: false });
  steps.length = 0;
  actor.send({ type: "layout.switched", arranging: true });
  actor.send({ type: "profile.switched", profile: "workshop" });
  assert.equal(steps.length, 0);
  actor.send({ type: "profile.switched", profile: "product" });
  edit(actor, { vimKeys: true });
  actor.send({ type: "layout.switched", arranging: false });
  undo(actor, steps[0]);
  assert.equal(settled.at(-1).outcome, "applied", "arranging keeps the stamp");
  assert.equal(read(actor).arranging, false, "and the Undo leaves it as it is");
});
