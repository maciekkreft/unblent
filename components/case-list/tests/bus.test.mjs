import { test } from "node:test";
import assert from "node:assert/strict";
import { rows, onTools, firstLine, answersLine, verdict } from "../machine.js";

// The kit (10): the list and its four facts, real machines on the real bus. Jev is
// decisions' own input, faked here: it picks the right option for every seed case but
// two, the misses the Results tab shows.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const fact = () => ({ stored: null, save: () => {} });
const MISSES = { "To be warm, friendly, outgoing, supportive and genuine.": "Goal", "What time does the train leave?": "Value" };

test("the seed cases list with their right answers, and Judge all marks 16 right and 2 wrong", async () => {
  // The right pick by case text, from the seed groups: the first six goals, then six values.
  let calls = 0;
  const decide = async (payload) => {
    calls += 1;
    const n = calls - 1;
    const right = n < 6 ? "Goal" : n < 12 ? "Value" : "Other";
    const name = MISSES[payload.state.text] ?? right;
    return {
      answers: payload.questions.map((q) => {
        const o = q.options.find((x) => x.name === name);
        return { id: q.id, p: 0.9, choice: o.id, probabilities: q.options.map((x) => ({ id: x.id, p: x === o ? 0.9 : 0.05 })), confidence: 0.8 };
      }),
      inputTokens: 10,
      ms: 1,
    };
  };
  const { actors, unwire } = await wire(["projects", "rubrics", "cases", "decisions", "case-list"], {
    projects: fact(),
    rubrics: fact(),
    cases: fact(),
    decisions: { ...fact(), now: () => 1, ask: (target, name, payload) => decide(payload) },
    "case-list": { mint: () => "01K6TEST000000000000000D01" },
  });
  try {
    const list = actors["case-list"];
    const ctx = () => list.getSnapshot().context;
    await until(() => list.getSnapshot().matches("ready"));
    const shown = () => rows(ctx().cases, ctx().current);
    const tools = () => onTools(ctx().rubrics, ctx().current);
    assert.equal(shown().length, 18);
    assert.equal(firstLine(shown()[0].text), "To have a big house.");
    assert.equal(answersLine(shown()[0], tools()), "Right answer: Goal");

    list.send({ type: "_judge" });
    await until(() => ctx().run && !ctx().run.running, 2000);
    assert.equal(ctx().run.error, null);
    assert.equal(calls, 18);
    const marks = shown().map((c) => verdict(c, tools(), ctx().decisions));
    assert.equal(marks.filter((m) => m === true).length, 16);
    assert.deepEqual(
      shown().filter((c, i) => marks[i] === false).map((c) => c.text),
      Object.keys(MISSES),
    );
  } finally {
    unwire();
  }
});
