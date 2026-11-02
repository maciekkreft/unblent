import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// evaluators as an owner of steps (12, Undo): what it records for a save, a switch, a
// move, a delete, a starter tick and Start over, and how it applies an Undo or Redo
// `undo` names to it. The server is a small fake that versions rows the way
// evaluators/server/router.py does, so a restore write is checked against the
// tombstone's version.

const SYNC_IDLE_MS = 2000;
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const JOURNAL = "00000000000000000000000JRN";
const A = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const B = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5QQ1";
const Q2 = "01ARZ3NDEKTSV4RRFFQ69G5QQ2";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G50P1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G50P2";

const schema = (path) => new Validator(JSON.parse(readFileSync(new URL(path, import.meta.url))), "2020-12");
const recordedSchema = schema("../events/step.recorded.json");
const settledSchema = schema("../events/step.settled.json");

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const yesno = (id = Q1, text = "Is it a goal?") => ({ id, on: true, kind: "yesno", text, yes: "", no: "", options: [] });
const pick = () => ({
  id: Q2,
  on: true,
  kind: "pick",
  text: "Goal or value?",
  yes: "",
  no: "",
  options: [
    { id: O1, name: "Goal", description: "" },
    { id: O2, name: "Value", description: "" },
  ],
});
const row = (id, over = {}) => ({ id, book: BOOK, name: "Goals", description: "", on: true, questions: [yesno()], version: 1, ...over });
const saved = (id, over = {}) => ({ type: "evaluator.saved", id, book: BOOK, name: "Goals", description: "", questions: [yesno()], ...over });

function memory(initial = [], userId) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  const outbox = new Map();
  const meta = new Map(userId ? [["userId", userId]] : []);
  return {
    rows,
    outbox,
    all: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    outboxAll: async () => [...outbox.values()],
    outboxPut: async (r) => void outbox.set(r.id, r),
    outboxDelete: async (id) => void outbox.delete(id),
    metaGet: async (k) => meta.get(k),
    metaPut: async (k, v) => void meta.set(k, v),
  };
}

// The server's rows: last write wins, a write onto a tombstone returns it, unless it is
// the restore write naming the tombstone's own version (router.py _write).
function server(initial = []) {
  const rows = new Map(initial.map((r) => [r.id, { ...r, deleted: false }]));
  const puts = [];
  let pulled = [];
  return {
    rows,
    puts,
    put: async (r) => {
      puts.push(r);
      const held = rows.get(r.id);
      if (!("name" in r)) {
        if (!held) return { id: r.id, missing: true };
        rows.set(r.id, { ...held, position: r.position });
        return rows.get(r.id);
      }
      if (held?.deleted && !(r.restore && !r.deleted && r.baseVersion === held.version)) return held;
      const { baseVersion, restore, ...rest } = r;
      const next = { ...held, ...rest, deleted: Boolean(r.deleted), version: held ? held.version + 1 : (baseVersion || 0) + 1 };
      rows.set(r.id, next);
      return next;
    },
    pull: async (since) => {
      const out = pulled;
      pulled = [];
      return { evaluators: out, cursor: since + out.length };
    },
    // Another device's write, which this browser learns of from a pull.
    elsewhere: (id, over) => {
      const next = { ...rows.get(id), ...over, version: rows.get(id).version + 1 };
      rows.set(id, next);
      pulled.push(next);
    },
    starters: async () => ({ evaluators: [{ name: "Clear goal", description: "", questions: [yesno()] }] }),
  };
}

