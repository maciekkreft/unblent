import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, waitFor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, block, blocks, progress, emptyLine } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SELECTED = JSON.parse(readFileSync(resolve(HERE, "..", "events", "case.selected.json"), "utf8"));

const id = (tag, n) => `01K6TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const A = id("P", 1);
const B = id("P", 2);
const [GOAL, VALUE, OTHER] = [1, 2, 3].map((n) => id("N", n));
const PICK = id("Q", 1);
const IS_GOAL = id("Q", 2);
const IS_VALUE = id("Q", 3);
const PICKER = id("R", 1);
const YESNO = id("R", 2);

const option = (oid, name, removing = false) => ({ id: oid, name, description: "", removing });
const pickQ = { id: PICK, kind: "pick", text: "Is this a goal, a value, or neither?", yes: "", no: "", options: [option(GOAL, "Goal"), option(VALUE, "Value"), option(OTHER, "Other")], removing: false };
const yn = (qid, text) => ({ id: qid, kind: "yesno", text, yes: "", no: "", options: [], removing: false });
const RUBRICS = [
  { id: PICKER, project: A, name: "Goal or value", on: true, removing: false, questions: [pickQ] },
  { id: YESNO, project: A, name: "Goal or value (yes / no)", on: true, removing: false, questions: [yn(IS_GOAL, "Is this a goal?"), yn(IS_VALUE, "Is this a value?")] },
];

// The 18 cases as the seed has them: six of each right answer, and the two the mockup's
// Jev misses.
const RIGHT = [...Array(6).fill(GOAL), ...Array(6).fill(VALUE), ...Array(6).fill(OTHER)];
const CASES = RIGHT.map((pick, n) => ({
  id: id("C", n),
  project: A,
  text: n === 9 ? "To be warm, friendly, outgoing, supportive and genuine.\nmore" : n === 12 ? "What time does the train leave?" : `Case ${n}`,
  answers: { [PICK]: pick, [IS_GOAL]: pick === GOAL ? "yes" : "no", [IS_VALUE]: pick === VALUE ? "yes" : "no" },
  removing: false,
}));
const JEV = { 9: GOAL, 12: VALUE };
const pickOf = (n) => JEV[n] ?? RIGHT[n];
const pickDecisions = CASES.map((c, n) => ({
  case: c.id,
  rubric: PICKER,
  at: 1,
  answers: [{ id: PICK, p: n === 9 ? 0.58 : 0.9, choice: pickOf(n), probabilities: [], confidence: 0.5 }],
}));
// The yes / no tool: Jev is right everywhere but case 9's value question (32% yes, a miss)
// and the goal question of case 6, a value, at exactly 50%, which counts as Yes.
const yesnoDecisions = CASES.map((c, n) => ({
  case: c.id,
  rubric: YESNO,
  at: 1,
  answers: [
    { id: IS_GOAL, p: n === 6 ? 0.5 : RIGHT[n] === GOAL ? 0.8 : 0.1 },
    { id: IS_VALUE, p: n === 9 ? 0.32 : RIGHT[n] === VALUE ? 0.8 : 0.1 },
  ],
}));

const context = (extra = {}) => ({ current: A, rubrics: RUBRICS, cases: CASES, decisions: [...pickDecisions, ...yesnoDecisions], run: null, ...extra });

// --- Pure functions -----------------------------------------------------------------

test("the pick question: 16 of 18 right, per right answer, the table and the two misses", () => {
  const b = block(RUBRICS[0], pickQ, CASES, pickDecisions);
  assert.equal(b.right, 16);
  assert.equal(b.total, 18);
  assert.equal(b.tool, "Goal or value");
  assert.equal(b.question, "Is this a goal, a value, or neither?");
  assert.deepEqual(b.groups, [
    { name: "Goal", right: 6, total: 6 },
    { name: "Value", right: 5, total: 6 },
    { name: "Other", right: 5, total: 6 },
  ]);
  assert.deepEqual(b.names, ["Goal", "Value", "Other"]);
  assert.deepEqual(b.grid, [
    [6, 0, 0],
    [1, 5, 0],
    [0, 1, 5],
  ]);
  assert.deepEqual(b.misses, [
    { id: id("C", 9), text: "To be warm, friendly, outgoing, supportive and genuine.", line: "Right answer Value · Jev picked Goal, 58% sure" },
    { id: id("C", 12), text: "What time does the train leave?", line: "Right answer Other · Jev picked Value, 90% sure" },
  ]);
});

test("a yes / no question counts Yes from p 0.5, with Yes and No rows", () => {
  const [, goal, value] = blocks(context());
  assert.equal(goal.question, "Is this a goal?");
  assert.equal(goal.right, 17, "case 6 at 50% counts as yes, a miss");
  assert.deepEqual(goal.names, ["Yes", "No"]);
  assert.deepEqual(goal.groups, [{ name: "Yes", right: 6, total: 6 }, { name: "No", right: 11, total: 12 }]);
  assert.deepEqual(goal.misses.map((m) => m.line), ["Right answer No · Jev said 50% yes"]);
  assert.equal(value.right, 17);
  assert.deepEqual(value.grid, [[5, 1], [0, 12]]);
  assert.deepEqual(value.misses, [{ id: id("C", 9), text: "To be warm, friendly, outgoing, supportive and genuine.", line: "Right answer Yes · Jev said 32% yes" }]);
});

test("only cases with a right answer that fits and an answer from Jev count", () => {
  const cases = CASES.map((c, n) =>
    n === 0 ? { ...c, answers: {} } : n === 1 ? { ...c, answers: { [PICK]: id("N", 9) } } : n === 2 ? { ...c, removing: true } : c,
  );
  const decisions = pickDecisions.filter((d) => d.case !== id("C", 3));
  const [b] = blocks(context({ cases, decisions }));
  assert.equal(b.total, 14);
  assert.deepEqual(b.groups[0], { name: "Goal", right: 2, total: 2 });
  // A right answer on an option being removed no longer fits.
  const removed = RUBRICS.map((r, i) => (i ? r : { ...r, questions: [{ ...pickQ, options: [option(GOAL, "Goal"), option(VALUE, "Value"), option(OTHER, "Other", true)] }] }));
  // So does Jev's pick of it.
  const picked = pickDecisions.map((d, n) => (n ? d : { ...d, answers: [{ ...d.answers[0], choice: OTHER }] }));
  const [c] = blocks(context({ rubrics: removed, decisions: picked }));
  assert.deepEqual(c.names, ["Goal", "Value"]);
  assert.equal(c.total, 11, "the six Other cases and case 0, which Jev picked Other for, are left out");
});

test("a block per question of the tools that are on, in order; none for a question nothing counts for", () => {
  assert.deepEqual(blocks(context()).map((b) => b.id), [PICK, IS_GOAL, IS_VALUE]);
  assert.deepEqual(blocks(context({ decisions: pickDecisions })).map((b) => b.id), [PICK]);
  const off = RUBRICS.map((r, i) => (i ? { ...r, on: false } : r));
  assert.deepEqual(blocks(context({ rubrics: off })).map((b) => b.id), [PICK]);
  assert.deepEqual(blocks(context({ current: B })), []);
});

test("the empty states say what to do first", () => {
  const line = (extra) => emptyLine(context(extra), blocks(context(extra)));
  assert.equal(line({}), null);
  assert.equal(line({ cases: [] }), "Results appear here after the first Judge all. Add a detector and some cases with right answers first.");
  assert.equal(line({ rubrics: [] }), "Results appear here after the first Judge all. Add a detector and some cases with right answers first.");
  assert.equal(line({ rubrics: RUBRICS.map((r) => ({ ...r, on: false })) }), "Switch on a detector in Detectors to see its results.");
  assert.equal(line({ decisions: [] }), "Results appear here after the first Judge all, for every question where a case has a right answer.");
});

test("a run of this project that is going shows its progress", () => {
  const run = { project: A, cases: CASES.map((c) => c.id), done: 2, running: true, error: null };
  assert.deepEqual(progress(run, A), { text: "Judging 3 of 18…", share: 2 / 18 });
  assert.deepEqual(progress({ ...run, done: 18 }, A).text, "Judging 18 of 18…");
  assert.equal(progress(run, B), null);
  assert.equal(progress({ ...run, running: false }, A), null);
  assert.equal(progress(null, A), null);
});

// --- The actor ----------------------------------------------------------------------

const READS = {
  projects: { current: A, projects: [] },
  cases: { cases: CASES, open: {} },
  rubrics: { rubrics: RUBRICS },
  decisions: { decisions: pickDecisions, run: null },
};

const start = async (reads = READS) => {
  const actor = createActor(machine, { input: { ask: (target) => Promise.resolve(reads[target]) } });
  const emitted = [];
  actor.on("*", (e) => emitted.push(e));
  actor.start();
  await waitFor(actor, (s) => !s.matches("loading"));
  return { actor, emitted };
};

test("a clicked miss opens its case; a case gone or of another project does not", async () => {
  const { actor, emitted } = await start();
  assert.ok(actor.getSnapshot().matches("ready"));
  actor.send({ type: "_open", id: id("C", 9) });
  actor.send({ type: "_open", id: id("C", 99) });
  assert.deepEqual(emitted, [{ type: "case.selected", id: id("C", 9), project: A }]);
  const { type, ...rest } = emitted[0];
  assert.ok(new Validator(SELECTED, "2020-12").validate(rest).valid);
});

test("it follows the facts' news after the starting picture", async () => {
  const { actor } = await start();
  const run = { project: A, cases: [], done: 0, running: true, error: null };
  actor.send({ type: "decision.changed", decisions: [...pickDecisions, ...yesnoDecisions], run });
  actor.send({ type: "project.changed", current: B, projects: [] });
  const { context: c } = actor.getSnapshot();
  assert.equal(c.current, B);
  assert.equal(c.run, run);
  assert.equal(c.decisions.length, 36);
});

test("a fact that cannot answer is an honest failure", async () => {
  const { actor } = await start({ ...READS, decisions: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
});
