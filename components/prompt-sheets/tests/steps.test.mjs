import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// prompt-sheets as an owner of steps (12, Undo): what it records for a stretch of typing
// and a removal, and how it applies an Undo or Redo `undo` names to it.

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5PS1";
const SET = "01ARZ3NDEKTSV4RRFFQ69G5ST1";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");
const savedSchema = schema("../../prompt-sheet/events/prompt-sheet.saved.json");

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

// The server's rules (prompt-sheets/server): the last write wins, a delete always wins,
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
    pull: async (since) => ({ sheets: [...server.values()].filter((r) => r.seq > since), cursor: seq }),
  };
}

const answers = (...texts) => texts.map((answer, i) => ({ prompt: `Prompt ${i + 1}?`, answer }));

async function start({ store = fakeStore(), userId = null, api = null, today = null } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  const ask = (target) => Promise.resolve(target === "journal" ? (today ? { today } : { error: "no-answerer" }) : target === "evaluators" ? { evaluators: [] } : { userId });
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
  actor.on("prompt-sheet.deleted", (e) => deleted.push(e.id));
  actor.start();
  await flush();
  const save = (over = {}) => {
    const event = { type: "prompt-sheet.saved", id: ID, day: DAY, setId: SET, setName: "Evening review", basedOn: "", answers: answers("", ""), ...over };
    const { type, ...payload } = event;
    assert.ok(savedSchema.validate(payload).valid);
    actor.send(event);
  };
  const held = () => new Promise((reply) => actor.send({ type: "read?", cid: "c", payload: { id: ID }, reply })).then((r) => r.sheet ?? undefined);
  return { actor, steps, settled, deleted, save, held, store };
}

const undo = (step) => ({ type: "step.undone", id: step.id, owner: "prompt-sheets", payload: step.undo });
const redo = (step) => ({ type: "step.redone", id: step.id, owner: "prompt-sheets", payload: step.redo });
const texts = async (s) => (await s.held())?.answers.map((a) => a.answer);

test("a stretch of typing in one sheet is one step, closed when a save says finished", async () => {
  const s = await start();
  s.save({ answers: answers("A wa", "") });
  s.save({ answers: answers("A walk", ""), finished: true });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 1);
  assert.equal(s.steps.at(-1).label, "add journal prompts Evening review");
  s.save({ answers: answers("A walk", "Less") });
  s.save({ answers: answers("A walk", "Less phone"), finished: true });
  assert.equal(new Set(s.steps.map((x) => x.id)).size, 2, "the next stretch is a step of its own");
  assert.equal(s.steps.at(-1).label, "edit journal prompts Evening review");
  assert.deepEqual(s.steps.at(-1).undo.answers, [{ prompt: "Prompt 1?", answer: "A walk" }, { prompt: "Prompt 2?", answer: "" }], "a step carries the user's own fields");
});

test("Undo and Redo put the answers back and make them again, and record nothing", async () => {
  const s = await start();
  s.save({ answers: answers("A walk", ""), finished: true });
  s.save({ answers: answers("A walk", "Less phone"), finished: true });
  const [add, edit] = [s.steps[0], s.steps.at(-1)];
  const count = s.steps.length;
  s.actor.send(undo(edit));
  assert.deepEqual(await texts(s), ["A walk", ""]);
  s.actor.send(undo(add));
  assert.equal(await s.held(), undefined, "undoing its first stretch deletes a new sheet");
  assert.deepEqual(s.deleted, [ID]);
  s.actor.send(redo(add));
  s.actor.send(redo(edit));
  assert.deepEqual(await texts(s), ["A walk", "Less phone"]);
  assert.deepEqual(s.settled.map((x) => x.outcome), ["applied", "applied", "applied", "applied"]);
  assert.equal(s.steps.length, count, "applying records nothing");
});

