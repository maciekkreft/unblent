import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// matrices as an owner of steps (12, Undo): what it records for a stretch of changes and a
// delete, and how it applies an Undo or Redo `undo` names to it.

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const T1 = "01ARZ3NDEKTSV4RRFFQ69G5TA1";
const T2 = "01ARZ3NDEKTSV4RRFFQ69G5TA2";
const task = (over = {}) => ({ id: T1, text: "Call the bank", place: null, done: false, ...over });

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const savedSchema = schema("../../matrix-sheet/events/matrix.saved.json");

const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore() {
  const rows = new Map();
  const outbox = new Map();
  const meta = new Map();
  return {
    rows,
    outbox,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, structuredClone(r)), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

// The server's rules (matrices/server): the last write wins, a delete always wins, and a
// restore write names the tombstone's own version.
function fakeApi() {
  const server = new Map();
  const puts = [];
  let seq = 0;
  return {
    server,
    puts,
    bump: (id, over) => {
      const r = server.get(id);
      server.set(id, { ...r, ...over, version: r.version + 1, seq: ++seq });
    },
    put: async (row) => {
      puts.push(structuredClone(row));
      const held = server.get(row.id);
      const { baseVersion, ...rest } = row;
      if (held?.deleted && (row.deleted || baseVersion !== held.version)) return held;
      const r = { ...rest, deleted: Boolean(row.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1, seq: ++seq };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => ({ matrices: [...server.values()].filter((r) => r.seq > since), cursor: seq }),
  };
}

async function start({ store = fakeStore(), userId = null, api = null, today = null } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  const ask = (target) =>
    Promise.resolve(target === "journal" ? (today ? { today } : { error: "no-answerer" }) : target === "session" ? { userId } : { error: "no-answerer" });
  const actor = createActor(machine, { input: { store, api, mint, ask } });
  const steps = [];
  const settled = [];
  const deleted = [];
  actor.on("step.recorded", ({ type, ...p }) => {
    assert.ok(recordedSchema.validate(p).valid, JSON.stringify(p));
    steps.push(p);
  });
  actor.on("step.settled", ({ type, ...p }) => {
    assert.ok(settledSchema.validate(p).valid, JSON.stringify(p));
    settled.push(p);
  });
  actor.on("matrix.deleted", (e) => deleted.push(e.id));
  actor.start();
  await flush();
  const save = (over = {}) => {
    const event = { type: "matrix.saved", id: ID, day: DAY, tasks: [task()], ...over };
    const { type, ...payload } = event;
    assert.ok(savedSchema.validate(payload).valid, JSON.stringify(payload));
    actor.send(event);
  };
  const list = () => new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: { day: DAY }, reply }));
  const held = async (id = ID) => (await list()).matrices.find((m) => m.id === id);
  return { actor, steps, settled, deleted, save, held, store };
}

const undo = (step) => ({ type: "step.undone", id: step.id, owner: "matrices", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "matrices", payload: step.redo });

test("a stretch of typing in one matrix is one step, closed by a save that says finished", async () => {
  const s = await start();
  s.save({ tasks: [task({ text: "C" })] });
  s.save({ tasks: [task({ text: "Ca" })] });
  s.save({ tasks: [task({ text: "Call" })], finished: true });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 1);
  assert.equal(s.steps.at(-1).label, "add Eisenhower Matrix");
  s.save({ tasks: [task({ text: "Call", place: "do" })], finished: true });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2, "the next change is a step of its own");
  assert.equal(s.steps.at(-1).label, "edit Eisenhower Matrix");
});

test("a save with nothing new that says finished records nothing and still ends the stretch", async () => {
  const s = await start();
  s.save({ tasks: [task({ text: "C" })] });
  const count = s.steps.length;
  s.save({ tasks: [task({ text: "C" })], finished: true });
  assert.equal(s.steps.length, count);
  s.save({ tasks: [task({ text: "Ca" })] });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2);
});

test("Undo of a stretch goes back to before it; Undo and Redo of words, place, tick and order record nothing", async () => {
  const s = await start();
  s.save({ tasks: [task(), task({ id: T2, text: "B" })], finished: true });
  s.save({ tasks: [task({ id: T2, text: "B", done: true }), task({ text: "Call the bank now", place: "do" })], finished: true });
  const [add, edit] = [s.steps[0], s.steps.at(-1)];
  const count = s.steps.length;
  s.actor.send(undo(edit));
  assert.deepEqual((await s.held()).tasks, [task(), task({ id: T2, text: "B" })]);
  s.actor.send(undo(add));
  assert.equal(await s.held(), undefined, "undoing its first stretch deletes a new matrix");
  assert.deepEqual(s.deleted, [ID]);
  s.actor.send(redo(add));
  s.actor.send(redo(edit));
  assert.deepEqual((await s.held()).tasks, [task({ id: T2, text: "B", done: true }), task({ text: "Call the bank now", place: "do" })]);
  assert.deepEqual(s.settled.map((x) => x.outcome), ["applied", "applied", "applied", "applied"]);
  assert.equal(s.steps.length, count, "applying records nothing");
});

