import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, EISENHOWER, PROMPT, ANSWERS } from "../machine.js";

// The built-in Answers the prompt evaluator, decided in the actor (3.2): driven with a fake store
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
const prompt = async (actor, payload) => (await list(actor, payload)).find((e) => e.id === PROMPT);

test("Answers the prompt is built in with its fixed ids and wording, after Eisenhower", async () => {
  const { actor, store } = start({
    rows: [{ id: ID, book: JOURNAL, name: "Mine", on: true, questions: [], version: 1 }],
  });
  await flush();
  const all = await list(actor, { book: JOURNAL });
  assert.deepEqual(all.map((e) => e.id), [ID, EISENHOWER, PROMPT]);
  const e = all[2];
  assert.equal(e.name, "Answers the prompt");
  assert.equal(e.on, true);
  assert.deepEqual(
    e.questions.map((q) => [q.id, q.kind, q.text, q.on, "expect" in q]),
    [[ANSWERS, "yesno", "Does the answer respond to what the prompt asks?", true, false]],
  );
  assert.match(e.questions[0].yes, /I don't know/, "an honest short answer counts as an answer");
  assert.ok(e.questions[0].no);
  assert.equal(await prompt(actor, { book: "01ARZ3NDEKTSV4RRFFQ69G5BK1" }), undefined, "not with another book");
  assert.ok(!store.rows.has(PROMPT), "nothing stored until the user changes it");
});

test("Answers the prompt is listed only while flags reports Journal prompts shown (3.1)", async () => {
  for (const [hidden, tryPage] of [[null, null], [["journal-prompts"], null], [[], "evaluators"]]) {
    const { actor } = start({ hidden, tryPage });
    await flush();
    assert.equal(await prompt(actor), undefined, JSON.stringify({ hidden, tryPage }));
  }
  const { actor, changed, deleted } = start({ hidden: ["journal-prompts"] });
  await flush();
  actor.send({ type: "flags.changed", off: [], hidden: [] });
  await flush();
  assert.ok(changed.some((e) => e.id === PROMPT), "announced when shown");
  assert.ok(await prompt(actor));
  actor.send({ type: "flags.changed", off: [], hidden: ["journal-prompts"] });
  await flush();
  assert.deepEqual(deleted, [{ type: "evaluator.deleted", id: PROMPT, book: JOURNAL }], "it leaves the lists");
  assert.equal(await prompt(actor), undefined);
});

test("Answers the prompt can be reworded, but never deleted or made a starter", async () => {
  const { actor, store, steps } = start();
  await flush();
  const was = await prompt(actor);
  actor.send({ type: "evaluator.discarded", id: PROMPT });
  actor.send({ type: "starter.ticked", evaluator: PROMPT, page: "evaluators", on: true });
  await flush();
  assert.equal(steps.length, 0, "a delete and a tick are ignored");
  const questions = was.questions.map((q) => ({ ...q, text: "Is this on topic?" }));
  actor.send({ type: "evaluator.saved", id: PROMPT, book: JOURNAL, name: was.name, description: was.description, questions, left: true });
  await flush();
  assert.equal((await prompt(actor)).questions[0].text, "Is this on topic?");
  assert.deepEqual(store.rows.get(PROMPT)?.questions.map((q) => q.id), [ANSWERS], "stored as an ordinary row, whole");
  actor.send({ type: "step.undone", id: steps[0].id, owner: "evaluators", payload: steps[0].undo });
  await flush();
  assert.deepEqual((await prompt(actor)).questions, was.questions, "Undo brings back the built-in wording");
});
