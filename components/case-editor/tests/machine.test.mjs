import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, menus, onTools, pickBlock, yesnoRow, cards, mark, snapshot, blocked, uses, judging, stopped, isEmpty } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["case.saved", "case.selected", "judging.requested", "removal.started"].map((n) => [n, schema(n)]));

const id = (tag, n) => `01K6TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const A = id("P", 1);
const B = id("P", 2);
const NEW = id("D", 1);
const [GOAL, VALUE, OTHER] = [1, 2, 3].map((n) => id("N", n));
const PICK = id("Q", 1);
const YES = id("Q", 2);
const OFFQ = id("Q", 3);

const option = (oid, name, removing = false) => ({ id: oid, name, description: "", removing });
const pick = (extra = {}) => ({
  id: PICK, kind: "pick", text: "Goal, value or other?", yes: "", no: "",
  options: [option(GOAL, "Goal"), option(VALUE, "Value"), option(OTHER, "Other")], removing: false, ...extra,
});
const yesno = (extra = {}) => ({ id: YES, kind: "yesno", text: "Is it a goal?", yes: "", no: "", options: [], removing: false, ...extra });
const rubric = (n, project, { on = true, removing = false, name = `Tool ${n}`, questions = [pick()] } = {}) => ({
  id: id("R", n), project, name, on, removing, questions,
});
const kase = (n, project, { text = `Case ${n}`, answers = {}, removing = false } = {}) => ({
  id: id("C", n), project, text, answers, removing,
});
const LLM = { signedIn: true, provider: "echo", providers: [], model: "echo", models: [], effort: "default", efforts: [], ttl: "1h", jev: { keySet: true } };

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

// --- Pure functions -----------------------------------------------------------------

test("the right-answer menus are the questions of the tools that are on, grouped by tool", () => {
  const rubrics = [
    rubric(1, A, { name: "Goal or value", questions: [pick({ options: [option(GOAL, "Goal"), option(VALUE, "Value", true), option(OTHER, " ")] }), yesno()] }),
    rubric(2, A, { on: false, questions: [yesno({ id: OFFQ })] }),
    rubric(3, A, { removing: true }),
    rubric(4, B),
    rubric(5, A, { name: " ", questions: [yesno({ id: id("Q", 5), text: "" }), yesno({ id: id("Q", 6), removing: true })] }),
  ];
  const answers = { [PICK]: VALUE, [YES]: "yes", [OFFQ]: "no" };
  assert.deepEqual(menus(onTools(rubrics, A), answers), [
    {
      tool: "Goal or value", question: "Goal, value or other?", id: PICK,
      choices: [{ value: GOAL, label: "Goal" }, { value: OTHER, label: "Untitled option" }],
      value: "", // the answer's option is being removed, so it shows as no right answer
    },
    { tool: "Goal or value", question: "Is it a goal?", id: YES, choices: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], value: "yes" },
    { tool: "Untitled tool", question: "Untitled question", id: id("Q", 5), choices: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], value: "" },
  ]);
});

test("a pick block shows the pick, how sure, the other options in order, and the mark", () => {
  const answer = { id: PICK, p: 0.584, choice: VALUE, probabilities: [{ id: GOAL, p: 0.31 }, { id: VALUE, p: 0.584 }, { id: OTHER, p: 0.106 }] };
  assert.deepEqual(pickBlock(pick(), answer, GOAL), {
    pick: "Value",
    sure: 58,
    others: [{ name: "Goal", pct: 31 }, { name: "Other", pct: 11 }],
    mark: { right: false, answer: "Goal" },
  });
  assert.deepEqual(pickBlock(pick(), answer, VALUE).mark, { right: true });
  assert.equal(pickBlock(pick(), answer, undefined).mark, null, "no right answer, no mark");
  // An option missing from the probabilities shows 0%.
  assert.deepEqual(pickBlock(pick(), { id: PICK, p: 1, choice: GOAL, probabilities: [] }, null).others.map((o) => o.pct), [0, 0]);
});

test("a yes / no row is green at 60% or more, red at 40% or less, grey between, and Yes from p 0.5", () => {
  const row = (p, value) => yesnoRow(yesno(), { id: YES, p }, value);
  assert.deepEqual(row(0.72, "yes"), { pct: 72, tone: "yes", mark: { right: true } });
  assert.equal(row(0.6).tone, "yes");
  assert.equal(row(0.59).tone, "");
  assert.equal(row(0.41).tone, "");
  assert.equal(row(0.4).tone, "no");
  assert.deepEqual(row(0.5, "no").mark, { right: false, answer: "No" });
  assert.deepEqual(row(0.49, "no").mark, { right: true });
  assert.equal(mark(yesno(), GOAL, { id: YES, p: 0.9 }), null, "a value that does not fit is no right answer");
});

test("verdict cards: one per tool that is on, null before any answer, Not judged for a missing one", () => {
  const tools = onTools([rubric(1, A, { questions: [yesno(), pick()] }), rubric(2, A, { questions: [yesno({ id: OFFQ })] }), rubric(3, A, { on: false })], A);
  const c = kase(1, A, { answers: { [PICK]: GOAL } });
  assert.equal(cards(tools, [], c), null);
  const decisions = [
    { case: c.id, rubric: id("R", 1), at: 1, answers: [{ id: PICK, p: 0.9, choice: GOAL, probabilities: [] }, { id: YES, p: 0.3 }] },
    { case: id("C", 9), rubric: id("R", 2), at: 1, answers: [{ id: OFFQ, p: 0.3 }] },
  ];
  const shown = cards(tools, decisions, c);
  assert.deepEqual(shown.map((x) => x.id), [id("R", 1), id("R", 2)]);
  assert.deepEqual(shown[0].picks.map((q) => q.id), [PICK], "pick questions first");
  assert.deepEqual(shown[0].picks[0].block.mark, { right: true });
  assert.equal(shown[0].yesnos[0].row.pct, 30);
  assert.equal(shown[1].yesnos[0].row, null, "another case's answer is not this one's");
});

test("the Judge snapshot holds this one case and the switched-on tools, unflagged", () => {
  const rubrics = [
    rubric(1, A, { questions: [pick({ options: [option(GOAL, "Goal"), option(VALUE, "Value", true), option(OTHER, "Other")] }), yesno({ removing: true })] }),
    rubric(2, A, { on: false }),
    rubric(3, A, { questions: [yesno({ removing: true })] }),
  ];
  const s = snapshot({ id: id("C", 1), project: A, text: "To win the race.", answers: { [PICK]: GOAL } }, rubrics, A);
  assert.deepEqual(s, {
    project: A,
    cases: [{ id: id("C", 1), text: "To win the race." }],
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

test("the reasons Judge cannot run, signed out and no key among them", () => {
  const draft = { id: id("C", 1), project: A, text: "To win.", answers: {} };
  const ok = { draft, rubrics: [rubric(1, A)], run: null, current: A, signedIn: true, keySet: true };
  assert.equal(blocked(ok), null);
  assert.equal(blocked({ ...ok, signedIn: false }), "Sign in to judge.");
  assert.equal(blocked({ ...ok, keySet: false }), "Add your Jev key in Settings.");
  assert.equal(blocked({ ...ok, rubrics: [rubric(1, B)] }), "Make a tool in Tools to judge.");
  assert.equal(blocked({ ...ok, rubrics: [rubric(1, A, { on: false })] }), "Switch on a tool in Tools to judge.");
  assert.equal(blocked({ ...ok, rubrics: [rubric(1, A, { questions: [yesno({ text: " " })] })] }), "Add a question to a tool to judge.");
  assert.equal(blocked({ ...ok, draft: { ...draft, text: "  " } }), "Write the text to judge.");
  const run = { project: A, cases: [draft.id], done: 0, running: true, error: null };
  assert.equal(blocked({ ...ok, run }), "Judging this case…");
  assert.equal(blocked({ ...ok, run: { ...run, cases: [id("C", 2)] } }), "Judge all is running.");
  assert.equal(blocked({ ...ok, run: { ...run, project: B } }), "Judge all is running in another project.");
  assert.equal(blocked({ ...ok, run: { ...run, running: false, error: "no-key" } }), null, "a stopped run does not block");
});

test("the line names the tools that judge, the judging state and a stopped run belong to this case", () => {
  assert.equal(uses([rubric(1, A, { name: "Goal or value" })], A), "Judges this case with Goal or value.");
  assert.equal(uses([rubric(1, A, { name: "A" }), rubric(2, A, { name: "B" }), rubric(3, A, { name: "C" })], A), "Judges this case with A, B and C.");
  assert.equal(uses([1, 2, 3, 4].map((n) => rubric(n, A)), A), "Judges this case with 4 tools that are on.");
  const run = { project: A, cases: [id("C", 1), id("C", 2)], done: 1, running: true, error: null };
  assert.equal(judging(run, A, id("C", 1)), false, "already judged");
  assert.equal(judging(run, A, id("C", 2)), true);
  assert.equal(judging(run, B, id("C", 2)), false);
  const failed = { ...run, running: false, error: "bad-key" };
  assert.equal(stopped(failed, A, id("C", 2)), "bad-key");
  assert.equal(stopped(failed, A, id("C", 3)), null);
});

test("a case is empty with no text and no right answer", () => {
  assert.equal(isEmpty({ text: " \n", answers: {} }), true);
  assert.equal(isEmpty({ text: "x", answers: {} }), false);
  assert.equal(isEmpty({ text: "", answers: { [PICK]: GOAL } }), false);
});

// --- The actor ------------------------------------------------------------------------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const start = async ({ current = A, cases = [kase(1, A)], open = { [A]: id("C", 1) }, rubrics = [rubric(1, A)], decisions = [], run = null, llm = LLM, fail } = {}) => {
  const replies = { projects: fail ?? { projects: [], current }, cases: { cases, open }, rubrics: { rubrics }, decisions: { decisions, run }, llm };
  const actor = createActor(machine, { input: { ask: (target) => Promise.resolve(replies[target]), mint: () => NEW, throttleMs: 20 } });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await wait(0);
  return { actor, emitted, ctx: () => actor.getSnapshot().context };
};

test("typing saves the whole case once at the throttle, and at once on blur", async () => {
  const { actor, emitted, ctx } = await start({ cases: [kase(1, A, { answers: { [PICK]: GOAL } })] });
  assert.equal(ctx().draft.text, "Case 1");
  actor.send({ type: "_edit", text: "T" });
  actor.send({ type: "_edit", text: "To" });
  await wait(40);
  assert.deepEqual(emitted, [{ type: "case.saved", id: id("C", 1), project: A, text: "To", answers: { [PICK]: GOAL } }]);
  actor.send({ type: "_edit", text: "To win" });
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].text, "To win");
  await wait(40);
  assert.equal(emitted.length, 2, "the blur's save was the one save");
  valid(emitted);
});

test("a new case is never saved empty, and is kept once something is written", async () => {
  const { actor, emitted, ctx } = await start({ open: { [A]: NEW } });
  assert.deepEqual(ctx().draft, { id: NEW, project: A, text: "", answers: {} });
  actor.send({ type: "_edit", text: "  " });
  actor.send({ type: "_blur" });
  actor.send({ type: "_judge" });
  actor.send({ type: "_delete" });
  assert.deepEqual(emitted, [], "nothing written, nothing kept, and nothing to delete");
  actor.send({ type: "_edit", text: "To travel the world." });
  actor.send({ type: "_blur" });
  assert.deepEqual(emitted, [{ type: "case.saved", id: NEW, project: A, text: "To travel the world.", answers: {} }]);
});

test("a right answer is saved at once, cleared with No right answer, and an off tool's answer is kept", async () => {
  const { actor, emitted } = await start({ cases: [kase(1, A, { answers: { [OFFQ]: "yes" } })] });
  actor.send({ type: "_answer", id: PICK, value: GOAL });
  actor.send({ type: "_answer", id: PICK, value: "" });
  assert.deepEqual(emitted.map((e) => e.answers), [{ [OFFQ]: "yes", [PICK]: GOAL }, { [OFFQ]: "yes" }]);
  valid(emitted);
});

test("the editor follows the open case; typing waits for nothing, and a pick saves it first", async () => {
  const cases = [kase(1, A), kase(2, A)];
  const { actor, emitted, ctx } = await start({ cases });
  // The fact's news about the same case, while typing waits, keeps what is on screen.
  actor.send({ type: "_edit", text: "Typed" });
  actor.send({ type: "case.changed", cases, open: { [A]: id("C", 1) } });
  assert.equal(ctx().draft.text, "Typed");
  // Another case picked: the typing is saved, then the other case opens.
  actor.send({ type: "case.changed", cases, open: { [A]: id("C", 2) } });
  assert.deepEqual(emitted.map((e) => [e.type, e.text]), [["case.saved", "Typed"]]);
  assert.equal(ctx().draft.id, id("C", 2));
  await wait(40);
  assert.equal(emitted.length, 1, "no later save of the case left");
  // In clean, the fact's copy replaces the draft.
  actor.send({ type: "case.changed", cases: [kase(1, A), kase(2, A, { text: "Elsewhere" })], open: { [A]: id("C", 2) } });
  assert.equal(ctx().draft.text, "Elsewhere");
});

test("a project switch shows that project's open case, or the empty state", async () => {
  const cases = [kase(1, A), kase(2, B)];
  const { actor, emitted, ctx } = await start({ cases, open: { [A]: id("C", 1), [B]: id("C", 2) } });
  actor.send({ type: "_edit", text: "Typed" });
  actor.send({ type: "project.changed", projects: [], current: B });
  assert.deepEqual(emitted.map((e) => e.text), ["Typed"], "the case left behind is saved");
  assert.equal(ctx().draft.id, id("C", 2));
  actor.send({ type: "case.changed", cases, open: { [A]: id("C", 1) } });
  assert.equal(ctx().draft, null, "no open case in B");
});

test("with no case open, New case emits case.selected with a fresh id", async () => {
  const { actor, emitted, ctx } = await start({ cases: [], open: {} });
  assert.equal(ctx().draft, null);
  actor.send({ type: "_edit", text: "x" });
  actor.send({ type: "_new" });
  assert.deepEqual(emitted, [{ type: "case.selected", id: NEW, project: A }]);
  valid(emitted);
});

test("Judge saves what is typed and emits one case; nothing while blocked", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_edit", text: "To win the race." });
  actor.send({ type: "_judge" });
  assert.deepEqual(emitted.map((e) => e.type), ["case.saved", "judging.requested"]);
  assert.deepEqual(emitted[1].cases, [{ id: id("C", 1), text: "To win the race." }]);
  valid(emitted);
  actor.send({ type: "decision.changed", decisions: [], run: { project: A, cases: [id("C", 1)], done: 0, running: true, error: null } });
  actor.send({ type: "_judge" });
  assert.equal(emitted.filter((e) => e.type === "judging.requested").length, 1, "this case is being judged");
});

test("Judge follows llm: signed out or without a key it does nothing until llm.changed", async () => {
  const { actor, emitted, ctx } = await start({ llm: { error: "no-answerer" } });
  assert.equal(blocked(ctx()), "Sign in to judge.");
  actor.send({ type: "llm.changed", ...LLM, jev: { keySet: false } });
  assert.equal(blocked(ctx()), "Add your Jev key in Settings.");
  actor.send({ type: "llm.changed", ...LLM, jev: { keySet: false, starterLeft: 0 } });
  assert.equal(blocked(ctx()), "The 100 starter requests are used up. Add your Jev key in Settings.");
  actor.send({ type: "_judge" });
  assert.equal(emitted.length, 0);
  actor.send({ type: "llm.changed", ...LLM });
  actor.send({ type: "_judge" });
  assert.equal(emitted.at(-1).type, "judging.requested");
});

test("Delete case saves what is typed, then starts the removal with the first line as its name", async () => {
  const { actor, emitted } = await start({ cases: [kase(1, A, { text: "To win.\nmore" })] });
  actor.send({ type: "_edit", text: "  To win the race.  \nmore" });
  actor.send({ type: "_delete" });
  assert.deepEqual(emitted.map((e) => e.type), ["case.saved", "removal.started"]);
  assert.deepEqual(emitted[1], { type: "removal.started", kind: "case", id: id("C", 1), name: "To win the race." });
  valid(emitted);
});

test("a fact that cannot answer leaves the editor failed", async () => {
  const { actor } = await start({ fail: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
});