test("a save that leaves no task is one step that asks for the notice; Undo brings the matrix back", async () => {
  const s = await start();
  s.save({ tasks: [task({ place: "schedule" })], finished: true });
  s.save({ tasks: [] });
  const removal = s.steps.at(-1);
  assert.deepEqual([removal.label, removal.notice], ["delete Eisenhower Matrix", true]);
  assert.equal(await s.held(), undefined);
  s.actor.send(undo(removal));
  assert.deepEqual((await s.held()).tasks, [task({ place: "schedule" })]);
  s.actor.send(redo(removal));
  assert.equal(await s.held(), undefined);
});

test("changing another matrix starts a step of its own, and an empty new matrix records none", async () => {
  const s = await start();
  s.save({ tasks: [task()] });
  s.save({ id: ID2, day: "2026-10-13", tasks: [task()] });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2);
  const count = s.steps.length;
  s.save({ id: "01ARZ3NDEKTSV4RRFFQ69G5CP3", day: "2026-10-12", tasks: [], finished: true });
  assert.equal(s.steps.length, count);
});

test("a step can be undone after a reload", async () => {
  const store = fakeStore();
  const s = await start({ store });
  s.save({ finished: true });
  s.save({ tasks: [task({ done: true })], finished: true });
  const step = s.steps.at(-1);
  s.actor.stop();
  const again = await start({ store });
  again.actor.send(undo(step));
  assert.equal(again.settled.at(-1).outcome, "applied");
  assert.equal((await again.held()).tasks[0].done, false);
});

test("a step whose tasks were written since by another device is refused as changed", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ finished: true });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  const step = s.steps.at(-1);
  api.bump(ID, { tasks: [task({ place: "drop" })] });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await s.held()).tasks[0].place, "drop");
  s.actor.send(undo(step));
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "matrices", outcome: "refused", reason: "changed" });
});

test("a step with tasks that cannot be read is refused, and another owner's is left alone", async () => {
  const s = await start();
  s.save({ finished: true });
  const step = s.steps.at(-1);
  s.actor.send({ type: "step.undone", id: step.id, owner: "matrices", payload: { ...step.undo, tasks: [{ id: "x" }] } });
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "matrices", outcome: "refused", reason: "changed" });
  const count = s.settled.length;
  s.actor.send({ type: "step.undone", id: step.id, owner: "wheels", payload: step.undo });
  assert.equal(s.settled.length, count);
});

test("signed in, Undo of a delete is a restore write naming the tombstone's version", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ tasks: [task({ place: "do" })], finished: true });
  s.save({ tasks: [] });
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  const tombstone = api.server.get(ID);
  assert.equal(tombstone.deleted, true);
  s.actor.send(undo(s.steps.at(-1)));
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.deepEqual([api.puts.at(-1).baseVersion, Boolean(api.puts.at(-1).deleted)], [tombstone.version, false]);
  assert.deepEqual([api.server.get(ID).deleted, api.server.get(ID).tasks], [false, [task({ place: "do" })]]);
  assert.deepEqual((await s.held()).tasks, [task({ place: "do" })]);
});

test("a matrix of a day that has closed cannot be undone or redone: refused as closed", async () => {
  const s = await start({ today: DAY });
  s.save({ finished: true });
  s.save({ tasks: [task({ done: true })], finished: true });
  const edit = s.steps.at(-1);
  s.actor.send(undo(edit));
  assert.equal(s.settled.at(-1).outcome, "applied", "applied while its day is today");
  // The journal's day ends at 2:00 and it announces the new today.
  s.actor.send({ type: "journal.changed", days: [], projects: [], detectors: [], answers: [], open: null, today: "2026-10-15", reason: "no-detector" });
  s.actor.send(redo(edit));
  assert.deepEqual(s.settled.at(-1), { id: edit.id, owner: "matrices", outcome: "refused", reason: "closed" });
  assert.equal((await s.held()).tasks[0].done, false);
});
