import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, parse, GOALS, REPLIES, DISTORTION, SEED_VERSION } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Schemas are read, never imported (11.2); the gestures' schemas live with their emitters.
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "project.changed.json");
const READ = json("queries", "read.json").reply;
const SAVED = json("..", "project-bar", "events", "project.saved.json");
const SELECTED = json("..", "project-bar", "events", "project.selected.json");
const STARTED = json("..", "project-bar", "events", "removal.started.json");
const UNDONE = json("..", "notice-stack", "events", "removal.undone.json");
const SETTLED = json("..", "notice-stack", "events", "removal.settled.json");
const recorded = [];

const C = "01K6TEST00000000000000PJ0C";

const start = (stored = null) => {
  const saved = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v) } });
  const emitted = [];
  actor.on("project.changed", (e) => {
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
  return { actor, saved, emitted, send, read };
};
const names = ({ projects }) => projects.map((p) => p.name);
const save = (s, id, name) => s.send({ type: "project.saved", id, name }, SAVED);
const remove = (s, id) => s.send({ type: "removal.started", kind: "project", id, name: "" }, STARTED);
const undo = (s, id) => s.send({ type: "removal.undone", kind: "project", id }, UNDONE);
const settle = (s, id) => s.send({ type: "removal.settled", kind: "project", id }, SETTLED);
const select = (s, id) => s.send({ type: "project.selected", id }, SELECTED);

test("a first visit starts with the three example projects, Goals and values current", () => {
  for (const stored of [null, "", "not json", '{"version":1,"projects":[]}']) {
    const s = start(stored);
    assert.deepEqual(s.read(), {
      projects: [
        { id: GOALS, name: "Goals and values", removing: false },
        { id: REPLIES, name: "Replies", removing: false },
        { id: DISTORTION, name: "Cognitive Distortion", removing: false },
      ],
      current: GOALS,
    });
    assert.equal(s.saved.length, 0, "loading writes nothing");
  }
});

test("a new project is added at the end, becomes current, and is stored in the envelope", () => {
  const s = start();
  save(s, C, "Tone");
  assert.deepEqual(names(s.read()), ["Goals and values", "Replies", "Cognitive Distortion", "Tone"]);
  assert.equal(s.read().current, C);
  assert.deepEqual(s.emitted.at(-1), { type: "project.changed", ...s.read() });
  const written = JSON.parse(s.saved.at(-1));
  assert.equal(written.version, SEED_VERSION);
  assert.deepEqual(parse(s.saved.at(-1)), s.read(), "a reload reads back what was written");
});

test("a rename keeps the project's place and the current project", () => {
  const s = start();
  save(s, REPLIES, "Answers");
  assert.deepEqual(names(s.read()), ["Goals and values", "Answers", "Cognitive Distortion"]);
  assert.equal(s.read().current, GOALS);
  save(s, REPLIES, "Answers");
  assert.equal(s.emitted.length, 1, "a repeat announces nothing");
});

test("picking a project makes it current; an unknown id changes nothing", () => {
  const s = start();
  select(s, REPLIES);
  assert.equal(s.read().current, REPLIES);
  select(s, C);
  assert.equal(s.read().current, REPLIES);
  assert.equal(s.emitted.length, 1);
});

test("removing waits for the undo window: Undo restores it and makes it current again", () => {
  const s = start();
  remove(s, GOALS);
  let r = s.read();
  assert.deepEqual(r.projects.map((p) => p.removing), [true, false, false], "it still exists while it waits");
  assert.equal(r.current, REPLIES, "the first project's neighbour is the next one");
  undo(s, GOALS);
  r = s.read();
  assert.deepEqual(r.projects.map((p) => p.removing), [false, false, false]);
  assert.equal(r.current, GOALS);
});

test("Undo of a project that was not current leaves the current one alone", () => {
  const s = start();
  remove(s, REPLIES);
  assert.equal(s.read().current, GOALS);
  undo(s, REPLIES);
  assert.equal(s.read().current, GOALS);
  assert.equal(s.read().projects[1].removing, false);
});

test("the neighbour before a removed current project takes over", () => {
  const s = start();
  save(s, C, "Tone");
  remove(s, C);
  assert.equal(s.read().current, DISTORTION);
  settle(s, C);
  assert.deepEqual(names(s.read()), ["Goals and values", "Replies", "Cognitive Distortion"]);
  assert.equal(s.read().current, DISTORTION);
});

test("a settled removal is purged; settling what is not being removed changes nothing", () => {
  const s = start();
  settle(s, REPLIES);
  assert.equal(s.emitted.length, 0);
  remove(s, REPLIES);
  settle(s, REPLIES);
  assert.deepEqual(names(s.read()), ["Goals and values", "Cognitive Distortion"]);
  undo(s, REPLIES);
  assert.deepEqual(names(s.read()), ["Goals and values", "Cognitive Distortion"], "Undo after it settled brings nothing back");
});

test("the last project that is not being removed cannot be removed", () => {
  const s = start();
  remove(s, DISTORTION);
  settle(s, DISTORTION);
  remove(s, GOALS);
  const before = s.emitted.length;
  remove(s, REPLIES);
  assert.equal(s.emitted.length, before, "ignored, nothing announced");
  assert.equal(s.read().current, REPLIES);
  assert.equal(s.read().projects[1].removing, false);
  settle(s, GOALS);
  remove(s, REPLIES);
  assert.deepEqual(names(s.read()), ["Replies"]);
  assert.equal(s.read().projects[0].removing, false);
});

test("a removal of another kind is not this fact's", () => {
  const s = start();
  s.send({ type: "removal.started", kind: "case", id: GOALS, name: "" }, STARTED);
  assert.equal(s.emitted.length, 0);
});

test("at load a leftover removing flag is settled, and current moves off it", () => {
  const stored = JSON.stringify({
    version: SEED_VERSION,
    projects: [
      { id: GOALS, name: "Goals and values", removing: true },
      { id: REPLIES, name: "Replies", removing: false },
    ],
    current: GOALS,
  });
  const s = start(stored);
  assert.deepEqual(s.read(), { projects: [{ id: REPLIES, name: "Replies", removing: false }], current: REPLIES });
});

test("a list from an older version gains only the newer examples, once, and keeps its current project", () => {
  const older = (projects) => JSON.stringify({ version: 1, projects, current: C });
  const tone = { id: C, name: "Tone", removing: false };
  let s = start(older([tone]));
  assert.deepEqual(names(s.read()), ["Tone", "Cognitive Distortion"], "the deleted version-1 examples stay deleted");
  assert.equal(s.read().current, C);
  assert.equal(s.saved.length, 0, "loading writes nothing");

  s = start(older([tone, { id: DISTORTION, name: "Distortions", removing: false }]));
  assert.deepEqual(names(s.read()), ["Tone", "Distortions"], "the browser it was written in gains no copy");

  s = start(JSON.stringify({ version: SEED_VERSION, projects: [tone], current: C }));
  assert.deepEqual(names(s.read()), ["Tone"], "deleted after it arrived, it is not brought back");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
