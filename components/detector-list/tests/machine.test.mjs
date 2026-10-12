import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, subtitle, hint, named } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(
  ["detector.selected", "detector.switched", "detector-project.saved", "removal.started"].map((n) => [n, schema(n)]),
);

const A = "01K7TEST000000000000000PA1";
const B = "01K7TEST000000000000000PB1";
const D1 = "01K7TEST000000000000000N01";
const D2 = "01K7TEST000000000000000N02";
const id = (n) => `01K7TEST0000000000000D${String(n).padStart(4, "0")}`;
const q = (n, removing = false) => ({ id: `01K7TEST0000000000000Q${String(n).padStart(4, "0")}`, removing });
const project = (pid, { on = true, removing = false, name = "Goals and values" } = {}) => ({ id: pid, name, on, version: 1, removing });
const detector = (n, p, { on = true, removing = false, questions = [q(1)] } = {}) => ({
  id: id(n), project: p, name: `Detector ${n}`, on, removing, questions, version: 1,
});
const PROJECTS = [project(A), project(B, { name: "Other" })];
const DETECTORS = [detector(1, A), detector(2, B), detector(3, A, { removing: true }), detector(4, A, { on: false })];

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ projects = PROJECTS, detectors = DETECTORS, project: stored = null, fail } = {}) => {
  const drafts = [D1, D2];
  const kept = [];
  const actor = createActor(machine, {
    input: {
      ask: () => Promise.resolve(fail ?? { projects, detectors, days: [], answers: [], open: null, reason: null }),
      mint: () => drafts.shift(),
      project: stored,
      remember: (pid) => kept.push(pid),
    },
  });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted, kept, ctx: () => actor.getSnapshot().context };
};

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

test("the rows are the project's detectors in order, without those being deleted", () => {
  assert.deepEqual(rows(DETECTORS, A).map((d) => d.id), [id(1), id(4)]);
  assert.deepEqual(rows(DETECTORS, B).map((d) => d.id), [id(2)]);
});

test("the line under a detector counts live questions and says off", () => {
  assert.equal(subtitle(detector(1, A, { questions: [q(1), q(2), q(3, true)] })), "2 questions");
  assert.equal(subtitle(detector(1, A, { on: false, questions: [q(1)] })), "1 question · off");
});

test("the line under the rows says an unticked project's detectors do not read, and keep their ticks", () => {
  assert.equal(hint(project(A)), "Ticked detectors read your writing.");
  assert.equal(
    hint(project(A, { on: false })),
    "This project is unticked, so none of its detectors read your writing; their own ticks are kept.",
  );
});

test("a project pick shows that project's detectors and is remembered on the device, even before the picture lands", async () => {
  let resolve;
  const kept = [];
  const actor = createActor(machine, {
    input: { ask: () => new Promise((r) => (resolve = r)), mint: () => D1, remember: (pid) => kept.push(pid) },
  });
  actor.start();
  actor.send({ type: "detector-project.selected", id: B });
  resolve({ projects: PROJECTS, detectors: DETECTORS });
  await flush();
  const c = actor.getSnapshot().context;
  assert.deepEqual(rows(c.detectors, c.project).map((d) => d.id), [id(2)]);
  assert.deepEqual(kept, [B]);
  assert.equal(c.picks, 1);
});

test("the project shown before a reload is shown again", async () => {
  const { ctx } = await start({ project: B });
  assert.equal(ctx().project, B);
  assert.equal(ctx().picks, 0, "a reload is not a pick, so a new project's name is not selected again");
});

test("a pick of a shown detector or New detector emits detector.selected with the project; others are refused", async () => {
  const { actor, emitted } = await start({ project: A });
  actor.send({ type: "_pick", id: id(1) });
  actor.send({ type: "_pick", id: D1 });
  actor.send({ type: "_pick", id: id(2) });
  actor.send({ type: "_pick", id: id(3) });
  assert.deepEqual(emitted, [
    { type: "detector.selected", id: id(1), project: A },
    { type: "detector.selected", id: D1, project: A },
  ]);
  valid(emitted);
});

test("a tick emits detector.switched for a shown detector whose state it changes", async () => {
  const { actor, emitted } = await start({ project: A });
  actor.send({ type: "_switch", id: id(4), on: true });
  actor.send({ type: "_switch", id: id(1), on: true });
  actor.send({ type: "_switch", id: id(2), on: false });
  assert.deepEqual(emitted, [{ type: "detector.switched", id: id(4), on: true }]);
  valid(emitted);
});

test("a rename is trimmed, a blank name keeps the old one, and an unchanged name sends nothing", async () => {
  const { actor, emitted } = await start({ project: A });
  actor.send({ type: "_rename", name: "  Goals  " });
  actor.send({ type: "_rename", name: "   " });
  actor.send({ type: "_rename", name: "Goals and values" });
  assert.deepEqual(emitted, [{ type: "detector-project.saved", id: A, name: "Goals" }]);
  assert.equal(named("", "Kept"), "Kept");
  valid(emitted);
});

test("Delete starts the project's removal, and a project already being deleted offers nothing", async () => {
  const { actor, emitted } = await start({ project: A });
  actor.send({ type: "_delete" });
  assert.deepEqual(emitted, [{ type: "removal.started", kind: "project", id: A, name: "Goals and values" }]);
  actor.send({ type: "journal.changed", projects: [project(A, { removing: true }), PROJECTS[1]], detectors: DETECTORS });
  actor.send({ type: "_delete" });
  actor.send({ type: "_rename", name: "Late" });
  actor.send({ type: "_pick", id: id(1) });
  assert.equal(emitted.length, 1);
  valid(emitted);
});

test("New detector gets a fresh id once the draft is saved as a detector", async () => {
  const { actor, ctx } = await start({ project: A });
  assert.equal(ctx().draft, D1);
  actor.send({ type: "journal.changed", projects: PROJECTS, detectors: [...DETECTORS, { ...detector(9, A), id: D1 }] });
  assert.equal(ctx().draft, D2);
});

test("a fact that cannot answer is an honest failure", async () => {
  const { actor } = await start({ fail: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
});
