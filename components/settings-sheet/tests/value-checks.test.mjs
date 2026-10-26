import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, valueChecksShown } from "../machine.js";

// The values checks rows: asked from `value-checks: read`, followed through
// value-checks.changed, and each select emitting value-checks.edited with both lines.
const edited = new Validator(JSON.parse(readFileSync(new URL("../events/value-checks.edited.json", import.meta.url), "utf8")), "2020-12");

const E1 = "01HZZZZZZZZZZZZZZZZZZZZZE1";
const E2 = "01HZZZZZZZZZZZZZZZZZZZZZE2";
const BOOK = "01HZZZZZZZZZZZZZZZZZZZZB00";
const EVALUATORS = [
  { id: E1, book: BOOK, name: "Is it a value?", on: true, questions: [], version: 1 },
  { id: E2, book: BOOK, name: "Does the example fit?", on: true, questions: [], version: 1 },
];
const LLM = { signedIn: true, provider: "echo", providers: [], model: "", models: [], effort: "default", efforts: [], ttl: "1h", jev: { keySet: true } };

function start({ valueChecks = { keySet: true, settings: { values: null, examples: null }, values: [] } } = {}) {
  const asked = [];
  const ask = (target, name, payload) => {
    asked.push(`${target}: ${name}`);
    const replies = {
      pages: { pages: [] },
      settings: { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: {} },
      llm: LLM,
      "value-checks": valueChecks,
      evaluators: { evaluators: EVALUATORS },
      flags: { hidden: [] },
    };
    return Promise.resolve(replies[target] ?? { error: "no-answerer" });
  };
  const actor = createActor(machine, { input: { ask, current: "/", account: true, undoMs: 3000 } });
  const emitted = [];
  actor.on("value-checks.edited", (e) => {
    const { type, ...payload } = e;
    assert.ok(edited.validate(payload).valid, JSON.stringify(e));
    emitted.push(payload);
  });
  return new Promise((resolve) => {
    actor.subscribe((s) => {
      if (s.matches("ready")) resolve({ actor, emitted, asked, context: () => actor.getSnapshot().context });
    });
    actor.start();
  });
}

test("the settings are asked, and the evaluators listed even without choice point checks", async () => {
  const { context, asked } = await start({ valueChecks: { keySet: true, settings: { values: E1, examples: null }, values: [] } });
  assert.ok(asked.includes("value-checks: read"));
  assert.deepEqual(context().valueChecks, { values: E1, examples: null });
  assert.deepEqual(context().evaluators.map((e) => e.id), [E1, E2]);
});

test("a page without value-checks keeps the part hidden", async () => {
  const { context } = await start({ valueChecks: { error: "no-answerer" } });
  assert.equal(context().valueChecks, null);
});

test("each select emits both lines with its own changed, only when it differs, and the change is adopted", async () => {
  const { actor, emitted, context } = await start();
  actor.send({ type: "_setValueChecker", line: "values", evaluator: E1 });
  assert.deepEqual(emitted, [{ values: E1, examples: null }]);
  assert.deepEqual(context().valueChecks, { values: null, examples: null }, "nothing is assigned until the fact says so");
  actor.send({ type: "value-checks.changed", settings: { values: E1, examples: null } });
  actor.send({ type: "_setValueChecker", line: "values", evaluator: E1 });
  assert.equal(emitted.length, 1, "the same evaluator again emits nothing");
  actor.send({ type: "_setValueChecker", line: "examples", evaluator: E2 });
  actor.send({ type: "_setValueChecker", line: "values", evaluator: "" });
  assert.deepEqual(emitted.slice(1), [
    { values: E1, examples: E2 },
    { values: null, examples: null },
  ]);
  actor.send({ type: "values.checked", day: "2026-10-26", values: [] });
  assert.ok(actor.getSnapshot().matches("ready"), "values.checked changes nothing");
});

test("the part shows only once a Jev key is saved, on a page with value-checks, while flags shows evaluators", () => {
  const valueChecks = { values: null, examples: null };
  const llm = { jev: { keySet: true } };
  assert.equal(valueChecksShown({ valueChecks, hidden: [], llm }), true);
  assert.equal(valueChecksShown({ valueChecks, hidden: [], llm: { jev: { keySet: false } } }), false, "no Jev key");
  assert.equal(valueChecksShown({ valueChecks, hidden: [], llm: null }), false, "signed out");
  assert.equal(valueChecksShown({ valueChecks: null, hidden: [], llm }), false, "no value-checks on the page");
  assert.equal(valueChecksShown({ valueChecks, hidden: null, llm }), false, "flags has not answered");
  assert.equal(valueChecksShown({ valueChecks, hidden: ["evaluators"], llm }), false);
});
