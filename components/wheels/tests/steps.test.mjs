import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// wheels as an owner of steps (12, Undo): what it records for a stretch of rating and a
// delete, and how it applies an Undo or Redo `undo` names to it.

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5CP2";
const NONE = Array(8).fill(null);
const first = (score) => [score, null, null, null, null, null, null, null];
const EMPTY = Array(8).fill({});
const said = (answer) => [answer, {}, {}, {}, {}, {}, {}, {}];

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const savedSchema = schema("../../wheel-sheet/events/wheel.saved.json");

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

// The server's rules (wheels/server): the last write wins, a delete always wins, and a
// restore write names the tombstone's own version.
function fakeApi() {
  const server = new Map();
  const puts = [];
  let seq = 0;
  return {
    server,
    puts,
    put: async (row) => {
      puts.push(structuredClone(row));
      const held = server.get(row.id);
      const { baseVersion, ...rest } = row;
      if (held?.deleted && (row.deleted || baseVersion !== held.version)) return held;
      const r = { ...rest, deleted: Boolean(row.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1, seq: ++seq };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => ({ wheels: [...server.values()].filter((r) => r.seq > since), cursor: seq }),
  };
}

async function start({ store = fakeStore(), userId = null, api = null, today = null } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  const actor = createActor(machine, { input: { store, api, mint, ask: (target) => Promise.resolve(target === "journal" ? (today ? { today } : { error: "no-answerer" }) : { userId }) } });
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
  actor.on("wheel.deleted", (e) => deleted.push(e.id));
  actor.start();
  await flush();
  const save = (over = {}) => {
    const event = { type: "wheel.saved", id: ID, day: DAY, actual: NONE, wanted: NONE, ...over };
    const { type, ...payload } = event;
    assert.ok(savedSchema.validate(payload).valid, JSON.stringify(payload));
    actor.send(event);
  };
  const list = () => new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: { day: DAY }, reply }));
  const held = async (id = ID) => (await list()).wheels.find((w) => w.id === id);
  return { actor, steps, settled, deleted, save, held, store };
}

const undo = (step) => ({ type: "step.undone", id: step.id, owner: "wheels", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "wheels", payload: step.redo });

test("a stretch of rating one wheel is one step, closed by a save that says finished", async () => {
  const s = await start();
  s.save({ actual: first(3) });
  s.save({ actual: first(4) });
  s.save({ actual: first(5), finished: true });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 1);
  assert.equal(s.steps.at(-1).label, "add Wheel of Life");
  s.save({ actual: first(6) });
  s.save({ actual: first(7), finished: true });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2, "the next stretch is a step of its own");
  assert.equal(s.steps.at(-1).label, "edit Wheel of Life");
});

test("a save with nothing new that says finished records nothing and still ends the stretch", async () => {
  const s = await start();
  s.save({ actual: first(3) });
  const count = s.steps.length;
  s.save({ actual: first(3), finished: true });
  assert.equal(s.steps.length, count);
  s.save({ actual: first(4) });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2);
});

test("rating another wheel starts a step of its own", async () => {
  const s = await start();
  s.save({ actual: first(3) });
  s.save({ id: ID2, actual: first(3) });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2);
});

test("Undo of a stretch goes back to before it, not to its last save", async () => {
  const s = await start();
  s.save({ actual: first(3), finished: true });
  s.save({ actual: first(4) });
  s.save({ actual: first(5), wanted: first(9), finished: true });
  s.actor.send(undo(s.steps.at(-1)));
  assert.deepEqual([(await s.held()).actual, (await s.held()).wanted], [first(3), NONE]);
});

