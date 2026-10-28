import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, YOURS, CHECK_PAUSE_MS, BUSY_TRIES } from "../machine.js";

// The chat's two tools (7.7), active and evaluate, and the description they read, decided
// in the actor: driven with a fake store and a fake ask that answers session, values and
// llm: decide the way those facts would, and a wait the test lets pass at once.
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5BK1";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5EV1";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5EV2";
const ID3 = "01ARZ3NDEKTSV4RRFFQ69G5EV3";
const Q1 = "01ARZ3NDEKTSV4RRFFQ69G5QQ1";
const Q2 = "01ARZ3NDEKTSV4RRFFQ69G5QQ2";
const Q3 = "01ARZ3NDEKTSV4RRFFQ69G5QQ3";
const O1 = "01ARZ3NDEKTSV4RRFFQ69G50P1";
const O2 = "01ARZ3NDEKTSV4RRFFQ69G50P2";
const V1 = "01ARZ3NDEKTSV4RRFFQ69G5VA1";
const V2 = "01ARZ3NDEKTSV4RRFFQ69G5VA2";

const schema = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const v = (s) => new Validator(s, "2020-12");
const changedSchema = v(schema("../events/evaluator.changed.json"));
const listReply = v(schema("../queries/list.json").reply);
const activeReply = v(schema("../queries/active.json").reply);
const evaluateSchema = schema("../queries/evaluate.json");
const evaluatePayload = v(evaluateSchema.payload);
const evaluateReply = v(evaluateSchema.reply);
const decideSchema = schema("../../llm/queries/decide.json");
const decidePayload = v(decideSchema.payload);
const decideReply = v(decideSchema.reply);

const yesno = { id: Q1, kind: "yesno", text: "Is this a goal?", yes: "it can be finished", no: "", options: [], expect: "yes" };
const pick = {
  id: Q2,
  kind: "pick",
  text: "How long is it?",
  yes: "",
  no: "",
  options: [
    { id: O1, name: "Short", description: "under three words" },
    { id: O2, name: "Long", description: "" },
  ],
  expect: O1,
};
const off = { id: Q3, on: false, kind: "yesno", text: "Switched off", yes: "", no: "", options: [] };

const row = (over) => ({ id: ID, book: BOOK, name: "Goals", description: "Checks goals", on: true, questions: [yesno, pick, off], version: 1, ...over });

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

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 12) => {
  for (let i = 0; i < n; i += 1) await tick();
};

// decide answers in turn from `answers`, a function of the payload or a list of replies.
function start(rows, { values = null, decide = () => ({ error: "no-key" }) } = {}) {
  const asked = [];
  const waits = [];
  const ask = async (target, name, payload) => {
    if (target === "session") return { userId: null, registrationOpen: false };
    if (target === "values" && values) return { day: "2026-10-28", values, version: 1 };
    if (target === "llm" && name === "decide") {
      assert.ok(decidePayload.validate(payload).valid, JSON.stringify(payload));
      asked.push(payload);
      const reply = await decide(payload, asked.length);
      assert.ok(decideReply.validate(reply).valid, JSON.stringify(reply));
      return reply;
    }
    return { error: "no-answerer" };
  };
  const wait = (ms) => (waits.push(ms), Promise.resolve());
  const actor = createActor(machine, { input: { store: fakeStore(rows), ask, wait } });
  const changed = [];
  actor.on("evaluator.changed", (e) => {
    assert.ok(changedSchema.validate({ evaluator: e.evaluator }).valid, JSON.stringify(e));
    changed.push(e.evaluator);
  });
  actor.start();
  return { actor, asked, waits, changed };
}

const query = (actor, type, payload, validator) =>
  new Promise((reply) => actor.send({ type, cid: "c", payload, reply })).then((r) => {
    assert.ok(validator.validate(r).valid, JSON.stringify(r));
    return r;
  });
const active = (actor) => query(actor, "active?", {}, activeReply);
const evaluate = (actor, evaluator, texts) => {
  assert.ok(evaluatePayload.validate({ evaluator, texts }).valid);
  return query(actor, "evaluate?", { evaluator, texts }, evaluateReply);
};
const list = (actor) => query(actor, "list?", {}, listReply).then((r) => r.evaluators);

const yes = (p) => ({ id: Q1, p });
const picked = (choice, p = 0.8) => ({ id: Q2, p, choice });
const answers = (...a) => ({ answers: a, inputTokens: 1, ms: 1 });

test("a description is saved, announced and listed; a save without one keeps it", async () => {
  const { actor, changed } = start([]);
  actor.send({ type: "evaluator.saved", id: ID, book: BOOK, name: "Goals", description: "Checks goals", questions: [yesno] });
  await flush();
  assert.equal(changed.at(-1).description, "Checks goals");
  actor.send({ type: "evaluator.saved", id: ID, book: BOOK, name: "Goals 2", questions: [yesno] });
  actor.send({ type: "evaluator.saved", id: ID2, book: BOOK, name: "None", questions: [] });
  await flush();
  assert.deepEqual(
    (await list(actor)).map((e) => [e.name, e.description]),
    [["None", ""], ["Goals 2", "Checks goals"]],
  );
  actor.send({ type: "evaluator.saved", id: ID, book: BOOK, name: "Goals 2", description: "", questions: [yesno] });
  await flush();
  assert.equal(changed.at(-1).description, "", "emptied on purpose");
});

