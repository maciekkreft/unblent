import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, parse, payload, decisionsOf, fresh, VERSION } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Schemas are read, never imported (11.2); the gestures' schemas live with their emitters.
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "decision.changed.json");
const READ = json("queries", "read.json").reply;
const REQUESTED = json("..", "case-list", "events", "judging.requested.json");
const PIECES = json("..", "case-journal", "events", "passages.requested.json");
const CASES = json("..", "cases", "events", "case.changed.json");
const RUBRICS = json("..", "rubrics", "events", "rubric.changed.json");
const DECIDE = json("..", "llm", "queries", "decide.json");
const recorded = [];

const P = "01K6TEST00000000000000PJ01";
const C1 = "01K6TEST00000000000000CS01";
const C2 = "01K6TEST00000000000000CS02";
const C3 = "01K6TEST00000000000000CS03";
const R1 = "01K6TEST00000000000000RB01";
const R2 = "01K6TEST00000000000000RB02";
const PICK = "01K6TEST00000000000000RQ01";
const YN = "01K6TEST00000000000000RQ02";
const YN2 = "01K6TEST00000000000000RQ03";
const GOAL = "01K6TEST00000000000000RC01";
const VALUE = "01K6TEST00000000000000RC02";
const OTHER = "01K6TEST00000000000000RC03";
const tick = () => new Promise((r) => setTimeout(r));

const opt = (id, name, removing = false) => ({ id, name, description: `${name} means`, removing });
const pick = (over = {}) => ({
  id: PICK, kind: "pick", text: "Goal, value or other?", yes: "", no: "",
  options: [opt(GOAL, "Goal"), opt(VALUE, "Value"), opt(OTHER, "Other")], removing: false, ...over,
});
const yn = (id, over = {}) => ({ id, kind: "yesno", text: "Is it a goal?", yes: "It ends", no: "It goes on", options: [], removing: false, ...over });
const rubric = (id, questions, over = {}) => ({ id, project: P, name: id.slice(-4), on: true, questions, removing: false, ...over });
// The snapshot judging.requested carries: the contract shape without removing flags.
const snap = (r) => ({
  id: r.id,
  name: r.name,
  questions: r.questions.filter((q) => !q.removing).map(({ removing, options, ...q }) => ({
    ...q,
    options: options.filter((o) => !o.removing).map(({ removing: _, ...o }) => o),
  })),
});
const theCase = (id, text, over = {}) => ({ id, project: P, text, answers: {}, removing: false, ...over });

const BASE_RUBRICS = [rubric(R1, [pick()]), rubric(R2, [yn(YN), yn(YN2, { text: "Is it a value?" })])];
const BASE_CASES = [theCase(C1, "To win the race."), theCase(C2, "Playing fairly."), theCase(C3, "It rained.")];

// A fake llm: decide that answers every question, the pick with its first option, and
// holds each reply until the test releases it, so order and one-at-a-time are visible.
const fakeLlm = () => {
  const asked = [];
  const ask = (target, name, p) => {
    const call = { target, name, payload: p };
    call.done = new Promise((res) => (call.release = (reply) => res(reply ?? answer(p))));
    asked.push(call);
    return call.done;
  };
  return { asked, ask };
};
const answer = (p) => ({
  answers: p.questions.map((q) =>
    q.kind === "pick"
      ? { id: q.id, p: 0.8, choice: q.options[0].id, probabilities: q.options.map((o, i) => ({ id: o.id, p: i ? 0.1 : 0.8 })), confidence: 0.7 }
      : { id: q.id, p: 0.25 },
  ),
  inputTokens: 100,
  ms: 20,
});