test("Undo and Redo put the scores back and make them again, also two steps in a row, and record nothing", async () => {
  const s = await start();
  s.save({ actual: first(3), finished: true });
  s.save({ actual: first(3), wanted: first(9), finished: true });
  const [add, edit] = [s.steps[0], s.steps.at(-1)];
  const count = s.steps.length;
  s.actor.send(undo(edit));
  assert.deepEqual((await s.held()).wanted, NONE);
  s.actor.send(undo(add));
  assert.equal(await s.held(), undefined, "undoing its first stretch deletes a new wheel");
  assert.deepEqual(s.deleted, [ID]);
  s.actor.send(redo(add));
  s.actor.send(redo(edit));
  assert.deepEqual([(await s.held()).actual, (await s.held()).wanted], [first(3), first(9)]);
  assert.deepEqual(s.settled.map((x) => x.outcome), ["applied", "applied", "applied", "applied"]);
  assert.equal(s.steps.length, count, "applying records nothing");
});

test("a delete is one step that asks for the notice; Undo brings the wheel back", async () => {
  const s = await start();
  s.save({ actual: first(3), wanted: first(9), finished: true });
  s.save();
  const removal = s.steps.at(-1);
  assert.deepEqual([removal.label, removal.notice], ["delete Wheel of Life", true]);
  assert.equal(await s.held(), undefined);
  s.actor.send(undo(removal));
  assert.deepEqual([(await s.held()).actual, (await s.held()).wanted], [first(3), first(9)]);
  s.actor.send(redo(removal));
  assert.equal(await s.held(), undefined);
});

test("a delete in the middle of a stretch is a step of its own, and rating is not part of it", async () => {
  const s = await start();
  s.save({ actual: first(3) });
  s.save();
  const [rating, removal] = [s.steps[0], s.steps.at(-1)];
  assert.notEqual(rating.id, removal.id);
  s.actor.send(undo(removal));
  assert.deepEqual((await s.held()).actual, first(3));
});

test("a new wheel with no score, as the view may fold one untouched, records no step", async () => {
  const s = await start();
  s.save({ finished: true });
  assert.deepEqual(s.steps, []);
  assert.deepEqual(s.deleted, []);
});

test("one stretch of answering is one step, and Undo and Redo reverse its answers", async () => {
  const s = await start();
  s.save({ actual: first(3), answers: said({ one: "a" }), finished: true });
  s.save({ actual: first(3), answers: said({ one: "ab" }) });
  s.save({ actual: first(3), answers: said({ one: "abc" }), finished: true });
  const edit = s.steps.at(-1);
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2);
  assert.deepEqual(edit.undo.answers, said({ one: "a" }));
  assert.deepEqual(edit.redo.answers, said({ one: "abc" }));
  s.actor.send(undo(edit));
  assert.deepEqual((await s.held()).answers, said({ one: "a" }));
  s.actor.send(redo(edit));
  assert.deepEqual((await s.held()).answers, said({ one: "abc" }));
});

test("Undo of a wheel's first stretch of answers deletes it, and Redo brings them back", async () => {
  const s = await start();
  s.save({ answers: said({ ten: "Far" }), finished: true });
  const add = s.steps.at(-1);
  assert.equal(add.label, "add Wheel of Life");
  s.actor.send(undo(add));
  assert.equal(await s.held(), undefined);
  s.actor.send(redo(add));
  assert.deepEqual((await s.held()).answers, said({ ten: "Far" }));
});

test("a delete keeps the answers in its step and in its tombstone; Undo brings them back", async () => {
  const s = await start();
  s.save({ actual: first(3), answers: said({ closer: "Walk" }), finished: true });
  s.save({ answers: EMPTY, finished: true });
  const removal = s.steps.at(-1);
  assert.deepEqual([removal.label, removal.notice], ["delete Wheel of Life", true]);
  assert.equal(await s.held(), undefined);
  assert.deepEqual(s.store.rows.get(ID).answers, said({ closer: "Walk" }));
  s.actor.send(undo(removal));
  assert.deepEqual((await s.held()).answers, said({ closer: "Walk" }));
});