test("a removal is one step that asks for the notice; Undo brings the sheet back", async () => {
  const s = await start();
  s.save({ answers: answers("A walk", "Less phone"), finished: true });
  s.save({ answers: answers("A walk", "Less phone"), deleted: true });
  const removal = s.steps.at(-1);
  assert.deepEqual([removal.label, removal.notice], ["delete journal prompts Evening review", true]);
  assert.equal(await s.held(), undefined);
  s.actor.send(undo(removal));
  assert.deepEqual(await texts(s), ["A walk", "Less phone"]);
  s.actor.send(redo(removal));
  assert.equal(await s.held(), undefined);
});

test("a step can be undone after a reload", async () => {
  const store = fakeStore();
  const s = await start({ store });
  s.save({ answers: answers("A walk", ""), finished: true });
  s.save({ answers: answers("A walk", "Less phone"), finished: true });
  const step = s.steps.at(-1);
  s.actor.stop();
  const again = await start({ store });
  again.actor.send(undo(step));
  assert.equal(again.settled.at(-1).outcome, "applied");
  assert.deepEqual(await texts(again), ["A walk", ""]);
});

test("a step whose sheet was written since by another device is refused as changed", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ answers: answers("A walk", ""), finished: true });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  const step = s.steps.at(-1);
  const r = api.server.get(ID);
  api.server.set(ID, { ...r, answers: [{ prompt: "Prompt 1?", answer: "From the phone", fits: null }], version: r.version + 1, seq: 99 });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.deepEqual(await texts(s), ["From the phone"]);
  s.actor.send(undo(step));
  assert.deepEqual(s.settled.at(-1), { id: step.id, owner: "prompt-sheets", outcome: "refused", reason: "changed" });
});

test("a judgement written elsewhere does not refuse an Undo", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ answers: answers("A walk", ""), finished: true });
  s.save({ answers: answers("A walk", "Less phone"), finished: true });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  const step = s.steps.at(-1);
  const r = api.server.get(ID);
  api.server.set(ID, { ...r, answers: r.answers.map((a) => ({ ...a, fits: true })), version: r.version + 1, seq: 99 });
  s.actor.send({ type: "_sync", pull: true });
  await flush();
  s.actor.send(undo(step));
  assert.equal(s.settled.at(-1).outcome, "applied");
  assert.deepEqual((await s.held()).answers, [
    { prompt: "Prompt 1?", answer: "A walk", fits: true },
    { prompt: "Prompt 2?", answer: "", fits: null },
  ], "the restored answer keeps its judgement while its words are the same");
});

test("signed in, Undo of a removal is a restore write naming the tombstone's version", async () => {
  const api = fakeApi();
  const s = await start({ userId: "u1", api });
  s.save({ answers: answers("A walk"), finished: true });
  s.save({ answers: answers("") });
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  const tombstone = api.server.get(ID);
  assert.equal(tombstone.deleted, true);
  s.actor.send(undo(s.steps.at(-1)));
  s.actor.send({ type: "_sync", pull: false });
  await flush();
  assert.deepEqual([api.puts.at(-1).baseVersion, Boolean(api.puts.at(-1).deleted)], [tombstone.version, false]);
  assert.equal(api.server.get(ID).deleted, false);
  assert.deepEqual(await texts(s), ["A walk"]);
});

test("a sheet of a day that has closed cannot be undone or redone: refused as closed", async () => {
  const s = await start({ today: DAY });
  s.save({ answers: answers("A walk", ""), finished: true });
  s.save({ answers: answers("A walk", "Less phone"), finished: true });
  const edit = s.steps.at(-1);
  s.actor.send(undo(edit));
  assert.equal(s.settled.at(-1).outcome, "applied", "applied while its day is today");
  s.actor.send({ type: "journal.changed", today: "2026-10-15" });
  s.actor.send(redo(edit));
  assert.deepEqual(s.settled.at(-1), { id: edit.id, owner: "prompt-sheets", outcome: "refused", reason: "closed" });
  assert.deepEqual(await texts(s), ["A walk", ""]);
});
