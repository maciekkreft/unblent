import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): the journal with its partner decisions, and decisions' own partner llm,
// real machines on the real bus. The journal's other facts are faked through its ask,
// and llm's server through its inputs, so nothing reaches typesafe.ai.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

const id = (tag, n) => `01K6TEST0000000000000${tag}${String(n).padStart(4, "0")}`;
const P = id("P", 1);
const PICK = id("Q", 1);
const [GOAL, VALUE] = [1, 2].map((n) => id("N", n));
const RUBRIC = {
  id: id("R", 1),
  project: P,
  name: "Goal or value",
  on: true,
  removing: false,
  questions: [
    {
      id: PICK, kind: "pick", text: "Goal or value?", yes: "", no: "", removing: false,
      options: [{ id: GOAL, name: "Goal", description: "", removing: false }, { id: VALUE, name: "Value", description: "", removing: false }],
    },
  ],
};
const CASE = { id: id("C", 1), project: P, text: "To win the race. Playing fairly.", answers: {}, removing: false };
const PICTURE = {
  signedIn: true,
  provider: "echo",
  providers: [{ id: "echo", label: "Echo", keySet: true, needsKey: false }],
  model: "echo",
  models: [{ id: "echo", label: "Echo" }],
  effort: "default",
  efforts: ["default"],
  ttl: "1h",
  jev: { keySet: true },
};

test("the journal's finished pieces are judged one at a time, and each answer comes back by its text", async () => {
  const sent = [];
  const replies = {
    projects: { projects: [], current: P },
    cases: { cases: [CASE], open: { [P]: CASE.id } },
    rubrics: { rubrics: [RUBRIC] },
    decisions: { decisions: [], run: null },
    llm: PICTURE,
  };
  const { actors, unwire } = await wire(["llm", "decisions", "case-journal"], {
    llm: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: true }),
      read: () => Promise.resolve(PICTURE),
      save: () => Promise.resolve(PICTURE),
      stream: () => () => {},
      decide: async (payload) => {
        sent.push(payload.state.text);
        await new Promise((r) => setTimeout(r, 5));
        const choice = payload.state.text.startsWith("To") ? GOAL : VALUE;
        return { answers: [{ id: payload.questions[0].id, p: 0.8, choice, probabilities: [{ id: choice, p: 0.8 }], confidence: 0.6 }], inputTokens: 10, ms: 5 };
      },
    },
    decisions: { stored: null, save: () => {}, now: () => 42 },
    "case-journal": { ask: (target) => Promise.resolve(replies[target]), mint: () => id("D", 1), throttleMs: 20 },
  });
  try {
    await until(() => actors.llm.getSnapshot().context.picture.signedIn);
    // decisions keeps an answer while its tool and a case holding its text are known; the
    // facts that announce them are not mounted, so their news is sent as they would.
    actors.decisions.send({ type: "rubric.changed", rubrics: [RUBRIC] });
    actors.decisions.send({ type: "case.changed", cases: [CASE], open: { [P]: CASE.id } });
    // Opening asked before llm was signed in; a blur asks again, as the user would.
    actors["case-journal"].send({ type: "_blur" });
    const journal = () => actors["case-journal"].getSnapshot().context.passages;
    await until(() => journal().answers.length === 2 && journal().waiting.length === 0);
    assert.deepEqual(sent, ["To win the race.", "Playing fairly."]);
    assert.deepEqual(
      journal().answers.map((a) => [a.text, a.answers[0].choice]),
      [["To win the race.", GOAL], ["Playing fairly.", VALUE]],
    );
    // A blur with nothing new asks Jev nothing.
    actors["case-journal"].send({ type: "_blur" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sent.length, 2);
  } finally {
    unwire();
  }
});
