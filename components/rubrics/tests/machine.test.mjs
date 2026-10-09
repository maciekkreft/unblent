import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, parse, SEED, SEED_VERSION, IDS, catchUp } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Schemas are read, never imported (11.2); the gestures' schemas live with their emitters.
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "rubric.changed.json");
const READ = json("queries", "read.json").reply;
const SAVED = json("..", "rubric-editor", "events", "rubric.saved.json");
const SWITCHED = json("..", "rubric-list", "events", "rubric.switched.json");
const STARTED = json("..", "rubric-editor", "events", "removal.started.json");
const UNDONE = json("..", "notice-stack", "events", "removal.undone.json");
const SETTLED = json("..", "notice-stack", "events", "removal.settled.json");
const PROJECTS = json("..", "projects", "events", "project.changed.json");
const recorded = [];

const GOALS = "01K6SEED00000000000000PJ01";
const REPLIES = "01K6SEED00000000000000PJ02";
const T = "01K6TEST00000000000000RB0T";
const Q1 = "01K6TEST00000000000000RQ01";
const Q2 = "01K6TEST00000000000000RQ02";
const Q3 = "01K6TEST00000000000000RQ03";
const O1 = "01K6TEST00000000000000RC01";
const O2 = "01K6TEST00000000000000RC02";
const O3 = "01K6TEST00000000000000RC03";

