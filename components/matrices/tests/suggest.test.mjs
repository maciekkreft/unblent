import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

// How matrices suggests a place for a task the user has not placed: it asks the built-in
// Eisenhower evaluator's two questions through a faked `llm: decide`, found by their fixed
// ids, and writes the place without making a step.

const DAY = "2026-10-14";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5CP1";
const T1 = "01ARZ3NDEKTSV4RRFFQ69G5TA1";
const T2 = "01ARZ3NDEKTSV4RRFFQ69G5TA2";
const EISENHOWER = "0000000000000000000000EMTX";
const URGENT = "0000000000000000000000RGNT";
const IMPORTANT = "0000000000000000000000MPRT";
const JOURNAL = "00000000000000000000000JRN";

const task = (over = {}) => ({ id: T1, text: "Call the bank", place: null, done: false, ...over });

const evaluator = (questions = {}) => ({
  id: EISENHOWER,
  book: JOURNAL,
  name: "Eisenhower",
  on: true,
  version: 1,
  pending: false,
  removing: false,
  questions: [
    { id: URGENT, kind: "yesno", text: "Is this task urgent?", yes: "A deadline soon.", no: "", ...questions.urgent },
    { id: IMPORTANT, kind: "yesno", text: "Is this task important?", ...questions.important },
  ],
});

const changedSchema = new Validator(JSON.parse(readFileSync(new URL("../events/matrix.changed.json", import.meta.url))), "2020-12");
const decideSchema = new Validator(JSON.parse(readFileSync(new URL("../../llm/queries/decide.json", import.meta.url))).payload, "2020-12");

const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    all: () => Promise.resolve([...rows.values()]),
    put: (r) => (rows.set(r.id, structuredClone(r)), Promise.resolve()),
    outboxAll: () => Promise.resolve([]),
    outboxPut: () => Promise.resolve(),
    outboxDelete: () => Promise.resolve(),
    metaGet: () => Promise.resolve(undefined),
    metaPut: () => Promise.resolve(),
  };
}

// `answer(payload)` stands in for llm: decide: by default urgent at 0.9 and important at 0.1.
async function start({ store = fakeStore(), listed = evaluator(), answer, today = DAY } = {}) {
  const asked = [];
  const decide = answer ?? (() => ({ answers: [{ id: URGENT, p: 0.9 }, { id: IMPORTANT, p: 0.1 }], inputTokens: 10, ms: 5 }));
  const ask = async (target, name, payload) => {
    if (target === "session") return { userId: null };
    if (target === "journal") return { today };
    if (target === "evaluators") return { evaluators: listed ? [listed] : [] };
    if (target === "llm" && name === "decide") {
      assert.ok(decideSchema.validate(payload).valid, JSON.stringify(payload));
      asked.push(payload);
      return decide(payload);
    }
    return { error: "no-answerer" };
  };
  let minted = 0;
  const actor = createActor(machine, { input: { store, ask, mint: () => `01ARZ3NDEKTSV4RRFFQ69G${String(++minted).padStart(4, "0")}` } });
  const steps = [];
  const settled = [];
  actor.on("step.recorded", (e) => steps.push(e));
  actor.on("step.settled", (e) => settled.push(e));
  actor.on("matrix.changed", (e) => assert.ok(changedSchema.validate({ matrix: e.matrix }).valid, JSON.stringify(e)));
  actor.start();
  await flush();
  const save = (over = {}) => actor.send({ type: "matrix.saved", id: ID, day: DAY, tasks: [task()], ...over });
  const held = async (day = DAY) =>
    (await new Promise((reply) => actor.send({ type: "list?", cid: "c", payload: { day }, reply }))).matrices[0];
  return { actor, asked, steps, settled, save, held, store };
}

const answered = (urgent, important) => () => ({
  answers: [{ id: URGENT, p: urgent }, { id: IMPORTANT, p: important }],
  inputTokens: 10,
  ms: 5,
});

test("a task without a place is asked about once, both questions in one request, its words as the state", async () => {
  const s = await start();
  s.save();
  await flush();
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.asked[0], {
    state: { task: "Call the bank" },
    questions: [
      { id: URGENT, instructions: "Is this task urgent?", yes: "A deadline soon." },
      { id: IMPORTANT, instructions: "Is this task important?" },
    ],
  });
  assert.deepEqual((await s.held()).tasks[0].suggested, { place: "delegate", sure: true });
  s.save({ tasks: [task({ done: true })], finished: true });
  await flush();
  assert.equal(s.asked.length, 1, "a task with a suggestion is not asked again");
  assert.deepEqual((await s.held()).tasks[0].suggested, { place: "delegate", sure: true }, "a save keeps it while the words stay");
});

test("two yes is Do, important only Schedule, urgent only Delegate, two no Drop; close answers are not sure", async () => {
  const cases = [
    [0.9, 0.8, { place: "do", sure: true }],
    [0.2, 0.5, { place: "schedule", sure: false }],
    [0.6, 0.1, { place: "delegate", sure: false }],
    [0.1, 0.25, { place: "drop", sure: true }],
  ];
  for (const [urgent, important, suggested] of cases) {
    const s = await start({ answer: answered(urgent, important) });
    s.save();
    await flush();
    assert.deepEqual((await s.held()).tasks[0].suggested, suggested, `${urgent} ${important}`);
    s.actor.stop();
  }
});

