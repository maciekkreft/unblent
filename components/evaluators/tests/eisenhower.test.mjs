import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, EISENHOWER, URGENT, IMPORTANT, PROMPT } from "../machine.js";

// The built-in Eisenhower evaluator, decided in the actor (3.2): driven with a fake store
// and a fake ask for session and flags.
const JOURNAL = "00000000000000000000000JRN";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const changedSchema = new Validator(schema("../events/evaluator.changed.json"), "2020-12");
const listReply = new Validator(schema("../queries/list.json").reply, "2020-12");

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await tick();
};

function fakeStore(initial = []) {
  const rows = new Map(initial.map((r) => [r.id, r]));
  return {
    rows,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, r), Promise.resolve()),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: () => Promise.resolve(undefined),
    metaPut: () => Promise.resolve(),
  };
}

// `flags` answers with the hidden features given, or, with null, is not on the page.
const askWith = (hidden) => (target) => {
  if (target === "flags") return Promise.resolve(hidden ? { off: [], hidden } : { error: "no-answerer" });
  if (target === "values") return Promise.resolve({ error: "no-answerer" });
  return Promise.resolve({ userId: null, registrationOpen: false });
};

function start({ hidden = [], rows = [], tryPage = null } = {}) {
  const store = fakeStore(rows);
  const actor = createActor(machine, { input: { store, ask: askWith(hidden), tryPage, now: () => "2026-11-12T10:00:00.000Z" } });
  const changed = [];
  const deleted = [];
  const steps = [];
  actor.on("evaluator.changed", (e) => {
    assert.ok(changedSchema.validate({ evaluator: e.evaluator }).valid, JSON.stringify(e));
    changed.push(e.evaluator);
  });
  actor.on("evaluator.deleted", (e) => deleted.push(e));
  actor.on("step.recorded", (e) => steps.push(e));
  actor.start();
  return { actor, store, changed, deleted, steps };
}

const list = (actor, payload = {}) =>
  new Promise((reply) => actor.send({ type: "list?", cid: "c", payload, reply })).then((r) => {
    assert.ok(listReply.validate(r).valid, JSON.stringify(r));
    return r.evaluators;
  });
const eisenhower = async (actor, payload) => (await list(actor, payload)).find((e) => e.id === EISENHOWER);

test("Eisenhower is built in with its fixed ids and wording, at the end of the Journal's list", async () => {
  const { actor, store } = start({
    rows: [{ id: ID, book: JOURNAL, name: "Mine", on: true, questions: [], version: 1 }],
  });
  await flush();
  const all = await list(actor, { book: JOURNAL });
  assert.deepEqual(all.map((e) => e.id), [ID, EISENHOWER, PROMPT]);
  const e = all[1];
  assert.equal(e.name, "Eisenhower");
  assert.equal(e.description, "Decides where a task goes in the Eisenhower Matrix.");
  assert.equal(e.on, true);
  assert.deepEqual(
    e.questions.map((q) => [q.id, q.kind, q.text, q.on, "expect" in q]),
    [
      [URGENT, "yesno", "Is this task urgent?", true, false],
      [IMPORTANT, "yesno", "Is this task important?", true, false],
    ],
  );
  assert.ok(e.questions.every((q) => q.yes && q.no), "yes and no say what they mean");
  assert.ok(await eisenhower(actor), "every book's list holds it");
  assert.equal(await eisenhower(actor, { book: "01ARZ3NDEKTSV4RRFFQ69G5BK1" }), undefined, "not with another book");
  assert.ok(!store.rows.has(EISENHOWER), "nothing stored until the user changes it");
});

test("Eisenhower is listed only while flags reports the Eisenhower Matrix shown (3.1)", async () => {
  for (const [hidden, tryPage] of [[null, null], [["eisenhower-matrix"], null], [[], "evaluators"]]) {
    const { actor } = start({ hidden, tryPage });
    await flush();
    assert.equal(await eisenhower(actor), undefined, JSON.stringify({ hidden, tryPage }));
  }
  const { actor, changed, deleted } = start({ hidden: ["eisenhower-matrix"] });
  await flush();
  actor.send({ type: "flags.changed", off: [], hidden: [] });
  await flush();
  assert.ok(changed.some((e) => e.id === EISENHOWER), "announced when shown");
  assert.ok(await eisenhower(actor));
  actor.send({ type: "flags.changed", off: [], hidden: ["eisenhower-matrix"] });
  await flush();
  assert.deepEqual(deleted, [{ type: "evaluator.deleted", id: EISENHOWER, book: JOURNAL }], "it leaves the lists");
  assert.equal(await eisenhower(actor), undefined);
});

test("Eisenhower can be reworded and a question switched off, but never deleted or made a starter", async () => {
  const { actor, store, steps } = start();
  await flush();
  const was = await eisenhower(actor);
  actor.send({ type: "evaluator.discarded", id: EISENHOWER });
  actor.send({ type: "starter.ticked", evaluator: EISENHOWER, page: "evaluators", on: true });
  await flush();
  assert.equal(steps.length, 0, "a delete and a tick are ignored");
  assert.ok(await eisenhower(actor), "still listed");
  const questions = was.questions.map((q) => (q.id === URGENT ? { ...q, on: false } : { ...q, text: "Does this matter?" }));
  actor.send({ type: "evaluator.saved", id: EISENHOWER, book: JOURNAL, name: "Eisenhower", description: was.description, questions, left: true });
  await flush();
  const now = await eisenhower(actor);
  assert.deepEqual(now.questions.map((q) => [q.id, q.on, q.text]), [
    [URGENT, false, "Is this task urgent?"],
    [IMPORTANT, true, "Does this matter?"],
  ]);
  assert.deepEqual(store.rows.get(EISENHOWER)?.questions.map((q) => q.id), [URGENT, IMPORTANT], "stored as an ordinary row, whole");
  assert.equal(steps.length, 1, "the save is a step");
  actor.send({ type: "step.undone", id: steps[0].id, owner: "evaluators", payload: steps[0].undo });
  await flush();
  assert.deepEqual((await eisenhower(actor)).questions, was.questions, "Undo brings back the built-in wording");
});
