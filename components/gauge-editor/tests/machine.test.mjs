import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, isEmpty } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", name), "utf8"));
const SCHEMAS = { "gauge.saved": json("gauge.saved.json"), "gauge.discarded": json("gauge.discarded.json") };
const recorded = [];

const G = "01K6TEST000000000000000G00";
const Q1 = "01K6TEST000000000000000Q01";
const Q2 = "01K6TEST000000000000000Q02";
const NEW = "01K6TEST000000000000000N01";
const GAUGE = {
  id: G,
  name: "Clarity",
  question: "Is it clear?",
  yes: "one point",
  no: "a guess",
  rule: "adds",
  questions: [
    { id: Q1, text: "One idea?", yes: "one", no: "many", label: "One idea" },
    { id: Q2, text: "Short?", yes: "", no: "" },
  ],
  reading: { at: 1, answers: [], direct: null, score: null, band: null },
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async (gauges = [GAUGE]) => {
  let n = 0;
  const clock = new SimulatedClock();
  const actor = createActor(machine, {
    clock,
    input: {
      ask: () => Promise.resolve({ gauges }),
      mint: () => `01K6TEST000000000000000M${String(++n).padStart(2, "0")}`,
      undoMs: 3000,
      throttleMs: 200,
    },
  });
  const emitted = [];
  for (const name of Object.keys(SCHEMAS))
    actor.on(name, (e) => {
      emitted.push(e);
      recorded.push({ value: e, schema: SCHEMAS[name] });
    });
  actor.start();
  await flush();
  return { actor, clock, emitted, ctx: () => actor.getSnapshot().context };
};

test("nothing picked shows the idle page; a pick opens the gauge as a draft without its reading", async () => {
  const { actor, ctx } = await start();
  assert.ok(actor.getSnapshot().matches("idle"));
  actor.send({ type: "gauge.selected", id: G });
  assert.ok(actor.getSnapshot().matches("editing"));
  assert.equal(ctx().draft.name, "Clarity");
  assert.equal("reading" in ctx().draft, false);
});

test("a pick that arrives before the starting picture opens once it lands", async () => {
  let release;
  const actor = createActor(machine, {
    input: { ask: () => new Promise((r) => (release = r)), mint: () => NEW, undoMs: 10, throttleMs: 10 },
  }).start();
  actor.send({ type: "gauge.selected", id: G });
  release({ gauges: [GAUGE] });
  await flush();
  assert.equal(actor.getSnapshot().context.draft.name, "Clarity");
});

test("typing saves the whole gauge at the throttle, not per keystroke; blur saves at once", async () => {
  const { actor, clock, emitted } = await start();
  actor.send({ type: "gauge.selected", id: G });
  actor.send({ type: "_edit", patch: { name: "C" } });
  actor.send({ type: "_edit", patch: { name: "Cl" } });
  clock.increment(100);
  actor.send({ type: "_editQuestion", id: Q1, patch: { yes: "just one" } });
  assert.equal(emitted.length, 0);
  clock.increment(100);
  assert.equal(emitted.length, 1, "one save at the end of the window");
  assert.equal(emitted[0].name, "Cl");
  assert.equal(emitted[0].questions[0].yes, "just one");
  assert.equal(emitted[0].questions[0].label, "One idea");
  actor.send({ type: "_edit", patch: { rule: "holds" } });
  actor.send({ type: "_blur" });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].rule, "holds");
  assert.equal(emitted[1].yes, "one point", "the main question's criteria ride every save");
  actor.send({ type: "_edit", patch: { no: "the reader has to guess" } });
  actor.send({ type: "_blur" });
  assert.equal(emitted[2].no, "the reader has to guess");
});

test("a New tool is a blank draft that is not saved until something is written", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "gauge.selected", id: NEW });
  assert.equal(ctx().draft.questions.length, 1);
  assert.equal(ctx().draft.yes, "");
  assert.equal(ctx().draft.no, "");
  assert.ok(isEmpty(ctx().draft));
  actor.send({ type: "_edit", patch: { name: "" } });
  clock.increment(300);
  assert.equal(emitted.length, 0);
  actor.send({ type: "_edit", patch: { name: "Warmth" } });
  clock.increment(300);
  assert.equal(emitted.at(-1).id, NEW);
  assert.equal(emitted.at(-1).name, "Warmth");
});

test("Remove waits out the undo window; Undo keeps the question", async () => {
  const { actor, clock, emitted, ctx } = await start();
  actor.send({ type: "gauge.selected", id: G });
  actor.send({ type: "_removeQuestion", id: Q2 });
  assert.ok(ctx().removing.has(Q2));
  actor.send({ type: "_undoRemove", id: Q2 });
  clock.increment(3000);
  assert.equal(ctx().draft.questions.length, 2);
  assert.equal(emitted.length, 0);
  actor.send({ type: "_removeQuestion", id: Q2 });
  clock.increment(3000);
  assert.deepEqual(ctx().draft.questions.map((q) => q.id), [Q1]);
  assert.deepEqual(emitted.at(-1).questions.map((q) => q.id), [Q1]);
});

test("Delete waits out the undo window, then discards and shows the deleted page", async () => {
  const { actor, clock, emitted } = await start();
  actor.send({ type: "gauge.selected", id: G });
  actor.send({ type: "_delete" });
  actor.send({ type: "_undoDelete" });
  clock.increment(3000);
  assert.equal(emitted.length, 0);
  actor.send({ type: "_delete" });
  clock.increment(3000);
  assert.deepEqual(emitted.at(-1), { type: "gauge.discarded", id: G });
  assert.ok(actor.getSnapshot().matches("deleted"));
});

test("moving to another gauge settles the one left: removals dropped and saved; a delete still lands", async () => {
  const OTHER = { ...GAUGE, id: "01K6TEST000000000000000G01", name: "Other" };
  const { actor, clock, emitted, ctx } = await start([GAUGE, OTHER]);
  actor.send({ type: "gauge.selected", id: G });
  actor.send({ type: "_removeQuestion", id: Q2 });
  actor.send({ type: "gauge.selected", id: OTHER.id });
  assert.deepEqual(emitted.at(-1).questions.map((q) => q.id), [Q1]);
  assert.equal(ctx().draft.name, "Other");
  actor.send({ type: "_delete" });
  actor.send({ type: "gauge.selected", id: G });
  clock.increment(3000);
  assert.deepEqual(emitted.at(-1), { type: "gauge.discarded", id: OTHER.id });
  assert.ok(actor.getSnapshot().matches("editing"), "the editor stays on the gauge picked meanwhile");
});

test("another tab's change reaches the draft only while nothing typed is waiting", async () => {
  const { actor, ctx } = await start();
  actor.send({ type: "gauge.selected", id: G });
  actor.send({ type: "gauge.changed", gauges: [{ ...GAUGE, name: "From elsewhere" }] });
  assert.equal(ctx().draft.name, "From elsewhere");
  actor.send({ type: "_edit", patch: { name: "Mine" } });
  actor.send({ type: "gauge.changed", gauges: [{ ...GAUGE, name: "Again" }] });
  assert.equal(ctx().draft.name, "Mine");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0);
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
