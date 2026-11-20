import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, STARTERS } from "../machine.js";

// prompt-sets as an owner of steps (12, Undo): what it records for an add, an edit and a
// delete, and how it applies an Undo or Redo `undo` names to it.

const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const savedSchema = schema("../../prompt-settings/events/prompt-set.saved.json");

const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore() {
  const rows = new Map();
  const outbox = new Map();
  const meta = new Map();
  return {
    rows,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, structuredClone(r)), Promise.resolve()),
    outboxAll: () => Promise.resolve([...outbox.values()]),
    outboxPut: (r) => (outbox.set(r.id, r), Promise.resolve()),
    outboxDelete: (id) => (outbox.delete(id), Promise.resolve()),
    putAll: (sets, queued) => (sets.forEach((r) => rows.set(r.id, structuredClone(r))), queued.forEach((r) => outbox.set(r.id, r)), Promise.resolve()),
    metaGet: (k) => Promise.resolve(meta.get(k)),
    metaPut: (k, v) => (meta.set(k, v), Promise.resolve()),
  };
}

// The server's rules (prompt-sets/server): the last write wins, a delete always wins, a
// restore write names the tombstone's own version, a starter is added only when absent.
function fakeApi() {
  const server = new Map();
  const puts = [];
  let seq = 0;
  return {
    server,
    puts,
    starters: async (rows) => ({
      sets: rows.map(({ baseVersion, starter, ...rest }) => {
        if (!server.has(rest.id)) server.set(rest.id, { ...rest, deleted: false, version: (baseVersion || 0) + 1, seq: ++seq });
        return server.get(rest.id);
      }),
    }),
    put: async (row) => {
      puts.push(structuredClone(row));
      const held = server.get(row.id);
      const { baseVersion, ...rest } = row;
      if (held?.deleted && (row.deleted || baseVersion !== held.version)) return held;
      const r = { ...rest, deleted: Boolean(row.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1, seq: ++seq };
      server.set(row.id, r);
      return r;
    },
    pull: async (since) => ({ sets: [...server.values()].filter((r) => r.seq > since), cursor: seq }),
  };
}

async function start({ store = fakeStore(), userId = null, api = null } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  const actor = createActor(machine, { input: { store, api, mint, ask: () => Promise.resolve({ userId }) } });
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
  actor.on("prompt-set.deleted", (e) => deleted.push(e.id));
  actor.start();
  await flush();
  const save = (over = {}) => {
    const payload = { id: ID, name: "Mine", occasion: "", basedOn: "", prompts: ["How was today?"], position: "1", ...over };
    assert.ok(savedSchema.validate(payload).valid);
    actor.send({ type: "prompt-set.saved", ...payload });
  };
  const list = () => new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply }));
  const held = async (id = ID) => (await list()).sets.find((c) => c.id === id);
  return { actor, steps, settled, deleted, save, held, store };
}

const undo = (step) => ({ type: "step.undone", id: step.id, owner: "prompt-sets", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "prompt-sets", payload: step.redo });

test("every save that changes a set is one step, named after the set", async () => {
  const s = await start();
  assert.equal(s.steps.length, 0, "the starter sets are no step");
  s.save();
  s.save({ prompts: ["How was today?", "What next?"] });
  s.save({ prompts: ["How was today?", "What next?"] });
  s.save({ deleted: true });
  assert.deepEqual(s.steps.map((x) => x.label), ["add prompt set Mine", "edit prompt set Mine", "delete prompt set Mine"]);
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 3);
  assert.equal(s.steps[2].notice, true, "a delete asks for the notice");
  assert.equal(s.steps[1].notice, undefined);
});

test("Undo and Redo put a set back and make it again, two steps in a row, and record nothing", async () => {
  const s = await start();
  s.save();
  s.save({ name: "Mine too", prompts: ["How was today?", "What next?"] });
  const [add, edit] = s.steps;
  s.actor.send(undo(edit));
  assert.deepEqual([(await s.held()).name, (await s.held()).prompts], ["Mine", ["How was today?"]]);
  s.actor.send(undo(add));
  assert.equal(await s.held(), undefined, "undoing an add deletes the set");
  assert.deepEqual(s.deleted, [ID]);
  s.actor.send(redo(add));
  s.actor.send(redo(edit));
  assert.deepEqual((await s.held()).prompts, ["How was today?", "What next?"]);
  assert.deepEqual(s.settled.map((x) => x.outcome), ["applied", "applied", "applied", "applied"]);
  assert.equal(s.steps.length, 2, "applying records nothing");
});

test("Undo of a starter's delete brings it back as it came", async () => {
  const s = await start();
  const first = STARTERS[0];
  s.save({ ...first, deleted: true });
  const removal = s.steps.at(-1);
  assert.equal(removal.label, "delete prompt set Small truths");
  assert.equal(await s.held(first.id), undefined);
  s.actor.send(undo(removal));
  assert.deepEqual((await s.held(first.id)).prompts, first.prompts);
  s.actor.send(redo(removal));
  assert.equal(await s.held(first.id), undefined);
});

test("a step can be undone after a reload", async () => {
  const store = fakeStore();
  const s = await start({ store });
  s.save();
  s.save({ name: "Renamed" });
  const step = s.steps.at(-1);
  s.actor.stop();
  const again = await start({ store });
  again.actor.send(undo(step));
  assert.equal(again.settled.at(-1).outcome, "applied");
  assert.equal((await again.held()).name, "Mine");
});

test("a step whose set was written since by another device is refused as changed", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save();
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  const step = s.steps.at(-1);
  const r = api.server.get(ID);
  api.server.set(ID, { ...r, name: "From the phone", version: r.version + 1, seq: 99 });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await s.held()).name, "From the phone");
  s.actor.send(undo(step));
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "prompt-sets", outcome: "refused", reason: "changed" });
});

test("signed in, Undo of a delete is a restore write naming the tombstone's version", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save();
  s.save({ deleted: true });
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  const tombstone = api.server.get(ID);
  assert.equal(tombstone.deleted, true);
  s.actor.send(undo(s.steps.at(-1)));
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.deepEqual([api.puts.at(-1).baseVersion, Boolean(api.puts.at(-1).deleted)], [tombstone.version, false]);
  assert.deepEqual([api.server.get(ID).deleted, api.server.get(ID).name], [false, "Mine"]);
  assert.equal((await s.held()).name, "Mine");
});

test("a step of another owner, or one that names no set, is left alone or refused", async () => {
  const s = await start();
  s.actor.send({ type: "step.undone", id: "01ARZ3NDEKTSV4RRFFQ69G9999", owner: "notes", payload: {} });
  assert.equal(s.settled.length, 0);
  s.actor.send({ type: "step.undone", id: "01ARZ3NDEKTSV4RRFFQ69G9999", owner: "prompt-sets", payload: { kind: "prompt-set", id: ID } });
  assert.deepEqual(s.settled.at(-1).outcome, "refused");
});