const start = (stored = null, ask) => {
  const saved = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v), ask } });
  const emitted = [];
  actor.on("rubric.changed", (e) => {
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
const tool = (s, id) => s.read().rubrics.find((r) => r.id === id);
const opt = (id, name) => ({ id, name, description: "" });
const yn = (id, text) => ({ id, kind: "yesno", text, yes: "", no: "", options: [] });
const pick = (id, text, options) => ({ id, kind: "pick", text, yes: "", no: "", options });
const save = (s, questions, name = "Tone", project = GOALS) =>
  s.send({ type: "rubric.saved", id: T, project, name, questions }, SAVED);
const remove = (s, kind, id) => s.send({ type: "removal.started", kind, id, name: "" }, STARTED);
const undo = (s, kind, id) => s.send({ type: "removal.undone", kind, id }, UNDONE);
const settle = (s, kind, id) => s.send({ type: "removal.settled", kind, id }, SETTLED);
const projects = (s, list) =>
  s.send({ type: "project.changed", projects: list.map((id) => ({ id, name: "", removing: false })), current: list[0] }, PROJECTS);

test("a first visit starts with the example tools, only Goal or value and Replyability on", () => {
  for (const stored of [null, "", "not json", '{"version":1}']) {
    const s = start(stored);
    const { rubrics } = s.read();
    assert.deepEqual(rubrics.map((r) => [r.project === GOALS ? "G" : "R", r.name, r.on]), [
      ["G", "Goal or value", true],
      ["G", "Goal or value (yes / no)", false],
      ["R", "Replyability", true],
      ["R", "Viewability", false],
      ["R", "Followability", false],
      ["R", "Shareability", false],
      ["R", "Likeability", false],
      ["R", "Saveability", false],
    ]);
    assert.equal(s.saved.length, 0, "loading writes nothing");
  }
});

test("the seed: fixed unique ids, pick questions with two or more uniquely named options", () => {
  const ids = SEED.flatMap((r) => [r.id, ...r.questions.flatMap((q) => [q.id, ...q.options.map((o) => o.id)])]);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of SEED) {
    assert.ok(r.questions.length > 0);
    for (const q of r.questions) {
      if (q.kind !== "pick") continue;
      assert.ok(q.options.length >= 2, `${q.text} has two or more options`);
      assert.equal(new Set(q.options.map((o) => o.name)).size, q.options.length, `${q.text}: unique names`);
    }
  }
  const gv = SEED.find((r) => r.id === IDS.goalOrValue);
  assert.deepEqual(gv.questions[0].options.map((o) => [o.id, o.name]), [
    [IDS.goal, "Goal"],
    [IDS.value, "Value"],
    [IDS.other, "Other"],
  ]);
  const yesno = SEED.find((r) => r.id === IDS.goalOrValueYesNo);
  assert.deepEqual(yesno.questions.map((q) => [q.id, q.kind, q.text]), [
    [IDS.isGoal, "yesno", "Is this a goal?"],
    [IDS.isValue, "yesno", "Is this a value?"],
  ]);
  assert.ok(yesno.questions.every((q) => q.yes && q.no));
  const replies = SEED.filter((r) => r.project === REPLIES);
  assert.equal(replies.length, 6);
  for (const r of replies) {
    assert.equal(r.questions.length, 5, `${r.name}: the headline then four questions`);
    assert.ok(r.questions.every((q) => q.kind === "yesno" && q.text && q.yes && q.no));
  }
  assert.equal(replies[0].questions[0].text, "Does this post give someone a reason to reply to it?");
});

test("a new tool is added at the end, switched on, and stored in the envelope", () => {
  const s = start();
  save(s, [yn(Q1, "Is it kind?")]);
  const t = tool(s, T);
  assert.deepEqual(t, { id: T, project: GOALS, name: "Tone", on: true, removing: false, questions: [{ ...yn(Q1, "Is it kind?"), removing: false }] });
  assert.equal(s.read().rubrics.at(-1).id, T);
  assert.deepEqual(s.emitted.at(-1), { type: "rubric.changed", ...s.read() });
  assert.equal(JSON.parse(s.saved.at(-1)).version, SEED_VERSION);
  assert.deepEqual(parse(s.saved.at(-1)), s.read().rubrics, "a reload reads back what was written");
});

test("a save upserts in place and keeps on/off; a repeat stores and announces nothing", () => {
  const s = start();
  save(s, [yn(Q1, "Is it kind?")]);
  s.send({ type: "rubric.switched", id: T, on: false }, SWITCHED);
  save(s, [pick(Q1, "Which tone?", [opt(O1, "Warm"), opt(O2, "Cold")]), yn(Q2, "Is it short?")], "Tone 2");
  const t = tool(s, T);
  assert.equal(t.name, "Tone 2");
  assert.equal(t.on, false, "a save does not switch a tool back on");
  assert.deepEqual(t.questions.map((q) => [q.id, q.kind]), [[Q1, "pick"], [Q2, "yesno"]]);
  assert.equal(s.read().rubrics.filter((r) => r.id === T).length, 1);
  const n = s.emitted.length;
  save(s, [pick(Q1, "Which tone?", [opt(O1, "Warm"), opt(O2, "Cold")]), yn(Q2, "Is it short?")], "Tone 2");
  assert.equal(s.emitted.length, n);
  assert.equal(s.saved.length, n);
});

test("switching sets only on/off; a repeat changes nothing", () => {
  const s = start();
  s.send({ type: "rubric.switched", id: IDS.goalOrValueYesNo, on: true }, SWITCHED);
  assert.equal(tool(s, IDS.goalOrValueYesNo).on, true);
  assert.deepEqual({ ...tool(s, IDS.goalOrValueYesNo), on: false }, SEED.find((r) => r.id === IDS.goalOrValueYesNo));
  s.send({ type: "rubric.switched", id: IDS.goalOrValueYesNo, on: true }, SWITCHED);
  assert.equal(s.emitted.length, 1);
});

test("a save never drops a question or an option still in its undo window", () => {
  const s = start();
  save(s, [yn(Q1, "A?"), pick(Q2, "B?", [opt(O1, "x"), opt(O2, "y"), opt(O3, "z")]), yn(Q3, "C?")]);
  remove(s, "question", Q1);
  remove(s, "option", O2);
  // The editor writes what it shows as kept: the flagged items are left out, and C? is edited.
  save(s, [pick(Q2, "B?", [opt(O1, "x"), opt(O3, "z")]), yn(Q3, "C, edited?")]);
  let t = tool(s, T);
  assert.deepEqual(t.questions.map((q) => [q.id, q.removing]), [[Q1, true], [Q2, false], [Q3, false]]);
  assert.deepEqual(t.questions[1].options.map((o) => [o.id, o.removing]), [[O1, false], [O2, true], [O3, false]]);
  assert.equal(t.questions[2].text, "C, edited?");
  // A save that carries a flagged item keeps it flagged.
  save(s, [yn(Q1, "A, edited?"), pick(Q2, "B?", [opt(O1, "x"), opt(O2, "y"), opt(O3, "z")]), yn(Q3, "C, edited?")]);
  t = tool(s, T);
  assert.deepEqual(t.questions.map((q) => q.removing), [true, false, false]);
  assert.equal(t.questions[0].text, "A, edited?");
  assert.equal(t.questions[1].options[1].removing, true);
});

test("removing a tool, a question or an option: undo unflags it, settle purges it", () => {
  for (const [kind, id, find] of [
    ["rubric", T, (s) => tool(s, T)],
    ["question", Q1, (s) => tool(s, T)?.questions.find((q) => q.id === Q1)],
    ["option", O1, (s) => tool(s, T)?.questions.find((q) => q.id === Q1)?.options.find((o) => o.id === O1)],
  ]) {
    const s = start();
    save(s, [pick(Q1, "Which?", [opt(O1, "x"), opt(O2, "y")])]);
    remove(s, kind, id);
    assert.equal(find(s).removing, true, `${kind} is flagged`);
    undo(s, kind, id);
    assert.equal(find(s).removing, false, `${kind} is back`);
    const n = s.emitted.length;
    settle(s, kind, id);
    assert.equal(s.emitted.length, n, `settling an undone ${kind} changes nothing`);
    remove(s, kind, id);
    settle(s, kind, id);
    assert.equal(find(s), undefined, `${kind} is gone`);
    undo(s, kind, id);
    assert.equal(find(s), undefined, `Undo after the ${kind} settled brings nothing back`);
  }
});

test("a removal of another kind is not this fact's", () => {
  const s = start();
  remove(s, "case", IDS.goalOrValue);
  remove(s, "project", IDS.goalOrValue);
  assert.equal(s.emitted.length, 0);
});

test("at load every leftover removing flag is settled", () => {
  const stored = JSON.stringify({
    version: SEED_VERSION,
    rubrics: [
      { id: T, project: GOALS, name: "Gone", on: true, removing: true, questions: [] },
      {
        id: IDS.goalOrValue, project: GOALS, name: "Kept", on: true, removing: false,
        questions: [
          { ...yn(Q1, "Gone?"), removing: true },
          { ...pick(Q2, "Kept?", [{ ...opt(O1, "gone"), removing: true }, { ...opt(O2, "kept"), removing: false }]), removing: false },
        ],
      },
    ],
  });
  const s = start(stored);
  assert.deepEqual(s.read().rubrics.map((r) => r.name), ["Kept"]);
  assert.deepEqual(s.read().rubrics[0].questions.map((q) => q.id), [Q2]);
  assert.deepEqual(s.read().rubrics[0].questions[0].options.map((o) => o.id), [O2]);
});

test("an empty stored list stays empty; an older version only gains what is new", () => {
  assert.deepEqual(start(JSON.stringify({ version: SEED_VERSION, rubrics: [] })).read().rubrics, []);
  assert.deepEqual(catchUp([], SEED_VERSION), []);
  assert.equal(catchUp([], 0).length, SEED.length);
  const mine = [{ ...SEED[0], name: "Mine" }];
  assert.deepEqual(catchUp(mine, 0).map((r) => r.name).slice(0, 2), ["Mine", "Goal or value (yes / no)"]);
});

test("a tool whose project is gone is dropped; a project being removed keeps its tools", () => {
  const s = start();
  s.send({ type: "project.changed", projects: [
    { id: GOALS, name: "", removing: false },
    { id: REPLIES, name: "", removing: true },
  ], current: GOALS }, PROJECTS);
  assert.equal(s.emitted.length, 0, "every project still exists");
  projects(s, [GOALS]);
  assert.deepEqual(s.read().rubrics.map((r) => r.project), [GOALS, GOALS]);
  assert.equal(JSON.parse(s.saved.at(-1)).rubrics.length, 2, "and the drop is saved");
  assert.deepEqual(s.emitted.at(-1), { type: "rubric.changed", ...s.read() });
});

test("at start the projects read drops the tools of a project that is gone", async () => {
  const asked = [];
  const s = start(null, async (target, name, payload) => {
    asked.push([target, name, payload]);
    return { projects: [{ id: REPLIES, name: "Replies", removing: false }], current: REPLIES };
  });
  await new Promise((r) => setTimeout(r));
  assert.deepEqual(asked, [["projects", "read", {}]]);
  assert.ok(s.read().rubrics.every((r) => r.project === REPLIES));
  assert.equal(s.read().rubrics.length, 6);
  assert.equal(s.emitted.length, 1);
  assert.equal(JSON.parse(s.saved.at(-1)).rubrics.length, 6);
});

test("a start read that fails, or keeps every project, changes nothing", async () => {
  for (const reply of [{ error: "no-answerer" }, { projects: [{ id: GOALS, name: "", removing: false }, { id: REPLIES, name: "", removing: false }], current: GOALS }]) {
    const s = start(null, async () => reply);
    await new Promise((r) => setTimeout(r));
    assert.equal(s.read().rubrics.length, SEED.length);
    assert.equal(s.emitted.length, 0);
    assert.equal(s.saved.length, 0);
  }
  const s = start(null, async () => {
    throw new Error("down");
  });
  await new Promise((r) => setTimeout(r));
  assert.equal(s.emitted.length, 0);
  save(s, [yn(Q1, "Still works?")]);
  assert.ok(tool(s, T), "the fact is ready after a failed read");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
  for (const schema of [CHANGED, READ]) assert.ok(new Validator(schema, "2020-12").validate({ rubrics: structuredClone(SEED) }).valid);
});
