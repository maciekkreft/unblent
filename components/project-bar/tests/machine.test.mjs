import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, summary, named, shown, canDelete } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["project.selected", "project.saved", "removal.started"].map((n) => [n, schema(n)]));

const A = "01K6TEST000000000000000PA1";
const B = "01K6TEST000000000000000PB1";
const C = "01K6TEST000000000000000PC1";
const N = "01K6TEST000000000000000NEW";
const project = (id, name, removing = false) => ({ id, name, removing });
const rubric = (n, p, removing = false) => ({ id: `01K6TEST0000000000000R${String(n).padStart(4, "0")}`, project: p, removing });
const kase = (n, p, removing = false) => ({ id: `01K6TEST0000000000000C${String(n).padStart(4, "0")}`, project: p, removing });

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ projects = [project(A, "Goals and values"), project(B, "Replies")], current = A, rubrics = [], cases = [], fail } = {}) => {
  const replies = {
    projects: fail ?? { projects, current },
    rubrics: { rubrics },
    cases: { cases, open: {} },
  };
  const actor = createActor(machine, { input: { ask: (target) => Promise.resolve(replies[target]), mint: () => N } });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted };
};

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

test("the counts leave out tools and cases being removed, and say one or many", () => {
  const rubrics = [rubric(1, A), rubric(2, A), rubric(3, A, true), rubric(4, B)];
  const cases = [kase(1, A), kase(2, A, true), kase(3, B), kase(4, B)];
  assert.equal(summary(A, rubrics, cases), "2 tools · 1 case");
  assert.equal(summary(B, rubrics, cases), "1 tool · 2 cases");
  assert.equal(summary(C, rubrics, cases), "0 tools · 0 cases");
});

test("a project being removed is hidden and does not count toward Delete", () => {
  const projects = [project(A, "Goals"), project(B, "Replies", true)];
  assert.deepEqual(shown(projects).map((p) => p.id), [A]);
  assert.equal(canDelete(projects), false);
  assert.equal(canDelete([project(A, "Goals"), project(B, "Replies")]), true);
});

test("an empty or blank name falls back, and a name is trimmed", () => {
  assert.equal(named("", "Old"), "Old");
  assert.equal(named("   ", "Old"), "Old");
  assert.equal(named("  Values  ", "Old"), "Values");
});

test("the starting picture and later changes fill the counts", async () => {
  const { actor } = await start({ rubrics: [rubric(1, A)], cases: [kase(1, A)] });
  assert.ok(actor.getSnapshot().matches("ready"));
  let { rubrics, cases } = actor.getSnapshot().context;
  assert.equal(summary(A, rubrics, cases), "1 tool · 1 case");
  actor.send({ type: "rubric.changed", rubrics: [rubric(1, A), rubric(2, A)] });
  actor.send({ type: "case.changed", cases: [], open: {} });
  ({ rubrics, cases } = actor.getSnapshot().context);
  assert.equal(summary(A, rubrics, cases), "2 tools · 0 cases");
  actor.send({ type: "project.changed", projects: [project(A, "Goals"), project(B, "Replies")], current: B });
  assert.equal(actor.getSnapshot().context.current, B);
});

test("picking another project announces it; the current or a hidden one does nothing", async () => {
  const { actor, emitted } = await start({ projects: [project(A, "Goals"), project(B, "Replies"), project(C, "Gone", true)] });
  actor.send({ type: "_pick", id: A });
  actor.send({ type: "_pick", id: C });
  actor.send({ type: "_pick", id: B });
  assert.deepEqual(emitted, [{ type: "project.selected", id: B }]);
  valid(emitted);
});

test("New project is named New project under a fresh id", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_new" });
  assert.deepEqual(emitted, [{ type: "project.saved", id: N, name: "New project" }]);
  valid(emitted);
});

test("a rename saves the trimmed name, and a blank or unchanged one sends nothing", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_rename", name: "   " });
  actor.send({ type: "_rename", name: "Goals and values" });
  actor.send({ type: "_rename", name: "  Values  " });
  assert.deepEqual(emitted, [{ type: "project.saved", id: A, name: "Values" }]);
  valid(emitted);
});

test("a blank rename of an unnamed project gives it the new-project name", async () => {
  const { actor, emitted } = await start({ projects: [project(A, ""), project(B, "Replies")] });
  actor.send({ type: "_rename", name: "" });
  assert.deepEqual(emitted, [{ type: "project.saved", id: A, name: "New project" }]);
});

test("Delete starts the removal of the current project, but never the last one", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_delete" });
  assert.deepEqual(emitted, [{ type: "removal.started", kind: "project", id: A, name: "Goals and values" }]);
  valid(emitted);
  actor.send({ type: "project.changed", projects: [project(A, "Goals and values", true), project(B, "Replies")], current: B });
  actor.send({ type: "_delete" });
  assert.equal(emitted.length, 1, "only one project is left");
});

test("projects that cannot answer leave the bar failed", async () => {
  const { actor, emitted } = await start({ fail: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
  actor.send({ type: "_new" });
  assert.deepEqual(emitted, []);
});
