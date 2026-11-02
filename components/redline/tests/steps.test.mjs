import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// redline as an owner of steps (12, Undo): a paste, a comment, a removal and a clear are
// steps, and typing in one comment is one step until the user leaves it. Storage is a
// fake shared by two machines, as two tabs share localStorage.

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
  const store = disk.io("redline");
  const stamp = disk.io("redline:step");
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

const now = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  return reply.redline;
};
const save = (actor, text, comments = [], left) => actor.send({ type: "redline.saved", text, comments, ...(left ? { left } : {}) });
const undo = (actor, step) => actor.send({ type: "step.undone", id: step.id, owner: "redline", payload: step.undo });
const redo = (actor, step) => actor.send({ type: "step.redone", id: step.id, owner: "redline", payload: step.redo });

const TEXT = "A book was read.";
const C = "01ARZ3NDEKTSV4RRFFQ69G5CC1";
const comment = (text) => ({ id: C, start: 2, end: 6, quote: "book", text });

test("a paste is a step, and Undo then Redo bring the redline back exactly", () => {
  const { actor, steps, settled } = start(storage());
  save(actor, TEXT);
  assert.equal(steps[0].label, "paste a text");
  undo(actor, steps[0]);
  assert.equal(now(actor), null);
  redo(actor, steps[0]);
  assert.deepEqual(now(actor), { text: TEXT, comments: [] });
  assert.deepEqual(settled.map((s) => s.outcome), ["applied", "applied"]);
});

test("typing in one comment is one step until the user leaves it", () => {
  const { actor, steps } = start(storage());
  save(actor, TEXT);
  save(actor, TEXT, [comment("s")]);
  save(actor, TEXT, [comment("say")]);
  save(actor, TEXT, [comment("say")], true);
  save(actor, TEXT, [comment("say more")]);
  const ids = [...new Set(steps.map((s) => s.id))];
  assert.equal(ids.length, 3, "the paste, the comment, and the typing after leaving it");
  const typing = steps.filter((s) => s.id === ids[1]);
  assert.equal(typing.at(-1).label, "comment on “book”");
  assert.deepEqual(typing.at(-1).undo.redline, { text: TEXT, comments: [] });
});

test("several steps undo in a row, also after a reload", () => {
  const disk = storage();
  const one = start(disk);
  save(one.actor, TEXT);
  save(one.actor, TEXT, [comment("x")], true);
  save(one.actor, TEXT, []);
  const ids = [...new Set(one.steps.map((s) => s.id))];
  const last = (id) => one.steps.filter((s) => s.id === id).at(-1);
  assert.equal(last(ids[2]).label, "remove a comment");
  const two = start(disk);
  for (const id of [...ids].reverse()) undo(two.actor, last(id));
  assert.deepEqual(two.settled.map((s) => s.outcome), ["applied", "applied", "applied"]);
  assert.equal(now(two.actor), null);
});

test("a step is refused when another tab wrote the redline since", () => {
  const disk = storage();
  const one = start(disk);
  const two = start(disk);
  save(one.actor, TEXT);
  save(two.actor, "Another text.");
  undo(one.actor, one.steps[0]);
  assert.deepEqual(one.settled.at(-1), { id: one.steps[0].id, owner: "redline", outcome: "refused", reason: "changed" });
});
