import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, subtitle } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["rubric.selected", "rubric.switched"].map((n) => [n, schema(n)]));

const A = "01K6TEST000000000000000PA1";
const B = "01K6TEST000000000000000PB1";
const D1 = "01K6TEST000000000000000D01";
const D2 = "01K6TEST000000000000000D02";
const id = (n) => `01K6TEST0000000000000R${String(n).padStart(4, "0")}`;
const q = (n, removing = false) => ({ id: `01K6TEST0000000000000Q${String(n).padStart(4, "0")}`, removing });
const rubric = (n, project, { on = true, removing = false, questions = [q(1)], name = `Tool ${n}` } = {}) => ({
  id: id(n), project, name, on, removing, questions,
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ current = A, rubrics = [], fail } = {}) => {
  const replies = { projects: fail ?? { projects: [], current }, rubrics: { rubrics } };
  const drafts = [D1, D2];
  const actor = createActor(machine, { input: { ask: (target) => Promise.resolve(replies[target]), mint: () => drafts.shift() } });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  return { actor, emitted };
};

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

test("the rows are the current project's tools in order, without those being removed", () => {
  const all = [rubric(1, A), rubric(2, B), rubric(3, A, { removing: true }), rubric(4, A)];
  assert.deepEqual(rows(all, A).map((r) => r.id), [id(1), id(4)]);
  assert.deepEqual(rows(all, B).map((r) => r.id), [id(2)]);
});

test("the line under a name counts live questions and says off", () => {
  assert.equal(subtitle(rubric(1, A, { questions: [q(1), q(2), q(3, true)] })), "2 questions");
  assert.equal(subtitle(rubric(1, A, { questions: [q(1)] })), "1 question");
  assert.equal(subtitle(rubric(1, A, { on: false, questions: [] })), "0 questions · off");
});

test("a project switch shows that project's tools", async () => {
  const { actor } = await start({ rubrics: [rubric(1, A), rubric(2, B)] });
  const shown = () => rows(actor.getSnapshot().context.rubrics, actor.getSnapshot().context.current).map((r) => r.id);
  assert.deepEqual(shown(), [id(1)]);
  actor.send({ type: "project.changed", projects: [], current: B });
  assert.deepEqual(shown(), [id(2)]);
});

test("a pick of a shown tool or New tool emits rubric.selected; others are refused", async () => {
  const { actor, emitted } = await start({ rubrics: [rubric(1, A), rubric(2, B), rubric(3, A, { removing: true })] });
  actor.send({ type: "_pick", id: id(1) });
  actor.send({ type: "_pick", id: D1 });
  actor.send({ type: "_pick", id: id(2) });
  actor.send({ type: "_pick", id: id(3) });
  assert.deepEqual(emitted.map((e) => e.id), [id(1), D1]);
  assert.equal(actor.getSnapshot().context.open, D1);
  valid(emitted);
});

test("a tick emits rubric.switched for a shown tool whose state it changes", async () => {
  const { actor, emitted } = await start({ rubrics: [rubric(1, A), rubric(2, A, { on: false }), rubric(3, B)] });
  actor.send({ type: "_switch", id: id(2), on: true });
  actor.send({ type: "_switch", id: id(1), on: true });
  actor.send({ type: "_switch", id: id(3), on: false });
  assert.deepEqual(emitted, [{ type: "rubric.switched", id: id(2), on: true }]);
  valid(emitted);
});

test("New tool gets a fresh id once the draft is saved as a tool", async () => {
  const { actor } = await start({ rubrics: [] });
  assert.equal(actor.getSnapshot().context.draft, D1);
  actor.send({ type: "rubric.changed", rubrics: [{ ...rubric(1, A), id: D1 }] });
  assert.equal(actor.getSnapshot().context.draft, D2);
});

test("a fact that cannot answer is an honest failure", async () => {
  const { actor } = await start({ fail: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
});
