import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, parse, SEED, SEED_VERSION, catchUp } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Schemas are read, never imported (11.2); the gestures' schemas live with their emitters.
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "case.changed.json");
const READ = json("queries", "read.json").reply;
const SAVED = json("..", "case-editor", "events", "case.saved.json");
const SELECTED = json("..", "case-list", "events", "case.selected.json");
const STARTED = json("..", "case-editor", "events", "removal.started.json");
const UNDONE = json("..", "notice-stack", "events", "removal.undone.json");
const SETTLED = json("..", "notice-stack", "events", "removal.settled.json");
const PROJECTS = json("..", "projects", "events", "project.changed.json");
const recorded = [];

const GOALS = "01K6SEED00000000000000PJ01";
const REPLIES = "01K6SEED00000000000000PJ02";
const PICK = "01K6SEED00000000000000RQ01";
const GOAL = "01K6SEED00000000000000RC01";
const VALUE = "01K6SEED00000000000000RC02";
const OTHER = "01K6SEED00000000000000RC03";
const IS_GOAL = "01K6SEED00000000000000RQ02";
const IS_VALUE = "01K6SEED00000000000000RQ03";
const REPLYABLE = "01K6SEED00000000000000G6QH";
const cs = (n) => `01K6SEED00000000000000CS${String(n).padStart(2, "0")}`;
const C = "01K6TEST00000000000000CS0C";
const D = "01K6TEST00000000000000CS0D";
const Q = "01K6TEST00000000000000RQ0Q";
const tick = () => new Promise((r) => setTimeout(r));