test("a step from before answers leaves them as they are; one with bad answers is refused", async () => {
  const s = await start();
  s.save({ actual: first(3), answers: said({ one: "a" }), finished: true });
  s.save({ actual: first(4), finished: true });
  const step = s.steps.at(-1);
  s.actor.send({ type: "step.undone", id: step.id, owner: "wheels", payload: { ...step.undo, answers: "nope" } });
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "wheels", outcome: "refused", reason: "changed" });
  const { answers: _, ...old } = step.undo;
  s.actor.send({ type: "step.undone", id: step.id, owner: "wheels", payload: old });
  assert.equal(s.settled.at(-1).outcome, "applied");
  const wheel = await s.held();
  assert.deepEqual([wheel.actual, wheel.answers], [first(3), said({ one: "a" })]);
});

test("a step can be undone after a reload", async () => {
  const store = fakeStore();
  const s = await start({ store });
  s.save({ actual: first(3), finished: true });
  s.save({ actual: first(4), finished: true });
  const step = s.steps.at(-1);
  s.actor.stop();
  const again = await start({ store });
  again.actor.send(undo(step));
  assert.equal(again.settled.at(-1).outcome, "applied");
  assert.deepEqual((await again.held()).actual, first(3));
});

test("a step whose wheel was written since by another device is refused as changed", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ actual: first(3), finished: true });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  const step = s.steps.at(-1);
  const r = api.server.get(ID);
  api.server.set(ID, { ...r, actual: first(8), version: r.version + 1, seq: 99 });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.deepEqual((await s.held()).actual, first(8));
  s.actor.send(undo(step));
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "wheels", outcome: "refused", reason: "changed" });
});

test("a step with something else than eight scores is refused, and another owner's is left alone", async () => {
  const s = await start();
  s.save({ actual: first(3), finished: true });
  const step = s.steps.at(-1);
  s.actor.send({ type: "step.undone", id: step.id, owner: "wheels", payload: { ...step.undo, actual: [1, 2] } });
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "wheels", outcome: "refused", reason: "changed" });
  const count = s.settled.length;
  s.actor.send({ type: "step.undone", id: step.id, owner: "notes", payload: step.undo });
  assert.equal(s.settled.length, count);
});

test("signed in, Undo of a delete is a restore write naming the tombstone's version", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ actual: first(3), finished: true });
  s.save();
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  const tombstone = api.server.get(ID);
  assert.equal(tombstone.deleted, true);
  s.actor.send(undo(s.steps.at(-1)));
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.deepEqual([api.puts.at(-1).baseVersion, Boolean(api.puts.at(-1).deleted)], [tombstone.version, false]);
  assert.deepEqual([api.server.get(ID).deleted, api.server.get(ID).actual], [false, first(3)]);
  assert.deepEqual((await s.held()).actual, first(3));
});

test("signed in, a restore write carries the answers back to the server", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ actual: first(3), answers: said({ one: "Kept" }), finished: true });
  s.save({ answers: EMPTY, finished: true });
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.equal(api.server.get(ID).deleted, true);
  s.actor.send(undo(s.steps.at(-1)));
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.deepEqual(api.puts.at(-1).answers, said({ one: "Kept" }));
  assert.deepEqual([api.server.get(ID).deleted, api.server.get(ID).answers], [false, said({ one: "Kept" })]);
});

test("a wheel of a day that has closed cannot be undone or redone: refused as closed", async () => {
  const s = await start({ today: DAY });
  s.save({ actual: first(3), finished: true });
  s.save({ actual: first(4), finished: true });
  const edit = s.steps.at(-1);
  s.actor.send(undo(edit));
  assert.equal(s.settled.at(-1).outcome, "applied", "applied while its day is today");
  // The journal's day ends at 2:00 and it announces the new today.
  s.actor.send({ type: "journal.changed", days: [], projects: [], detectors: [], answers: [], open: null, today: "2026-10-15", reason: "no-detector" });
  s.actor.send(redo(edit));
  assert.deepEqual(s.settled.at(-1), { id: edit.id, owner: "wheels", outcome: "refused", reason: "closed" });
  assert.deepEqual((await s.held()).actual, first(3));
});