test("active lists the switched-on evaluators with something to ask, Your values among them", async () => {
  const rows = [
    row(),
    row({ id: ID2, name: "Off", on: false }),
    row({ id: ID3, name: "Nothing to ask", questions: [off] }),
  ];
  const { actor } = start(rows, { values: [{ id: V1, name: "Honesty", meaning: "" }] });
  const { evaluators } = await active(actor);
  assert.deepEqual(evaluators[0], {
    id: ID,
    name: "Goals",
    description: "Checks goals",
    book: BOOK,
    questions: [
      { text: "Is this a goal?", kind: "yesno", yes: "it can be finished", no: "", expected: "Yes" },
      {
        text: "How long is it?",
        kind: "pick",
        options: [
          { name: "Short", description: "under three words" },
          { name: "Long", description: "" },
        ],
        expected: "Short",
      },
    ],
  });
  assert.equal(evaluators.length, 2);
  const yours = evaluators[1];
  assert.deepEqual([yours.id, yours.name, yours.combined], [YOURS, "Your values", true]);
  assert.match(yours.description, /each of your values/);
  assert.deepEqual(yours.questions.map((q) => q.expected), ["Serves"]);
});

test("active without values leaves Your values out; switched off, it is left out too", async () => {
  const { actor } = start([row()]);
  assert.deepEqual((await active(actor)).evaluators.map((e) => e.id), [ID]);
  const two = start([row(), { id: YOURS, book: "00000000000000000000000JRN", name: "Your values", on: false, questions: [], version: 1 }], {
    values: [{ id: V1, name: "Honesty", meaning: "" }],
  });
  assert.deepEqual((await active(two.actor)).evaluators.map((e) => e.id), [ID]);
});

test("evaluate refuses an unknown evaluator, one switched off, and one with nothing to ask", async () => {
  const { actor, asked } = start([row({ id: ID2, on: false }), row({ id: ID3, questions: [off] })]);
  assert.deepEqual(await evaluate(actor, ID, ["x"]), { error: "not-found" });
  assert.deepEqual(await evaluate(actor, "nonsense", ["x"]), { error: "not-found" });
  assert.deepEqual(await evaluate(actor, YOURS, ["x"]), { error: "not-found" }, "no values fact");
  assert.deepEqual(await evaluate(actor, ID2, ["x"]), { error: "off" });
  assert.deepEqual(await evaluate(actor, ID3, ["x"]), { error: "no-questions" });
  assert.equal(asked.length, 0);
});

test("evaluate asks Jev one text at a time and says which pass", async () => {
  const decide = ({ state }) => (state.text === "Run" ? answers(yes(0.9), picked(O1)) : answers(yes(0.2), picked(O2, 0.7)));
  const { actor, asked } = start([row()], { decide });
  const reply = await evaluate(actor, ID, ["Run", "Run a marathon in under three hours"]);
  assert.deepEqual(
    asked.map((p) => p.state),
    [{ text: "Run" }, { text: "Run a marathon in under three hours" }],
  );
  assert.deepEqual(
    asked[0].questions.map((q) => q.id),
    [Q1, Q2],
    "the switched-off question is not asked",
  );
  assert.deepEqual(reply.results[0], {
    text: "Run",
    passed: true,
    answers: [
      { question: "Is this a goal?", answer: "Yes", p: 0.9, expected: "Yes", matches: true },
      { question: "How long is it?", answer: "Short", p: 0.8, expected: "Short", matches: true },
    ],
  });
  assert.equal(reply.results[1].passed, false);
  assert.deepEqual(
    reply.results[1].answers.map((a) => [a.answer, a.matches]),
    [
      ["No", false],
      ["Long", false],
    ],
  );
  assert.ok(Math.abs(reply.results[1].answers[0].p - 0.8) < 1e-9);
});

test("Your values passes a text that serves any one value", async () => {
  const values = [
    { id: V1, name: "Honesty", meaning: "" },
    { id: V2, name: "Health", meaning: "" },
  ];
  const decide = ({ questions }) => answers(...questions.map((q) => ({ id: q.id, p: 0.9, choice: q.id === V1 ? "0000000000000000000000SRVS" : "0000000000000000000000NRTD" })));
  const { actor } = start([], { values, decide });
  const reply = await evaluate(actor, YOURS, ["Tell the truth"]);
  assert.equal(reply.results[0].passed, true);
  assert.deepEqual(
    reply.results[0].answers.map((a) => [a.answer, a.matches]),
    [
      ["Serves", true],
      ["Unrelated", false],
    ],
  );
});

test("a busy Jev is waited out and asked again; still busy after every try, busy is the reply", async () => {
  const once = start([row()], { decide: (_, n) => (n === 1 ? { error: "busy" } : answers(yes(0.9), picked(O1))) });
  const reply = await evaluate(once.actor, ID, ["Run"]);
  assert.equal(reply.results[0].passed, true);
  assert.deepEqual(once.waits, [CHECK_PAUSE_MS]);
  assert.equal(once.asked.length, 2);

  const always = start([row()], { decide: () => ({ error: "busy" }) });
  assert.deepEqual(await evaluate(always.actor, ID, ["Run"]), { error: "busy" });
  assert.equal(always.asked.length, BUSY_TRIES);
  assert.equal(always.waits.length, BUSY_TRIES - 1);
});

test("any other error from Jev is the reply, and nothing more is asked", async () => {
  const { actor, asked } = start([row()], { decide: () => ({ error: "no-key" }) });
  assert.deepEqual(await evaluate(actor, ID, ["Run", "Walk"]), { error: "no-key" });
  assert.equal(asked.length, 1);
});

test("the tools asked while the store loads are answered once it has", async () => {
  const { actor } = start([row()], { decide: () => answers(yes(0.9), picked(O1)) });
  assert.ok(actor.getSnapshot().matches("loading"));
  const [a, e] = await Promise.all([active(actor), evaluate(actor, ID, ["Run"])]);
  assert.deepEqual(a.evaluators.map((x) => x.id), [ID]);
  assert.equal(e.results[0].passed, true);
});