async function start({ store = memory(), api, userId = null, tryPage = null } = {}) {
  let minted = 0;
  const mint = () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}`;
  let ids = 0;
  const newId = () => `01ARZ3NDEKTSV4RRFFQ69HC${String(++ids).padStart(3, "0")}`;
  const clock = new SimulatedClock();
  const ask = (target, name) => {
    if (target === "session") return Promise.resolve({ userId });
    if (target === "books") return Promise.resolve({ books: [{ id: JOURNAL, written: true }] });
    return Promise.resolve({ error: "no-answerer" });
  };
  const actor = createActor(machine, { input: { store, api, ask, mint, newId, tryPage, now: () => "2026-11-02T10:00:00.000Z" }, clock });
  const steps = [];
  const settled = [];
  actor.on("step.recorded", ({ type, ...p }) => {
    assert.ok(recordedSchema.validate(p).valid, JSON.stringify(p));
    steps.push(p);
  });
  actor.on("step.settled", ({ type, ...p }) => {
    assert.ok(settledSchema.validate(p).valid, JSON.stringify(p));
    settled.push(p);
  });
  actor.start();
  await flush();
  // `undo` keeps the latest recording of an id, with the first one's undo (12, Undo).
  const step = (n) => {
    const all = steps.filter((s) => s.id === steps.at(n).id);
    return { ...all.at(-1), undo: all[0].undo };
  };
  const undo = async (s) => {
    actor.send({ type: "step.undone", id: s.id, owner: s.owner, payload: s.undo });
    await flush();
    return settled.at(-1);
  };
  const redo = async (s) => {
    actor.send({ type: "step.redone", id: s.id, owner: s.owner, payload: s.redo });
    await flush();
    return settled.at(-1);
  };
  const sync = async () => {
    clock.increment(SYNC_IDLE_MS);
    await flush();
  };
  const listed = () =>
    new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: {}, reply })).then((r) => r.evaluators);
  return { actor, steps, settled, step, undo, redo, sync, listed, store, clock };
}

const text = (r) => ({ name: r.name, description: r.description, questions: r.questions.map(({ removing, ...q }) => ({ ...q, options: q.options.map(({ removing: _, ...o }) => o) })) });

test("adding an evaluator is a step; typing on in its name joins it, Undo deletes it and Redo brings it back", async () => {
  const h = await start();
  const blank = [yesno(Q1, "")];
  h.actor.send(saved(A, { name: "G", questions: blank }));
  h.actor.send(saved(A, { name: "Go", questions: blank }));
  h.actor.send(saved(A, { name: "Goals", questions: blank }));
  assert.equal(new Set(h.steps.map((s) => s.id)).size, 1, "one stretch of typing");
  const s = h.step(0);
  assert.equal(s.label, "add evaluator Goals");
  assert.deepEqual(await h.undo(s), { id: s.id, owner: "evaluators", outcome: "applied" });
  assert.deepEqual(await h.listed(), []);
  assert.equal((await h.redo(s)).outcome, "applied");
  assert.deepEqual((await h.listed()).map((e) => e.name), ["Goals"]);
});

test("an edit is a step whose Undo and Redo give back the evaluator exactly; another field is a step of its own", async () => {
  const h = await start({ store: memory([row(A, { questions: [yesno(), pick()] })]) });
  const before = text(h.store.rows.get(A));
  h.actor.send(saved(A, { name: "Goals!", questions: [yesno(), pick()] }));
  h.actor.send(saved(A, { name: "Goals!", questions: [yesno(Q1, "Is it a goal at all?"), pick()] }));
  assert.equal(new Set(h.steps.map((s) => s.id)).size, 2, "the name and the question's text are two stretches");
  const after = text(h.store.rows.get(A));
  const [rename, question] = [h.step(0), h.step(1)];
  assert.equal(rename.label, "edit evaluator Goals!");
  assert.equal((await h.undo(question)).outcome, "applied");
  assert.equal(h.store.rows.get(A).questions[0].text, "Is it a goal?");
  assert.equal((await h.undo(rename)).outcome, "applied");
  assert.deepEqual(text(h.store.rows.get(A)), before, "Undo in a row gives back the evaluator as it was");
  await h.redo(rename);
  await h.redo(question);
  assert.deepEqual(text(h.store.rows.get(A)), after, "and Redo in a row as it became");
});

test("removing a question or an option is a step of its own, which Undo takes back", async () => {
  const h = await start({ store: memory([row(A, { questions: [yesno(), pick()] })]) });
  const all = text(h.store.rows.get(A));
  h.actor.send(saved(A, { questions: [yesno(), { ...pick(), options: [pick().options[1]] }] }));
  h.actor.send(saved(A, { questions: [{ ...pick(), options: [pick().options[1]] }] }));
  const [option, question] = [h.step(0), h.step(1)];
  assert.notEqual(option.id, question.id);
  assert.deepEqual([option.label, question.label], ["remove an option from evaluator Goals", "remove a question from evaluator Goals"]);
  await h.undo(question);
  await h.undo(option);
  assert.deepEqual(text(h.store.rows.get(A)), all);
});

test("a switch, a move and a starter tick are steps, undone and redone exactly, several in a row", async () => {
  const h = await start({ store: memory([row(A, { position: "a" }), row(B, { name: "Other", position: "b" })]) });
  h.actor.send({ type: "evaluator.switched", id: A, on: false });
  h.actor.send({ type: "evaluator.switched", id: A, on: true });
  h.actor.send({ type: "evaluator.switched", id: A, on: false });
  h.actor.send({ type: "evaluator.moved", id: A, after: B, before: null });
  h.actor.send({ type: "starter.ticked", evaluator: A, page: "evaluators", on: true });
  assert.deepEqual(
    h.steps.map((s) => s.label),
    ["switch off evaluator Goals", "switch on evaluator Goals", "switch off evaluator Goals", "move evaluator Goals", "tick evaluator Goals as a starter"],
  );
  for (const n of [4, 3, 2, 1, 0]) assert.equal((await h.undo(h.step(n))).outcome, "applied");
  const r = h.store.rows.get(A);
  assert.deepEqual([r.on, r.position, r.starterFor], [true, "a", []]);
  assert.deepEqual((await h.listed()).map((e) => e.id), [A, B]);
  for (const n of [0, 1, 2, 3, 4]) assert.equal((await h.redo(h.step(n))).outcome, "applied");
  const again = h.store.rows.get(A);
  assert.deepEqual([again.on, again.starterFor], [false, ["evaluators"]]);
  assert.deepEqual((await h.listed()).map((e) => e.id), [B, A]);
});

test("a delete is a step with the notice; Undo brings it back with a restore write naming the tombstone", async () => {
  const api = server([row(A)]);
  const h = await start({ store: memory([row(A)], "u1"), api, userId: "u1" });
  h.actor.send({ type: "evaluator.discarded", id: A });
  const s = h.step(0);
  assert.deepEqual([s.label, s.notice], ["delete evaluator Goals", true]);
  await h.sync();
  assert.deepEqual([api.rows.get(A).deleted, api.rows.get(A).version], [true, 2]);
  assert.equal((await h.undo(s)).outcome, "applied");
  assert.deepEqual((await h.listed()).map((e) => e.name), ["Goals"]);
  await h.sync();
  const restore = api.puts.at(-1);
  assert.deepEqual([restore.restore, restore.baseVersion, Boolean(restore.deleted)], [true, 2, false]);
  assert.deepEqual([api.rows.get(A).deleted, api.rows.get(A).version], [false, 3]);
  assert.equal(h.store.outbox.size, 0);
  assert.equal((await h.redo(s)).outcome, "applied");
  await h.sync();
  assert.equal(api.rows.get(A).deleted, true);
});

test("an Undo while its delete is still on the way keeps the evaluator, and the restore names the new tombstone", async () => {
  const api = server([row(A)]);
  const h = await start({ store: memory([row(A)], "u1"), api, userId: "u1" });
  const put = api.put;
  let release;
  api.put = (r) => new Promise((resolve) => (release = () => resolve(put(r))));
  h.actor.send({ type: "evaluator.discarded", id: A });
  h.clock.increment(SYNC_IDLE_MS);
  await flush();
  await h.undo(h.step(0));
  api.put = put;
  release();
  await flush();
  await h.sync();
  assert.deepEqual([api.rows.get(A).deleted, api.rows.get(A).version], [false, 3]);
  assert.deepEqual((await h.listed()).map((e) => e.id), [A]);
});

test("a step is refused when the evaluator changed since, here or on another device", async () => {
  const api = server([row(A), row(B)]);
  const h = await start({ store: memory([row(A), row(B)], "u1"), api, userId: "u1" });
  h.actor.send(saved(A, { name: "Mine" }));
  h.actor.send({ type: "evaluator.switched", id: A, on: false });
  h.actor.send(saved(A, { name: "Mine", questions: [] }));
  await h.sync();
  assert.deepEqual(await h.undo(h.step(0)), { id: h.step(0).id, owner: "evaluators", outcome: "refused", reason: "changed" }, "a later save wrote it");
  assert.equal((await h.undo(h.step(1))).outcome, "applied", "the switch is its own part, not written since");

  h.actor.send({ type: "evaluator.switched", id: B, on: false });
  await h.sync();
  api.elsewhere(B, { on: true });
  h.actor.send({ type: "_sync", pull: true });
  await flush();
  assert.equal((await h.undo(h.steps.at(-1))).reason, "changed", "another device switched it since");
});

test("leaving a field ends its stretch: typing in it again after coming back is another step", async () => {
  const h = await start({ store: memory([row(A)]) });
  h.actor.send(saved(A, { name: "Goals!" }));
  h.actor.send({ ...saved(A, { name: "Goals!" }), left: true });
  h.actor.send(saved(A, { name: "Goals!!" }));
  h.actor.send({ ...saved(A, { name: "Goals!!!" }), left: true });
  assert.equal(new Set(h.steps.map((s) => s.id)).size, 2);
  assert.equal((await h.undo(h.step(-1))).outcome, "applied");
  assert.equal((await h.listed())[0].name, "Goals!", "one Undo takes back the second visit");
  assert.equal((await h.undo(h.step(0))).outcome, "applied");
  assert.equal((await h.listed())[0].name, "Goals");
});

test("Start over on a try page is one step: Undo brings back what was there and deletes the copies", async () => {
  const store = memory([row(A, { book: JOURNAL, name: "Mine" }), row(B, { book: JOURNAL, name: "Other" })]);
  const h = await start({ store, api: server(), tryPage: "evaluators" });
  h.actor.send({ type: "trial.restarted" });
  await flush();
  assert.deepEqual((await h.listed()).map((e) => e.name), ["Clear goal"]);
  assert.equal(h.steps.length, 1);
  const s = h.step(0);
  assert.equal(s.label, "start over");
  assert.equal(s.notice, true, "it shows the short notice");
  assert.equal((await h.undo(s)).outcome, "applied");
  assert.deepEqual((await h.listed()).map((e) => e.name).sort(), ["Mine", "Other"]);
  assert.equal((await h.redo(s)).outcome, "applied");
  assert.deepEqual((await h.listed()).map((e) => e.name), ["Clear goal"]);
});

test("Your values: its switch and its move are steps; a save or a delete of it records none", async () => {
  const YOURS = "0000000000000000000000YVAS";
  const h = await start();
  h.actor.send({ type: "evaluator.saved", id: YOURS, book: JOURNAL, name: "Mine", questions: [] });
  h.actor.send({ type: "evaluator.discarded", id: YOURS });
  assert.equal(h.steps.length, 0);
  h.actor.send({ type: "evaluator.switched", id: YOURS, on: false });
  assert.equal(h.steps.length, 1);
  assert.equal((await h.undo(h.step(0))).outcome, "applied");
  assert.equal(h.store.rows.get(YOURS).on, true);
});

test("a new evaluator the list places with o or O is one step: one Undo removes it, one Redo brings it back in its place", async () => {
  const h = await start({ store: memory([row(A, { position: "a" }), row(B, { name: "Other", position: "b" })]) });
  const C = "01ARZ3NDEKTSV4RRFFQ69G5EV3";
  h.actor.send(saved(C, { name: "N", questions: [yesno(Q1, "")] }));
  h.actor.send({ type: "evaluator.moved", id: C, after: A, before: B });
  h.actor.send(saved(C, { name: "New", questions: [yesno(Q1, "")] }));
  assert.equal(new Set(h.steps.map((s) => s.id)).size, 1, "add, place and typing on are one step");
  const s = h.step(0);
  assert.equal(s.label, "add evaluator New");
  assert.deepEqual((await h.listed()).map((e) => e.id), [A, C, B]);
  assert.equal((await h.undo(s)).outcome, "applied");
  assert.deepEqual((await h.listed()).map((e) => e.id), [A, B]);
  assert.equal((await h.redo(s)).outcome, "applied");
  assert.deepEqual((await h.listed()).map((e) => [e.id, e.name]), [[A, "Goals"], [C, "New"], [B, "Other"]]);
  h.actor.send({ type: "evaluator.moved", id: C, after: null, before: A });
  assert.equal(new Set(h.steps.map((x) => x.id)).size, 2, "a later move is a step of its own");
});
