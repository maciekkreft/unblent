import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// choice-points as an owner of steps (12, Undo): what it records for a stretch of typing
// and a delete, and how it applies an Undo or Redo `undo` names to it.

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const savedSchema = schema("../../choice-point-cards/events/choice-point.saved.json");

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

// The server's rules (choice-points/server): the last write wins, a delete always wins,
// and a restore write names the tombstone's own version.
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
    pull: async (since) => ({ choicePoints: [...server.values()].filter((r) => r.seq > since), cursor: seq }),
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
  actor.on("choice-point.deleted", (e) => deleted.push(e.id));
  actor.start();
  await flush();
  const save = (over = {}) => {
    const event = { type: "choice-point.saved", id: ID, day: DAY, situation: "", thoughts: "", away: "", towards: "", ...over };
    const { type, ...payload } = event;
    assert.ok(savedSchema.validate(payload).valid);
    actor.send(event);
  };
  const list = () => new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: { day: DAY }, reply }));
  const held = async () => (await list()).choicePoints.find((c) => c.id === ID);
  return { actor, steps, settled, deleted, save, held, store };
}

const undo = (step) => ({ type: "step.undone", id: step.id, owner: "choice-points", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "choice-points", payload: step.redo });
const finished = (field, text) => ({ finished: [{ field, text }] });

test("a stretch of typing in one choice point is one step, closed when the user finishes a line", async () => {
  const s = await start();
  s.save({ situation: "Mee" });
  s.save({ situation: "Meeting ran late", ...finished("situation", "Meeting ran late") });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 1);
  assert.equal(s.steps.at(-1).label, "add choice point Meeting ran late");
  s.save({ situation: "Meeting ran late", away: "Skip" });
  s.save({ situation: "Meeting ran late", away: "Skipped dinner", ...finished("away", "Skipped dinner") });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2, "the next stretch is a step of its own");
  assert.equal(s.steps.at(-1).label, "edit choice point Meeting ran late");
});

test("Undo and Redo put the texts back and make them again, also two steps in a row, and record nothing", async () => {
  const s = await start();
  s.save({ situation: "Meeting", ...finished("situation", "Meeting") });
  s.save({ situation: "Meeting", towards: "Called Sam", ...finished("towards", "Called Sam") });
  const [add, edit] = [s.steps[0], s.steps.at(-1)];
  const count = s.steps.length;
  s.actor.send(undo(edit));
  assert.equal((await s.held()).towards, "");
  s.actor.send(undo(add));
  assert.equal(await s.held(), undefined, "undoing its first stretch deletes a new choice point");
  assert.deepEqual(s.deleted, [ID]);
  s.actor.send(redo(add));
  s.actor.send(redo(edit));
  assert.deepEqual([(await s.held()).situation, (await s.held()).towards], ["Meeting", "Called Sam"]);
  assert.deepEqual(s.settled.map((x) => x.outcome), ["applied", "applied", "applied", "applied"]);
  assert.equal(s.steps.length, count, "applying records nothing");
});

test("a delete is one step that asks for the notice; Undo brings the choice point back", async () => {
  const s = await start();
  s.save({ situation: "Meeting", away: "Skipped dinner", ...finished("away", "Skipped dinner") });
  s.save();
  const removal = s.steps.at(-1);
  assert.deepEqual([removal.label, removal.notice], ["delete choice point Meeting", true]);
  assert.equal(await s.held(), undefined);
  s.actor.send(undo(removal));
  assert.deepEqual([(await s.held()).situation, (await s.held()).away], ["Meeting", "Skipped dinner"]);
  s.actor.send(redo(removal));
  assert.equal(await s.held(), undefined);
});

test("a step can be undone after a reload", async () => {
  const store = fakeStore();
  const s = await start({ store });
  s.save({ situation: "Meeting", ...finished("situation", "Meeting") });
  s.save({ situation: "Meeting", thoughts: "I'm failing", ...finished("thoughts", "I'm failing") });
  const step = s.steps.at(-1);
  s.actor.stop();
  const again = await start({ store });
  again.actor.send(undo(step));
  assert.equal(again.settled.at(-1).outcome, "applied");
  assert.equal((await again.held()).thoughts, "");
});

test("a step whose choice point was written since by another device is refused as changed", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ situation: "Meeting", ...finished("situation", "Meeting") });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  const step = s.steps.at(-1);
  const r = api.server.get(ID);
  api.server.set(ID, { ...r, situation: "From the phone", version: r.version + 1, seq: 99 });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await s.held()).situation, "From the phone");
  s.actor.send(undo(step));
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "choice-points", outcome: "refused", reason: "changed" });
});

test("signed in, Undo of a delete is a restore write naming the tombstone's version", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ situation: "Meeting", ...finished("situation", "Meeting") });
  s.save();
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  const tombstone = api.server.get(ID);
  assert.equal(tombstone.deleted, true);
  s.actor.send(undo(s.steps.at(-1)));
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.deepEqual([api.puts.at(-1).baseVersion, Boolean(api.puts.at(-1).deleted)], [tombstone.version, false]);
  assert.deepEqual([api.server.get(ID).deleted, api.server.get(ID).situation], [false, "Meeting"]);
  assert.equal((await s.held()).situation, "Meeting");
});

test("a choice point of a day that has closed cannot be undone or redone: refused as closed", async () => {
  const s = await start({ today: DAY });
  s.save({ situation: "Meeting", ...finished("situation", "Meeting") });
  s.save({ situation: "Meeting", away: "Skipped dinner", ...finished("away", "Skipped dinner") });
  const edit = s.steps.at(-1);
  s.actor.send(undo(edit));
  assert.equal(s.settled.at(-1).outcome, "applied", "applied while its day is today");
  // The journal's day ends at 2:00 and it announces the new today.
  s.actor.send({ type: "journal.changed", days: [], projects: [], detectors: [], answers: [], open: null, today: "2026-10-15", reason: "no-detector" });
  s.actor.send(redo(edit));
  assert.deepEqual(s.settled.at(-1), { id: edit.id, owner: "choice-points", outcome: "refused", reason: "closed" });
  assert.equal((await s.held()).away, "");
});