const start = (stored = null, ask) => {
  const saved = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v), ask } });
  const emitted = [];
  actor.on("case.changed", (e) => {
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
  return { saved, emitted, send, read };
};
const find = (s, id) => s.read().cases.find((c) => c.id === id);
const inProject = (s, project) => s.read().cases.filter((c) => c.project === project).map((c) => c.id);
const save = (s, id, text, answers = {}, project = GOALS) => s.send({ type: "case.saved", id, project, text, answers }, SAVED);
const select = (s, id, project = GOALS) => s.send({ type: "case.selected", id, project }, SELECTED);
const remove = (s, id, kind = "case") => s.send({ type: "removal.started", kind, id, name: "" }, STARTED);
const undo = (s, id) => s.send({ type: "removal.undone", kind: "case", id }, UNDONE);
const settle = (s, id) => s.send({ type: "removal.settled", kind: "case", id }, SETTLED);
const projects = (s, list) =>
  s.send({ type: "project.changed", projects: list.map((id) => ({ id, name: "", removing: false })), current: list[0] }, PROJECTS);

test("a first visit starts with 18 goals-and-values cases and 4 replies cases, the first of each open", () => {
  for (const stored of [null, "", "not json", '{"version":1}']) {
    const s = start(stored);
    const { cases, open } = s.read();
    assert.equal(cases.length, 22);
    assert.deepEqual(cases.map((c) => c.id), Array.from({ length: 22 }, (_, i) => cs(i + 1)));
    assert.deepEqual(open, { [GOALS]: cs(1), [REPLIES]: cs(19) });
    assert.ok(cases.every((c) => !c.removing));
    assert.equal(s.saved.length, 0, "loading writes nothing");
  }
});

test("the seed answers name only real seeded questions and options", () => {
  const goals = SEED.cases.filter((c) => c.project === GOALS);
  assert.deepEqual(goals.map((c) => c.text).slice(0, 2), ["To have a big house.", "To win the match."]);
  assert.equal(goals[17].text, "The book has 312 pages.");
  const groups = [[GOAL, "yes", "no"], [VALUE, "no", "yes"], [OTHER, "no", "no"]];
  goals.forEach((c, i) => {
    const [pick, isGoal, isValue] = groups[Math.floor(i / 6)];
    assert.deepEqual(c.answers, { [PICK]: pick, [IS_GOAL]: isGoal, [IS_VALUE]: isValue }, c.text);
  });
  const replies = SEED.cases.filter((c) => c.project === REPLIES);
  assert.deepEqual(replies.map((c) => [c.text.slice(0, 20), c.answers]), [
    ["What is one tool you", { [REPLYABLE]: "yes" }],
    ["Our office is closed", { [REPLYABLE]: "no" }],
    ["Hot take: no meeting", { [REPLYABLE]: "yes" }],
    ["Here is the full lis", { [REPLYABLE]: "no" }],
  ]);
  // The ids the rubrics seed holds, literally (11.2): RQ01 is pick with RC01-03, RQ02-03 and G6QH yes / no.
  const pickOptions = new Set([GOAL, VALUE, OTHER]);
  const yesno = new Set([IS_GOAL, IS_VALUE, REPLYABLE]);
  for (const c of SEED.cases)
    for (const [q, v] of Object.entries(c.answers))
      assert.ok(q === PICK ? pickOptions.has(v) : yesno.has(q) && (v === "yes" || v === "no"), `${c.text}: ${q}=${v}`);
});

test("a new case goes first in its project and is stored in the envelope", () => {
  const s = start();
  save(s, C, "To climb a mountain.", { [PICK]: GOAL });
  assert.deepEqual(find(s, C), { id: C, project: GOALS, text: "To climb a mountain.", answers: { [PICK]: GOAL }, removing: false });
  assert.equal(inProject(s, GOALS)[0], C);
  assert.deepEqual(s.emitted.at(-1), { type: "case.changed", ...s.read() });
  assert.equal(JSON.parse(s.saved.at(-1)).version, SEED_VERSION);
  assert.deepEqual(parse(s.saved.at(-1)), s.read(), "a reload reads back what was written");
});

test("a save upserts the whole case in place; a repeat stores and announces nothing", () => {
  const s = start();
  save(s, cs(2), "To win the cup.", { [PICK]: GOAL, [Q]: "yes" });
  assert.deepEqual(find(s, cs(2)).answers, { [PICK]: GOAL, [Q]: "yes" }, "an answer to an unknown question is kept");
  assert.equal(s.read().cases[1].id, cs(2), "it keeps its place");
  assert.equal(s.read().cases.length, 22);
  save(s, cs(2), "To win the cup.", {});
  assert.deepEqual(find(s, cs(2)).answers, {}, "the whole case is replaced");
  const n = s.emitted.length;
  save(s, cs(2), "To win the cup.", {});
  assert.equal(s.emitted.length, n);
  assert.equal(s.saved.length, n);
});

test("selecting opens a case, or a new one not saved yet, in its project", () => {
  const s = start();
  select(s, cs(5));
  assert.equal(s.read().open[GOALS], cs(5));
  select(s, C);
  assert.deepEqual(s.read().open, { [GOALS]: C, [REPLIES]: cs(19) });
  const n = s.emitted.length;
  select(s, C);
  select(s, cs(19), GOALS);
  assert.equal(s.emitted.length, n, "a repeat, or a case of another project, changes nothing");
});

test("removing the open case opens its neighbour; Undo reopens it; settle purges it", () => {
  const s = start();
  select(s, cs(3));
  remove(s, cs(3));
  assert.equal(find(s, cs(3)).removing, true);
  assert.equal(s.read().open[GOALS], cs(2), "the case before it is open");
  undo(s, cs(3));
  assert.equal(find(s, cs(3)).removing, false);
  assert.equal(s.read().open[GOALS], cs(3), "Undo reopens it");
  const n = s.emitted.length;
  settle(s, cs(3));
  assert.equal(s.emitted.length, n, "settling an undone case changes nothing");

  remove(s, cs(1));
  assert.equal(s.read().open[GOALS], cs(3), "a case that was not open leaves the open one alone");
  undo(s, cs(1));
  assert.equal(s.read().open[GOALS], cs(3), "and Undo does not open it");

  select(s, cs(1));
  remove(s, cs(1));
  assert.equal(s.read().open[GOALS], cs(2), "the first case passes to the one after it");
  settle(s, cs(1));
  assert.equal(find(s, cs(1)), undefined);
  undo(s, cs(1));
  assert.equal(find(s, cs(1)), undefined, "Undo after the settle brings nothing back");
  assert.equal(s.read().open[GOALS], cs(2));
});

test("removing the last case of a project leaves it with no open case", () => {
  const s = start();
  for (const n of [19, 20, 21]) {
    remove(s, cs(n));
    settle(s, cs(n));
  }
  assert.equal(s.read().open[REPLIES], cs(22));
  remove(s, cs(22));
  assert.equal(REPLIES in s.read().open, false);
  undo(s, cs(22));
  assert.equal(s.read().open[REPLIES], cs(22));
});

test("a removal of another kind is not this fact's", () => {
  const s = start();
  remove(s, cs(1), "rubric");
  remove(s, cs(1), "project");
  assert.equal(s.emitted.length, 0);
});

test("at load every leftover removing flag is settled, and the open case moves off it", () => {
  const stored = JSON.stringify({
    version: SEED_VERSION,
    cases: [
      { id: C, project: GOALS, text: "kept", answers: {}, removing: false },
      { id: D, project: GOALS, text: "gone", answers: {}, removing: true },
      { id: cs(19), project: REPLIES, text: "gone too", answers: {}, removing: true },
    ],
    open: { [GOALS]: D, [REPLIES]: cs(19) },
  });
  const s = start(stored);
  assert.deepEqual(s.read(), {
    cases: [{ id: C, project: GOALS, text: "kept", answers: {}, removing: false }],
    open: { [GOALS]: C },
  });
});

test("an empty stored list stays empty; an older version only gains what is new", () => {
  assert.deepEqual(start(JSON.stringify({ version: SEED_VERSION, cases: [], open: {} })).read(), { cases: [], open: {} });
  assert.deepEqual(catchUp([], SEED_VERSION), []);
  assert.equal(catchUp([], 0).length, SEED.cases.length);
});

test("a case whose project is gone is dropped with its open entry; a project being removed keeps its cases", () => {
  const s = start();
  s.send({ type: "project.changed", projects: [
    { id: GOALS, name: "", removing: false },
    { id: REPLIES, name: "", removing: true },
  ], current: GOALS }, PROJECTS);
  assert.equal(s.emitted.length, 0, "every project still exists");
  projects(s, [GOALS]);
  assert.equal(s.read().cases.length, 18);
  assert.deepEqual(s.read().open, { [GOALS]: cs(1) });
  assert.equal(JSON.parse(s.saved.at(-1)).cases.length, 18, "and the drop is saved");
});

test("at start the projects read drops the cases of a project that is gone", async () => {
  const asked = [];
  const s = start(null, async (target, name, payload) => {
    asked.push([target, name, payload]);
    return { projects: [{ id: REPLIES, name: "Replies", removing: false }], current: REPLIES };
  });
  await tick();
  assert.deepEqual(asked, [["projects", "read", {}]]);
  assert.deepEqual(inProject(s, REPLIES), [cs(19), cs(20), cs(21), cs(22)]);
  assert.equal(s.read().cases.length, 4);
  assert.deepEqual(s.read().open, { [REPLIES]: cs(19) });
  assert.equal(s.emitted.length, 1);
});

test("a start read that fails, or keeps every project, changes nothing", async () => {
  const both = { projects: [{ id: GOALS, name: "", removing: false }, { id: REPLIES, name: "", removing: false }], current: GOALS };
  for (const ask of [async () => ({ error: "no-answerer" }), async () => both, async () => { throw new Error("down"); }]) {
    const s = start(null, ask);
    await tick();
    assert.equal(s.read().cases.length, 22);
    assert.equal(s.emitted.length, 0);
    assert.equal(s.saved.length, 0);
    select(s, cs(4));
    assert.equal(s.read().open[GOALS], cs(4), "the fact is ready after the read");
  }
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
  for (const schema of [CHANGED, READ]) assert.ok(new Validator(schema, "2020-12").validate(structuredClone(SEED)).valid);
});
