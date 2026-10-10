import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";

// The kit (10): decisions with its one partner, llm, real machines on the real bus.
// llm's server is faked through its inputs, answering in the shape of a reply Jev
// really sent (llm's fixtures/jev-pick.json), so nothing reaches typesafe.ai.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const RECORDED = read("../../llm/tests/fixtures/jev-pick.json");
const DECIDE = read("../../llm/queries/decide.json");

const PICTURE = {
  provider: "echo",
  providers: [{ id: "echo", label: "Echo", keySet: true, needsKey: false }],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: ["default"],
  ttl: "1h",
  jev: { keySet: true },
};

const P = "01K6TEST00000000000000PJ01";
const R1 = "01K6TEST00000000000000RB01";
const R2 = "01K6TEST00000000000000RB02";
const PICK = "01K6TEST00000000000000RQ01";
const YN = "01K6TEST00000000000000RQ02";
const OPTIONS = [
  { id: "01K6TEST00000000000000RC01", name: "Goal", description: "Something you can finish." },
  { id: "01K6TEST00000000000000RC02", name: "Value", description: "A way of acting that never ends." },
  { id: "01K6TEST00000000000000RC03", name: "Other", description: "" },
];
const CASES = ["To win the race.", "Playing fairly.", "It rained.", "To get good marks."].map((text, i) => ({
  id: `01K6TEST00000000000000CS0${i + 1}`,
  text,
}));
const RUBRICS = [
  { id: R1, name: "Goal or value", questions: [{ id: PICK, kind: "pick", text: "Goal, value or other?", yes: "", no: "", options: OPTIONS }] },
  { id: R2, name: "Goal", questions: [{ id: YN, kind: "yesno", text: "Is it a goal?", yes: "It ends", no: "", options: [] }] },
];

// What llm's server module answers, built from the recorded reply: Jev names an option,
// and the server maps the name back to the asker's option id.
const reply = (payload) => ({
  answers: payload.questions.map((q) => {
    if (q.kind !== "pick") return { id: q.id, p: 0.75 };
    const jev = RECORDED.answers.kind;
    const byName = Object.fromEntries(q.options.map((o) => [o.name, o.id]));
    return {
      id: q.id,
      p: jev.probabilities[jev.choice],
      choice: byName[jev.choice],
      probabilities: Object.entries(jev.probabilities).map(([name, p]) => ({ id: byName[name], p })),
      confidence: jev.confidence,
    };
  }),
  inputTokens: RECORDED.usage.input_tokens,
  ms: 30,
});

test("Judge all asks llm one case at a time, never busy, with a payload decide accepts", async () => {
  const sent = [];
  let open = 0;
  let most = 0;
  const { actors, records, unwire } = await wire(["llm", "decisions"], {
    llm: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: true }),
      read: () => Promise.resolve(PICTURE),
      save: () => Promise.resolve(PICTURE),
      stream: () => () => {},
      decide: async (payload) => {
        sent.push(payload);
        most = Math.max(most, ++open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        return reply(payload);
      },
    },
    decisions: { stored: null, save: () => {}, now: () => 42 },
  });
  try {
    await until(() => actors.llm.getSnapshot().context.picture.signedIn);
    actors.decisions.send({ type: "judging.requested", project: P, cases: CASES, rubrics: RUBRICS });
    await until(() => actors.decisions.getSnapshot().context.run?.running === false);
    const { run, decisions } = actors.decisions.getSnapshot().context;
    assert.deepEqual(run, { project: P, cases: CASES.map((c) => c.id), done: 4, running: false, error: null });
    assert.equal(most, 1, "never two requests open at once");
    assert.deepEqual(sent.map((p) => p.state.text), CASES.map((c) => c.text), "in order");
    const validate = new Validator(DECIDE.payload, "2020-12");
    for (const p of sent) assert.ok(validate.validate(p).valid, JSON.stringify(p));
    assert.ok(!records.some((r) => JSON.stringify(r).includes('"busy"')), "llm never answered busy");
    assert.equal(decisions.length, 8, "a decision per case and tool");
    const picked = decisions.find((d) => d.rubric === R1).answers[0];
    assert.equal(picked.choice, OPTIONS[0].id);
    assert.equal(picked.p, 1);
    assert.equal(picked.probabilities.length, 3);
  } finally {
    unwire();
  }
});

test("pieces and a run share llm: never two decides open, the run first once a piece is answered", async () => {
  const sent = [];
  let open = 0;
  let most = 0;
  const { actors, records, unwire } = await wire(["llm", "decisions"], {
    llm: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: true }),
      read: () => Promise.resolve(PICTURE),
      save: () => Promise.resolve(PICTURE),
      stream: () => () => {},
      decide: async (payload) => {
        sent.push(payload.state.text);
        most = Math.max(most, ++open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        return reply(payload);
      },
    },
    decisions: { stored: null, save: () => {}, now: () => 42 },
  });
  try {
    await until(() => actors.llm.getSnapshot().context.picture.signedIn);
    actors.decisions.send({ type: "passages.requested", project: P, rubrics: RUBRICS, passages: ["I fail.", "It rained."] });
    actors.decisions.send({ type: "judging.requested", project: P, cases: CASES.slice(0, 2), rubrics: RUBRICS });
    await until(() => {
      const c = actors.decisions.getSnapshot().context;
      return c.run?.running === false && c.queue.length === 0 && !c.asking;
    });
    assert.equal(most, 1, "never two requests open at once");
    assert.deepEqual(sent, ["I fail.", CASES[0].text, CASES[1].text, "It rained."]);
    assert.ok(!records.some((r) => JSON.stringify(r).includes('"busy"')), "llm never answered busy");
    assert.equal(actors.decisions.getSnapshot().context.passages.length, 4, "an answer per piece and tool");
  } finally {
    unwire();
  }
});