const start = (stored = null) => {
  const saved = [];
  const clock = new SimulatedClock();
  const llm = fakeLlm();
  const actor = createActor(machine, {
    clock,
    input: { stored, save: (v) => saved.push(v), ask: llm.ask, now: () => clock.now() },
  });
  const emitted = [];
  actor.on("decision.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.start();
  const send = (event, schema) => {
    recorded.push({ value: event, schema });
    actor.send(event);
  };
  const read = () => {
    let reply;
    actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
    recorded.push({ value: reply, schema: READ });
    return reply;
  };
  return { actor, clock, saved, emitted, llm, send, read };
};
const judge = (s, cases = BASE_CASES, rubrics = BASE_RUBRICS) =>
  s.send({ type: "judging.requested", project: P, cases: cases.map(({ id, text }) => ({ id, text })), rubrics: rubrics.map(snap) }, REQUESTED);
const casesNow = (s, cases) => s.send({ type: "case.changed", cases, open: {} }, CASES);
const rubricsNow = (s, rubrics) => s.send({ type: "rubric.changed", rubrics }, RUBRICS);
const releaseAll = async (s) => {
  for (let i = 0; i < 10; i++) {
    const open = s.llm.asked.find((c) => !c.released);
    if (!open) return;
    open.released = true;
    s.clock.increment(1000);
    open.release();
    await tick();
  }
};
const judged = async (s, ...args) => {
  judge(s, ...args);
  await releaseAll(s);
};
const keys = (s) => s.read().decisions.map((d) => `${d.case.slice(-4)}/${d.rubric.slice(-4)}`).sort();

test("it starts empty and answers read with the same body it announces", () => {
  for (const stored of [null, "", "not json", '{"version":1}']) {
    const s = start(stored);
    assert.deepEqual(s.read(), { decisions: [], run: null, passages: { answers: [], waiting: [], error: null } });
    assert.equal(s.saved.length, 0);
  }
});

test("each case is asked on its own, in order, one at a time, with progress after each", async () => {
  const s = start();
  judge(s);
  assert.deepEqual(s.emitted.at(-1).run, { project: P, cases: [C1, C2, C3], done: 0, running: true, error: null });
  for (let i = 0; i < 3; i++) {
    await tick();
    assert.equal(s.llm.asked.length, i + 1, "the next case waits for the reply before it");
    const call = s.llm.asked[i];
    assert.equal(call.target, "llm");
    assert.equal(call.name, "decide");
    assert.deepEqual(call.payload.state, { text: BASE_CASES[i].text });
    s.clock.increment(1000);
    call.release();
    await tick();
    assert.deepEqual(s.emitted.at(-1).run, { project: P, cases: [C1, C2, C3], done: i + 1, running: i < 2, error: null });
  }
  await tick();
  assert.equal(s.llm.asked.length, 3);
  assert.equal(s.emitted.length, 4, "one announcement to start and one per case");
  assert.deepEqual(keys(s), ["CS01/RB01", "CS01/RB02", "CS02/RB01", "CS02/RB02", "CS03/RB01", "CS03/RB02"]);
  assert.deepEqual(s.emitted.at(-1), { type: "decision.changed", ...s.read() });
  assert.deepEqual(parse(s.saved.at(-1)).decisions.length, 6, "a reload reads back what was written");
  assert.equal(JSON.parse(s.saved.at(-1)).version, VERSION);
});

test("every question of every tool goes in one payload that matches decide's schema", () => {
  const p = payload("To win the race.", BASE_RUBRICS.map(snap));
  assert.deepEqual(p, {
    state: { text: "To win the race." },
    questions: [
      {
        id: `${R1}/${PICK}`,
        kind: "pick",
        instructions: "Goal, value or other?",
        options: [
          { id: GOAL, name: "Goal", description: "Goal means" },
          { id: VALUE, name: "Value", description: "Value means" },
          { id: OTHER, name: "Other", description: "Other means" },
        ],
      },
      { id: `${R2}/${YN}`, kind: "yesno", instructions: "Is it a goal?", yes: "It ends", no: "It goes on" },
      { id: `${R2}/${YN2}`, kind: "yesno", instructions: "Is it a value?", yes: "It ends", no: "It goes on" },
    ],
  });
  const result = new Validator(DECIDE.payload, "2020-12").validate(p);
  assert.ok(result.valid, JSON.stringify(result.errors?.[0]));
});

test("a blank question and a pick question short of two options are left out", () => {
  const r = rubric(R1, [yn(YN, { text: "  " }), pick({ options: [opt(GOAL, "Goal")] }), yn(YN2)]);
  assert.deepEqual(payload("x", [snap(r)]).questions.map((q) => q.id), [`${R1}/${YN2}`]);
});

test("a run with nothing to ask stops at once as invalid, asking nothing", async () => {
  const s = start();
  judge(s, BASE_CASES, [rubric(R1, [yn(YN, { text: "" })])]);
  await tick();
  assert.equal(s.llm.asked.length, 0);
  assert.deepEqual(s.read().run, { project: P, cases: [C1, C2, C3], done: 0, running: false, error: "invalid" });
});

test("the reply is split back per tool, with p, and choice, probabilities and confidence for a pick", async () => {
  const s = start();
  s.clock.set(5000);
  judge(s, [BASE_CASES[0]]);
  await tick();
  s.llm.asked[0].release();
  await tick();
  const { decisions } = s.read();
  assert.deepEqual(decisions, [
    {
      case: C1, rubric: R1, at: 5000,
      answers: [{ id: PICK, p: 0.8, choice: GOAL, probabilities: [{ id: GOAL, p: 0.8 }, { id: VALUE, p: 0.1 }, { id: OTHER, p: 0.1 }], confidence: 0.7 }],
    },
    { case: C1, rubric: R2, at: 5000, answers: [{ id: YN, p: 0.25 }, { id: YN2, p: 0.25 }] },
  ]);
  const stored = JSON.parse(s.saved.at(-1)).decisions;
  assert.equal(stored[0].text, "To win the race.", "the store keeps the text that was judged");
  assert.ok(stored[0].asked[PICK], "and what each question was asked as");
});

test("a later run replaces the case's earlier answers for the same tool", async () => {
  const s = start();
  s.clock.set(1);
  await judged(s, [BASE_CASES[0]]);
  await judged(s, [BASE_CASES[0]], [BASE_RUBRICS[1]]);
  const d = s.read().decisions;
  assert.equal(d.length, 2);
  assert.ok(d.find((x) => x.rubric === R2).at > d.find((x) => x.rubric === R1).at);
});

test("the first error stops the run and keeps what came back", async () => {
  const s = start();
  judge(s);
  await tick();
  s.llm.asked[0].release();
  await tick();
  s.llm.asked[1].release({ error: "rate-limited" });
  await tick();
  await tick();
  assert.equal(s.llm.asked.length, 2, "the third case is not asked");
  assert.deepEqual(s.read().run, { project: P, cases: [C1, C2, C3], done: 1, running: false, error: "rate-limited" });
  assert.deepEqual(keys(s), ["CS01/RB01", "CS01/RB02"]);
});

test("a busy reply is an error like any other, and a failed ask is unavailable", async () => {
  const s = start();
  judge(s);
  await tick();
  s.llm.asked[0].release({ error: "busy" });
  await tick();
  assert.deepEqual(s.read().run, { project: P, cases: [C1, C2, C3], done: 0, running: false, error: "busy" });

  const t = start();
  judge(t);
  await tick();
  t.llm.asked[0].release({ error: "no-answerer" });
  await tick();
  assert.equal(t.read().run.error, "unavailable", "the bus's own refusal is unavailable");
});

test("a Judge pressed while a run is going is ignored", async () => {
  const s = start();
  judge(s);
  await tick();
  const before = s.emitted.length;
  judge(s, [BASE_CASES[2]]);
  assert.equal(s.emitted.length, before);
  await releaseAll(s);
  assert.equal(s.llm.asked.length, 3);
  assert.deepEqual(s.read().run.cases, [C1, C2, C3]);
  judge(s, [BASE_CASES[2]]);
  await tick();
  assert.equal(s.llm.asked.length, 4, "once it ends, the next Judge runs");
});

test("an edited case text drops its answers; other edits and other cases keep theirs", async () => {
  const s = start();
  await judged(s, BASE_CASES.slice(0, 2));
  casesNow(s, [{ ...BASE_CASES[0], answers: { [YN]: "yes" } }, BASE_CASES[1]]);
  assert.equal(s.read().decisions.length, 4, "a right answer is not the text");
  const before = s.emitted.length;
  casesNow(s, [{ ...BASE_CASES[0], text: "To win the cup." }, BASE_CASES[1]]);
  assert.deepEqual(keys(s), ["CS02/RB01", "CS02/RB02"]);
  assert.equal(s.emitted.length, before + 1);
});

test("a case being removed keeps its answers, so Undo shows them; a gone case drops them", async () => {
  const s = start();
  await judged(s, BASE_CASES.slice(0, 2));
  casesNow(s, [{ ...BASE_CASES[0], removing: true }, BASE_CASES[1]]);
  assert.equal(s.read().decisions.length, 4);
  casesNow(s, [BASE_CASES[1]]);
  assert.deepEqual(keys(s), ["CS02/RB01", "CS02/RB02"]);
});

test("a changed question drops only its answer, and the tool's decision with its last one", async () => {
  const s = start();
  await judged(s, [BASE_CASES[0]]);
  rubricsNow(s, [BASE_RUBRICS[0], rubric(R2, [yn(YN, { yes: "It is over" }), yn(YN2, { text: "Is it a value?" })])]);
  assert.deepEqual(s.read().decisions.find((d) => d.rubric === R2).answers.map((a) => a.id), [YN2]);
  rubricsNow(s, [BASE_RUBRICS[0], rubric(R2, [yn(YN, { yes: "It is over" }), yn(YN2, { text: "Is it a value at all?" })])]);
  assert.deepEqual(keys(s), ["CS01/RB01"]);
});

test("each kind of question change makes its answer stale", async () => {
  const changes = [
    ["the text", pick({ text: "Which is it?" })],
    ["the kind", pick({ kind: "yesno" })],
    ["an option's name", pick({ options: [opt(GOAL, "Aim"), opt(VALUE, "Value"), opt(OTHER, "Other")] })],
    ["an option's description", pick({ options: [{ ...opt(GOAL, "Goal"), description: "Ends" }, opt(VALUE, "Value"), opt(OTHER, "Other")] })],
    ["an added option", pick({ options: [opt(GOAL, "Goal"), opt(VALUE, "Value"), opt(OTHER, "Other"), opt(C3, "Wish")] })],
    ["a settled option removal", pick({ options: [opt(GOAL, "Goal"), opt(VALUE, "Value")] })],
    ["a settled question removal", null],
  ];
  for (const [what, q] of changes) {
    const s = start();
    await judged(s, [BASE_CASES[0]]);
    rubricsNow(s, [rubric(R1, q ? [q] : []), BASE_RUBRICS[1]]);
    assert.deepEqual(keys(s), ["CS01/RB02"], what);
  }
});

test("what is not sent to Jev is not a change: a tool switched off or renamed, a pick's criteria", async () => {
  const s = start();
  await judged(s, [BASE_CASES[0]]);
  const before = s.emitted.length;
  rubricsNow(s, [rubric(R1, [pick({ yes: "Unused" })], { on: false, name: "Renamed" }), BASE_RUBRICS[1]]);
  assert.equal(s.read().decisions.length, 2);
  assert.equal(s.emitted.length, before, "nothing changed, so nothing is announced");
});

test("pending removals keep the answers: of a tool, a question, an option, and an option pending when judged", async () => {
  const s = start();
  await judged(s, [BASE_CASES[0]]);
  rubricsNow(s, [{ ...BASE_RUBRICS[0], removing: true }, rubric(R2, [yn(YN, { removing: true }), yn(YN2, { text: "Is it a value?" })])]);
  assert.equal(s.read().decisions.length, 2);
  rubricsNow(s, [rubric(R1, [pick({ options: [opt(GOAL, "Goal"), opt(VALUE, "Value"), opt(OTHER, "Other", true)] })]), BASE_RUBRICS[1]]);
  assert.equal(s.read().decisions.length, 2, "an option pending removal keeps the pick");
  rubricsNow(s, BASE_RUBRICS);
  assert.equal(s.read().decisions.length, 2, "and Undo shows it again");
  rubricsNow(s, [BASE_RUBRICS[1]]);
  assert.deepEqual(keys(s), ["CS01/RB02"], "a gone tool drops its answers");

  // Judged while an option was pending removal: the snapshot left it out.
  const t = start();
  const pending = [rubric(R1, [pick({ options: [opt(GOAL, "Goal"), opt(VALUE, "Value"), opt(OTHER, "Other", true)] })])];
  await judged(t, [BASE_CASES[0]], pending);
  rubricsNow(t, pending);
  assert.equal(t.read().decisions.length, 1, "still pending: kept");
  rubricsNow(t, [rubric(R1, [pick({ options: [opt(GOAL, "Goal"), opt(VALUE, "Value")] })])]);
  assert.equal(t.read().decisions.length, 1, "settled: what was asked is what is there");
  rubricsNow(t, [rubric(R1, [pick()])]);
  assert.equal(t.read().decisions.length, 0, "undone instead: Jev was not offered that option");
});

test("a case edited while its answers were on the way gets none", async () => {
  const s = start();
  casesNow(s, BASE_CASES);
  judge(s, [BASE_CASES[0]]);
  await tick();
  casesNow(s, [{ ...BASE_CASES[0], text: "Changed." }, ...BASE_CASES.slice(1)]);
  s.llm.asked[0].release();
  await tick();
  assert.deepEqual(s.read().decisions, []);
  assert.equal(s.read().run.done, 1);
});

test("a reload keeps the answers and stops a run that was going where it got to", async () => {
  const s = start();
  judge(s);
  await tick();
  s.llm.asked[0].release();
  await tick();
  const t = start(s.saved.at(-1));
  assert.deepEqual(t.read().run, { project: P, cases: [C1, C2, C3], done: 1, running: false, error: null });
  assert.deepEqual(keys(t), ["CS01/RB01", "CS01/RB02"]);
  // What was stored still decides staleness after the reload.
  rubricsNow(t, [BASE_RUBRICS[0]]);
  assert.deepEqual(keys(t), ["CS01/RB01"]);
});

test("the pure functions: decisionsOf ignores unknown ids, fresh with nothing known keeps all", () => {
  const rubrics = BASE_RUBRICS.map(snap);
  const out = decisionsOf({ id: C1, text: "t" }, rubrics, [{ id: "nope", p: 1 }, { id: `${R2}/${YN}`, p: 2 }, { id: `${R2}/${YN2}`, p: 0 }], 9);
  assert.deepEqual(out.map(({ text, asked, ...d }) => d), [{ case: C1, rubric: R2, at: 9, answers: [{ id: YN2, p: 0 }] }]);
  assert.equal(fresh(out[0], null, null), out[0]);
});

// Pieces (passages.requested): judged one at a time, kept by text and tool.
const pieces = (s, passages, rubrics = BASE_RUBRICS) =>
  s.send({ type: "passages.requested", project: P, rubrics: rubrics.map(snap), passages }, PIECES);
const nextOpen = async (s) => {
  await tick();
  const open = s.llm.asked.find((c) => !c.released);
  open.released = true;
  return open;
};
const answer1 = async (s, reply) => {
  const open = await nextOpen(s);
  s.clock.increment(1000);
  open.release(reply);
  await tick();
  return open;
};
const pieceKeys = (s) => s.read().passages.answers.map((p) => p.text + "|" + p.rubric.slice(-4)).sort();
const JOURNAL = theCase(C1, "I always fail. Nobody likes me.");

test("pieces are queued in order, asked one at a time, and a piece waiting or answered is not queued twice", async () => {
  const s = start();
  casesNow(s, [JOURNAL]);
  pieces(s, ["I always fail.", "Nobody likes me.", "I always fail."]);
  assert.deepEqual(s.read().passages.waiting, ["I always fail.", "Nobody likes me."]);
  pieces(s, ["I always fail.", "Nobody likes me."]);
  assert.deepEqual(s.read().passages.waiting, ["I always fail.", "Nobody likes me."], "waiting pieces are not queued again");
  await tick();
  assert.equal(s.llm.asked.length, 1, "one piece at a time");
  assert.deepEqual(s.llm.asked[0].payload, payload("I always fail.", BASE_RUBRICS.map(snap)));
  await answer1(s);
  assert.deepEqual(s.read().passages.waiting, ["Nobody likes me."]);
  await answer1(s);
  assert.deepEqual(s.read().passages.waiting, []);
  assert.deepEqual(pieceKeys(s), ["I always fail.|RB01", "I always fail.|RB02", "Nobody likes me.|RB01", "Nobody likes me.|RB02"]);
  pieces(s, ["I always fail.", "Nobody likes me."]);
  await tick();
  assert.equal(s.llm.asked.length, 2, "answered pieces are not asked again");
  pieces(s, ["I always fail."], [BASE_RUBRICS[0]]);
  await tick();
  assert.equal(s.llm.asked.length, 2, "nor for a subset of their tools");
  assert.equal(JSON.parse(s.saved.at(-1)).version, VERSION);
  assert.equal(parse(s.saved.at(-1)).passages.length, 4, "a reload reads them back");
});

test("an answer is kept by the piece's text, so another case holding it asks nothing", async () => {
  const s = start();
  casesNow(s, [JOURNAL, theCase(C2, "Nobody likes me. It rained.")]);
  pieces(s, ["Nobody likes me."]);
  await answer1(s);
  pieces(s, ["Nobody likes me.", "It rained."]);
  assert.deepEqual(s.read().passages.waiting, ["It rained."]);
  await answer1(s);
  assert.equal(s.llm.asked.length, 2);
  assert.deepEqual(s.llm.asked[1].payload.state, { text: "It rained." });
  casesNow(s, [theCase(C2, "Nobody likes me. It rained.")]);
  assert.ok(pieceKeys(s).includes("Nobody likes me.|RB01"), "still held by the other case");
});

test("a changed question drops a piece's answer for it, and the piece is asked again", async () => {
  const s = start();
  pieces(s, ["I always fail."]);
  await answer1(s);
  rubricsNow(s, [BASE_RUBRICS[0], rubric(R2, [yn(YN, { yes: "It is over" }), yn(YN2, { text: "Is it a value?" })])]);
  const r2 = s.read().passages.answers.find((p) => p.rubric === R2);
  assert.deepEqual(r2.answers.map((a) => a.id), [YN2]);
  const changed = [BASE_RUBRICS[0], rubric(R2, [yn(YN, { yes: "It is over" }), yn(YN2, { text: "Is it a value?" })])];
  pieces(s, ["I always fail."], changed);
  assert.deepEqual(s.read().passages.waiting, ["I always fail."]);
  await answer1(s);
  assert.equal(s.llm.asked.length, 2);
  pieces(s, ["I always fail."], changed);
  assert.deepEqual(s.read().passages.waiting, [], "fresh again");
});

test("a piece no case holds any more loses its answers and leaves the queue", async () => {
  const s = start();
  casesNow(s, [JOURNAL]);
  pieces(s, ["I always fail.", "Nobody likes me."]);
  await answer1(s);
  pieces(s, ["Somebody else."]);
  // "Nobody likes me." is being asked; "Somebody else." waits.
  await tick();
  casesNow(s, [theCase(C1, "I often fail."), { ...JOURNAL, id: C2, removing: true }]);
  assert.deepEqual(s.read().passages.waiting, ["Nobody likes me."], "the piece being asked stays, the gone one leaves");
  assert.equal(s.read().passages.answers.length, 2, "a case pending removal still holds its pieces");
  casesNow(s, [theCase(C1, "I often fail.")]);
  assert.deepEqual(s.read().passages.answers, []);
  await answer1(s);
  assert.deepEqual(s.read().passages, { answers: [], waiting: [], error: null }, "an answer for a gone piece is not kept");
  await tick();
  assert.equal(s.llm.asked.length, 2, "the dropped piece is not asked");
});

test("a Judge pressed while a piece is asked runs next, and the queue waits behind it", async () => {
  const s = start();
  casesNow(s, [JOURNAL, ...BASE_CASES.slice(1)]);
  pieces(s, ["I always fail.", "Nobody likes me."]);
  await tick();
  judge(s, [BASE_CASES[1]]);
  assert.equal(s.read().run, null, "the run waits for the piece");
  await answer1(s);
  assert.deepEqual(s.llm.asked.map((c) => c.payload.state.text), ["I always fail.", "Playing fairly."]);
  assert.equal(s.read().run.running, true);
  assert.deepEqual(s.read().passages.waiting, ["Nobody likes me."]);
  await answer1(s);
  assert.equal(s.read().run.running, false);
  await answer1(s);
  assert.deepEqual(s.llm.asked.map((c) => c.payload.state.text), ["I always fail.", "Playing fairly.", "Nobody likes me."]);
  assert.deepEqual(s.read().passages.waiting, []);
});

test("a piece requested during a run is asked after it", async () => {
  const s = start();
  judge(s, BASE_CASES.slice(0, 2));
  await tick();
  pieces(s, ["It rained."]);
  assert.deepEqual(s.read().passages.waiting, ["It rained."]);
  await answer1(s);
  await answer1(s);
  assert.equal(s.read().run.running, false);
  await answer1(s);
  assert.deepEqual(s.llm.asked.map((c) => c.payload.state.text), ["To win the race.", "Playing fairly.", "It rained."]);
  assert.equal(s.read().passages.answers.length, 2);
});

test("an error stops the queue and keeps the reason; the next request clears it and resumes", async () => {
  const s = start();
  pieces(s, ["I always fail.", "Nobody likes me.", "It rained."]);
  await answer1(s);
  await answer1(s, { error: "rate-limited" });
  await tick();
  assert.equal(s.llm.asked.length, 2, "the third piece is not asked");
  assert.deepEqual(s.read().passages.waiting, []);
  assert.equal(s.read().passages.error, "rate-limited");
  pieces(s, ["I always fail.", "Nobody likes me.", "It rained."]);
  assert.equal(s.read().passages.error, null);
  assert.deepEqual(s.read().passages.waiting, ["Nobody likes me.", "It rained."]);
  await answer1(s);
  await answer1(s, { error: "no-answerer" });
  assert.equal(s.read().passages.error, "unavailable");
  pieces(s, ["It rained."], [rubric(R1, [yn(YN, { text: " " })])]);
  assert.equal(s.read().passages.error, "invalid", "nothing askable asks nothing");
  await tick();
  assert.equal(s.llm.asked.length, 4);
});

test("a version-1 store reads with no passages; a version-2 store reads them back", async () => {
  const s = start();
  await judged(s, [BASE_CASES[0]]);
  const v1 = JSON.parse(s.saved.at(-1));
  v1.version = 1;
  delete v1.passages;
  const old = parse(JSON.stringify(v1));
  assert.equal(old.decisions.length, 2);
  assert.deepEqual(old.passages, []);
  assert.deepEqual(start(JSON.stringify(v1)).read().passages, { answers: [], waiting: [], error: null });

  pieces(s, ["It rained."]);
  await answer1(s);
  const t = start(s.saved.at(-1));
  assert.deepEqual(t.read().passages.answers, s.read().passages.answers);
  assert.equal(t.read().decisions.length, 2);
  const bad = JSON.parse(s.saved.at(-1));
  bad.passages.push({ text: 1 }, { text: "x", rubric: R1, at: 1, answers: [], asked: {} });
  assert.equal(parse(JSON.stringify(bad)).passages.length, 2, "malformed passages are left out");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