test("writing a suggestion is not a step, Undo still applies after it, and never removes it", async () => {
  const s = await start();
  s.save({ tasks: [task(), task({ id: T2, text: "Tidy the desk", place: "drop" })], finished: true });
  await flush();
  assert.equal(s.steps.length, 1, "only the user's save is a step");
  s.save({ tasks: [task({ done: true }), task({ id: T2, text: "Tidy the desk", place: "drop" })], finished: true });
  await flush();
  assert.equal(s.steps.length, 2);
  s.actor.send({ type: "step.undone", id: s.steps[1].id, owner: "matrices", payload: s.steps[1].undo });
  assert.equal(s.settled.at(-1).outcome, "applied");
  const matrix = await s.held();
  assert.deepEqual(matrix.tasks[0], task({ suggested: { place: "delegate", sure: true } }));
  assert.equal(s.asked.length, 1, "the placed task was never asked about");
});

test("new words before the task is placed drop its suggestion, and it is asked again", async () => {
  const s = await start();
  s.save();
  await flush();
  s.save({ tasks: [task({ text: "Call the bank today" })] });
  assert.equal((await s.held()).tasks[0].suggested, undefined);
  await flush();
  assert.deepEqual(s.asked.map((p) => p.state.task), ["Call the bank", "Call the bank today"]);
});

test("a task still being asked about is not asked again, and an answer for words since changed is dropped", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const s = await start({ answer: () => gate.then(answered(0.9, 0.9)) });
  s.save();
  s.save({ tasks: [task({ done: true })] });
  await flush();
  assert.equal(s.asked.length, 1);
  s.save({ tasks: [task({ text: "Other words" })] });
  await flush();
  release();
  await flush();
  const matrix = await s.held();
  assert.deepEqual(matrix.tasks[0].text, "Other words");
  assert.deepEqual(matrix.tasks[0].suggested, { place: "do", sure: true }, "the second ask, for these words");
  assert.equal(s.asked.length, 2);
});

test("an error leaves the task without a suggestion, asked again only at the next load", async () => {
  const store = fakeStore();
  const s = await start({ store, answer: () => ({ error: "no-key" }) });
  s.save();
  await flush();
  s.save({ tasks: [task({ done: true })] });
  await flush();
  assert.equal(s.asked.length, 1);
  assert.equal((await s.held()).tasks[0].suggested, undefined);
  s.actor.stop();
  const again = await start({ store });
  await flush();
  assert.equal(again.asked.length, 1, "the next load asks again");
  assert.deepEqual((await again.held()).tasks[0].suggested, { place: "delegate", sure: true });
});

test("a question switched off, emptied or no longer yes / no counts as a sure No and is not asked", async () => {
  const off = await start({ listed: evaluator({ urgent: { on: false } }), answer: answered(0.9, 0.6) });
  off.save();
  await flush();
  assert.deepEqual(off.asked[0].questions.map((q) => q.id), [IMPORTANT]);
  assert.deepEqual((await off.held()).tasks[0].suggested, { place: "schedule", sure: false });
  const pick = await start({ listed: evaluator({ important: { kind: "pick" }, urgent: { text: " " } }) });
  pick.save();
  await flush();
  assert.deepEqual(pick.asked, [], "neither can be asked, so nothing is");
  assert.equal((await pick.held()).tasks[0].suggested, undefined);
});

test("nothing is asked while the evaluator is not listed; it is once it is announced, and not after it goes", async () => {
  const s = await start({ listed: null });
  s.save();
  await flush();
  assert.deepEqual(s.asked, []);
  s.actor.send({ type: "evaluator.changed", evaluator: evaluator() });
  await flush();
  assert.equal(s.asked.length, 1);
  s.actor.send({ type: "evaluator.deleted", id: EISENHOWER, book: JOURNAL });
  s.save({ tasks: [task(), task({ id: T2, text: "Tidy the desk" })] });
  await flush();
  assert.equal(s.asked.length, 1);
  s.actor.send({ type: "evaluator.changed", evaluator: { ...evaluator(), on: false } });
  await flush();
  assert.equal(s.asked.length, 1, "nor while it is switched off");
});

test("a task copied with its suggestion is not asked again; a placed one never is, nor an earlier day's", async () => {
  const s = await start({ today: "2026-10-15" });
  s.save({ day: "2026-10-15", tasks: [task(), task({ id: T2, text: "Plan the trip", place: "schedule" })] });
  await flush();
  assert.equal(s.asked.length, 1);
  s.save({ id: "01ARZ3NDEKTSV4RRFFQ69G5CP9", day: "2026-10-13", tasks: [task({ text: "Old task" })] });
  await flush();
  assert.equal(s.asked.length, 1, "an earlier day is read only and not asked about");
  s.actor.send({ type: "journal.changed", today: "2026-10-16" });
  s.actor.send({
    type: "matrix.saved",
    id: "01ARZ3NDEKTSV4RRFFQ69G5CP8",
    day: "2026-10-16",
    from: "2026-10-15",
    tasks: [task({ id: "01ARZ3NDEKTSV4RRFFQ69G5TA9" })],
  });
  await flush();
  assert.equal(s.asked.length, 1);
  assert.deepEqual((await s.held("2026-10-16")).tasks[0].suggested, { place: "delegate", sure: true });
});
