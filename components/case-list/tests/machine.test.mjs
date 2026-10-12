import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import {
  machine,
  rows,
  onTools,
  firstLine,
  answersLine,
  verdict,
  snapshot,
  blocked,
  counts,
  progress,
  waiting,
  stopped,
  errorText,
} from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["case.selected", "judging.requested", "results.selected"].map((n) => [n, schema(n)]));

const id = (tag, n) => `01K6TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const A = id("P", 1);
const B = id("P", 2);
const D1 = id("D", 1);
const D2 = id("D", 2);
const [GOAL, VALUE, OTHER] = [1, 2, 3].map((n) => id("N", n));
const PICK = id("Q", 1);
const YES = id("Q", 2);

const option = (oid, name, removing = false) => ({ id: oid, name, description: "", removing });
const pick = (extra = {}) => ({
  id: PICK, kind: "pick", text: "Goal, value or other?", yes: "", no: "",
  options: [option(GOAL, "Goal"), option(VALUE, "Value"), option(OTHER, "Other")], removing: false, ...extra,
});
const yesno = (extra = {}) => ({ id: YES, kind: "yesno", text: "Is it a goal?", yes: "", no: "", options: [], removing: false, ...extra });
const rubric = (n, project, { on = true, removing = false, questions = [pick()] } = {}) => ({
  id: id("R", n), project, name: `Tool ${n}`, on, removing, questions,
});
const kase = (n, project, { text = `Case ${n}`, answers = {}, removing = false } = {}) => ({
  id: id("C", n), project, text, answers, removing,
});
const decision = (n, rubricN, answers) => ({ case: id("C", n), rubric: id("R", rubricN), at: 1, answers });

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

test("the rows are the project's cases in order, without those being removed", () => {
  const all = [kase(1, A), kase(2, B), kase(3, A, { removing: true }), kase(4, A)];
  assert.deepEqual(rows(all, A).map((c) => c.id), [id("C", 1), id("C", 4)]);
});

test("a row shows its first line", () => {
  assert.equal(firstLine("  To have a big house.  \nmore"), "To have a big house.");
  assert.equal(firstLine(""), "");
});

test("right answers are named, for switched-on tools only, ignoring what no longer fits", () => {
  const tools = onTools(
    [
      rubric(1, A, { questions: [pick(), yesno(), { ...yesno(), id: id("Q", 3) }] }),
      rubric(2, A, { on: false, questions: [{ ...yesno(), id: id("Q", 4) }] }),
    ],
    A,
  );
  const c = kase(1, A, { answers: { [PICK]: GOAL, [YES]: "yes", [id("Q", 3)]: "no", [id("Q", 4)]: "yes" } });
  assert.equal(answersLine(c, tools), "Right answers: Goal, Yes, No");
  assert.equal(answersLine(kase(2, A, { answers: { [PICK]: VALUE } }), tools), "Right answer: Value");
  assert.equal(answersLine(kase(3, A), tools), "No right answer");
  // An option being removed, a yes/no value on a pick question, an option on a yes/no one.
  const gone = onTools([rubric(1, A, { questions: [pick({ options: [option(GOAL, "Goal", true), option(VALUE, "Value")] }), yesno()] })], A);
  assert.equal(answersLine(kase(4, A, { answers: { [PICK]: GOAL, [YES]: VALUE } }), gone), "No right answer");
  assert.equal(answersLine(kase(5, A, { answers: { [PICK]: "yes" } }), gone), "No right answer");
  // A question being removed counts for nothing.
  const removed = onTools([rubric(1, A, { questions: [pick({ removing: true })] })], A);
  assert.equal(answersLine(kase(6, A, { answers: { [PICK]: GOAL } }), removed), "No right answer");
});

test("a tick when every answered question is right, a cross when one is not, nothing when nothing compares", () => {
  const tools = onTools([rubric(1, A, { questions: [pick(), yesno()] })], A);
  const c = kase(1, A, { answers: { [PICK]: GOAL, [YES]: "yes" } });
  const right = [decision(1, 1, [{ id: PICK, p: 0.8, choice: GOAL }, { id: YES, p: 0.5 }])];
  assert.equal(verdict(c, tools, right), true, "p 0.5 counts as yes");
  const wrongPick = [decision(1, 1, [{ id: PICK, p: 0.8, choice: VALUE }, { id: YES, p: 0.9 }])];
  assert.equal(verdict(c, tools, wrongPick), false);
  const wrongYes = [decision(1, 1, [{ id: PICK, p: 0.8, choice: GOAL }, { id: YES, p: 0.49 }])];
  assert.equal(verdict(c, tools, wrongYes), false);
  assert.equal(verdict(c, tools, []), null, "not judged");
  assert.equal(verdict(kase(1, A), tools, right), null, "no right answer");
  // An answer to a tool that is off is not counted.
  const off = onTools([rubric(1, A, { on: false })], A);
  assert.equal(verdict(c, off, wrongPick), null);
  // An answer to a question with no right answer is not counted.
  assert.equal(verdict(kase(1, A, { answers: { [YES]: "yes" } }), tools, wrongPick), true);
});

test("the Judge all snapshot holds the project's live cases and its switched-on tools, unflagged", () => {
  const cases = [kase(1, A), kase(2, B), kase(3, A, { removing: true }), kase(4, A, { text: "  " }), kase(5, A)];
  const rubrics = [
    rubric(1, A, { questions: [pick({ options: [option(GOAL, "Goal"), option(VALUE, "Value", true), option(OTHER, "Other")] }), yesno({ removing: true })] }),
    rubric(2, A, { on: false }),
    rubric(3, A, { removing: true }),
    rubric(4, B),
    rubric(5, A, { questions: [yesno({ removing: true })] }),
  ];
  const s = snapshot(cases, rubrics, A);
  assert.deepEqual(s, {
    project: A,
    cases: [{ id: id("C", 1), text: "Case 1" }, { id: id("C", 5), text: "Case 5" }],
    rubrics: [
      {
        id: id("R", 1),
        name: "Tool 1",
        questions: [
          {
            id: PICK, kind: "pick", text: "Goal, value or other?", yes: "", no: "",
            options: [{ id: GOAL, name: "Goal", description: "" }, { id: OTHER, name: "Other", description: "" }],
          },
        ],
      },
    ],
  });
  assert.ok(new Validator(SCHEMAS["judging.requested"], "2020-12").validate(s).valid);
});

test("the reasons Judge all cannot run", () => {
  const ok = { cases: [kase(1, A)], rubrics: [rubric(1, A)], run: null, current: A, signedIn: true, keySet: true };
  assert.equal(blocked(ok), null);
  assert.equal(blocked({ ...ok, signedIn: false }), "Sign in to judge.");
  assert.equal(blocked({ ...ok, keySet: false }), "Add your Jev key in Settings.");
  assert.equal(counts(ok), "1 case, 1 detector on");
  assert.equal(blocked({ ...ok, rubrics: [rubric(1, A, { on: false })] }), "Switch on a detector to judge.");
  assert.equal(blocked({ ...ok, rubrics: [rubric(1, A, { questions: [yesno({ text: " " })] })] }), "Add a question to a detector to judge.");
  assert.equal(blocked({ ...ok, rubrics: [rubric(1, A, { questions: [pick({ options: [option(GOAL, "Goal")] })] })] }), "Add a question to a detector to judge.");
  assert.equal(blocked({ ...ok, cases: [] }), "Add a case to judge.");
  assert.equal(blocked({ ...ok, cases: [kase(1, A, { text: "" })] }), "Add a case to judge.");
  const going = { project: A, cases: [id("C", 1)], done: 0, running: true, error: null };
  assert.equal(blocked({ ...ok, run: going }), "Judge all is running.");
  assert.equal(blocked({ ...ok, run: { ...going, project: B } }), "Judge all is running in another project.");
  assert.equal(blocked({ ...ok, run: { ...going, running: false, error: "no-key" } }), null, "a stopped run does not block");
});

test("progress, waiting rows and a stopped run's reason belong to the run's own project", () => {
  const run = { project: A, cases: [id("C", 1), id("C", 2), id("C", 3), id("C", 4)], done: 1, running: true, error: null };
  assert.deepEqual(progress(run, A), { text: "Judging 2 of 4…", share: 0.25 });
  assert.equal(progress(run, B), null);
  assert.equal(progress({ ...run, running: false }, A), null);
  assert.equal(waiting(run, A, id("C", 1)), false);
  assert.equal(waiting(run, A, id("C", 2)), true);
  assert.equal(waiting(run, B, id("C", 2)), false);
  assert.equal(stopped(run, A), null);
  assert.equal(stopped({ ...run, running: false, error: "signed-out" }, A), "signed-out");
  assert.equal(stopped({ ...run, running: false, error: "signed-out" }, B), null);
  assert.equal(errorText("signed-out"), "Sign in to judge.");
  assert.equal(errorText("no-key"), "Add your Jev key in Settings.");
  assert.equal(errorText("no-answerer"), "Jev is unavailable.");
});

// What llm: read answers: signed in, with a Jev key saved.
const LLM = { signedIn: true, provider: "echo", providers: [], model: "echo", models: [], effort: "default", efforts: [], ttl: "1h", jev: { keySet: true } };

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ current = A, cases = [], rubrics = [], decisions = [], run = null, open = {}, fail, llm = LLM } = {}) => {
  const replies = {
    llm,
    projects: fail ?? { projects: [], current },
    cases: { cases, open },
    rubrics: { rubrics },
    decisions: { decisions, run },
  };
  const drafts = [D1, D2];
  const actor = createActor(machine, { input: { ask: (target) => Promise.resolve(replies[target]), mint: () => drafts.shift() } });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted };
};

test("a pick of a shown case or New case emits case.selected with the project; others are refused", async () => {
  const { actor, emitted } = await start({ cases: [kase(1, A), kase(2, B), kase(3, A, { removing: true })] });
  actor.send({ type: "_pick", id: id("C", 1) });
  actor.send({ type: "_pick", id: D1 });
  actor.send({ type: "_pick", id: id("C", 2) });
  actor.send({ type: "_pick", id: id("C", 3) });
  assert.deepEqual(emitted, [
    { type: "case.selected", id: id("C", 1), project: A },
    { type: "case.selected", id: D1, project: A },
  ]);
  valid(emitted);
});

test("Judge all emits the snapshot and then results.selected, and nothing while blocked", async () => {
  const { actor, emitted } = await start({ cases: [kase(1, A)], rubrics: [rubric(1, A)] });
  actor.send({ type: "_judge" });
  assert.deepEqual(emitted.map((e) => e.type), ["judging.requested", "results.selected"]);
  assert.deepEqual(emitted[0].cases, [{ id: id("C", 1), text: "Case 1" }]);
  valid(emitted);
  actor.send({
    type: "decision.changed",
    decisions: [],
    run: { project: A, cases: [id("C", 1)], done: 0, running: true, error: null },
  });
  actor.send({ type: "_judge" });
  assert.equal(emitted.length, 2, "a run is going");
});

test("the list follows the facts, and New case gets a fresh id once its case is saved", async () => {
  const { actor } = await start({ cases: [kase(1, A)], rubrics: [rubric(1, A)] });
  const ctx = () => actor.getSnapshot().context;
  actor.send({ type: "project.changed", projects: [], current: B });
  assert.equal(ctx().current, B);
  actor.send({ type: "case.changed", cases: [kase(1, A), { ...kase(9, B), id: D1 }], open: { [B]: D1 } });
  assert.equal(ctx().draft, D2);
  assert.deepEqual(ctx().open, { [B]: D1 });
  actor.send({ type: "rubric.changed", rubrics: [] });
  assert.deepEqual(ctx().rubrics, []);
});

test("Judge all follows llm: signed out or without a key it does nothing, until llm.changed says otherwise", async () => {
  const { actor, emitted } = await start({ cases: [kase(1, A)], rubrics: [rubric(1, A)], llm: { ...LLM, signedIn: false } });
  actor.send({ type: "_judge" });
  assert.equal(emitted.length, 0);
  assert.equal(blocked(actor.getSnapshot().context), "Sign in to judge.");
  actor.send({ type: "llm.changed", ...LLM, jev: { keySet: false } });
  assert.equal(blocked(actor.getSnapshot().context), "Add your Jev key in Settings.");
  actor.send({ type: "llm.changed", ...LLM, jev: { keySet: false, starterLeft: 0 } });
  assert.equal(blocked(actor.getSnapshot().context), "The 100 starter requests are used up. Add your Jev key in Settings.");
  actor.send({ type: "llm.changed", ...LLM });
  actor.send({ type: "_judge" });
  assert.deepEqual(emitted.map((e) => e.type), ["judging.requested", "results.selected"]);
});

test("a fact that cannot answer leaves the list failed", async () => {
  const { actor } = await start({ fail: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
});
