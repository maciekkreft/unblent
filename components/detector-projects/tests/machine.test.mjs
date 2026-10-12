import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, subtitle, NEW_NAME } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(
  ["detector-project.selected", "detector-project.switched", "detector-project.saved"].map((n) => [n, schema(n)]),
);

const A = "01K7TEST000000000000000PA1";
const B = "01K7TEST000000000000000PB1";
const C = "01K7TEST000000000000000PC1";
const NEW = "01K7TEST000000000000000N01";
const project = (id, { on = true, removing = false, name = "Project" } = {}) => ({ id, name, on, version: 1, removing });
const detector = (n, p, { on = true, removing = false } = {}) => ({
  id: `01K7TEST0000000000000D${String(n).padStart(4, "0")}`, project: p, name: `D${n}`, on, removing, questions: [], version: 1,
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ projects = [project(A), project(B, { on: false }), project(C, { removing: true })], detectors = [], fail } = {}) => {
  const actor = createActor(machine, {
    input: { ask: () => Promise.resolve(fail ?? { projects, detectors, days: [], answers: [], open: null, reason: null }), mint: () => NEW },
  });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted };
};

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

test("the rows are the projects in order, without those being deleted", () => {
  assert.deepEqual(rows([project(A), project(C, { removing: true }), project(B)]).map((p) => p.id), [A, B]);
});

test("the line under a project counts its detectors' own ticks, whether the project is on or not", () => {
  const ds = [detector(1, A), detector(2, A, { on: false }), detector(3, A, { removing: true }), detector(4, B)];
  assert.equal(subtitle(project(A), ds), "1 of 2 on");
  assert.equal(subtitle(project(A, { on: false }), ds), "1 of 2 on");
  assert.equal(subtitle(project(C), ds), "0 of 0 on");
});

test("a pick of a shown project emits detector-project.selected; others are refused", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_pick", id: B });
  actor.send({ type: "_pick", id: C });
  actor.send({ type: "_pick", id: NEW });
  assert.deepEqual(emitted, [{ type: "detector-project.selected", id: B }]);
  assert.equal(actor.getSnapshot().context.open, B);
  valid(emitted);
});

test("a tick emits detector-project.switched only for a shown project whose state it changes", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_switch", id: A, on: false });
  actor.send({ type: "_switch", id: B, on: false });
  actor.send({ type: "_switch", id: C, on: false });
  actor.send({ type: "_switch", id: B, on: "yes" });
  assert.deepEqual(emitted, [{ type: "detector-project.switched", id: A, on: false }]);
  valid(emitted);
});

test("New project makes a project under a fresh id and opens it", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_new" });
  assert.deepEqual(emitted, [
    { type: "detector-project.saved", id: NEW, name: NEW_NAME },
    { type: "detector-project.selected", id: NEW },
  ]);
  assert.equal(actor.getSnapshot().context.open, NEW);
  valid(emitted);
});

test("journal.changed brings the projects and detectors the rows are drawn from", async () => {
  const { actor } = await start();
  actor.send({ type: "journal.changed", projects: [project(B)], detectors: [detector(1, B)] });
  const { projects, detectors } = actor.getSnapshot().context;
  assert.deepEqual(rows(projects).map((p) => [p.id, subtitle(p, detectors)]), [[B, "1 of 1 on"]]);
});

test("a fact that cannot answer is an honest failure", async () => {
  const { actor } = await start({ fail: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
});
