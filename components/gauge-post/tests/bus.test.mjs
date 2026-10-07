import { test } from "node:test";
import assert from "node:assert/strict";

// The kit (10): gauge-post with its three partners, gauge, llm and scorings, real
// machines on the real bus. llm's server is faked through its inputs, so nothing reaches Jev.
assert.ok(process.env.UNBLENT_KIT, "UNBLENT_KIT must be set (checks/check.py sets it)");
const { wire, until } = await import(process.env.UNBLENT_KIT);

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

test("a Score goes through llm: decide in one request and comes back as readings on every card", async () => {
  const sent = [];
  let kept = null;
  const { actors, unwire } = await wire(["gauge", "llm", "scorings", "gauge-post"], {
    gauge: { stored: null, save: () => {}, now: () => 42 },
    scorings: { stored: null, save: (v) => (kept = v) },
    "gauge-post": {
      recall: () => "A post about a practice I return to every week.",
      remember: () => {},
      mint: () => "01K6TEST000000000000000S01",
      now: () => 43,
    },
    llm: {
      session: () => Promise.resolve({ userId: "u1", registrationOpen: true }),
      read: () => Promise.resolve(PICTURE),
      save: () => Promise.resolve(PICTURE),
      stream: () => () => {},
      decide: (payload) => {
        sent.push(payload);
        const answers = payload.questions.map((q, i) => ({ id: q.id, p: (i % 5) / 4 }));
        return Promise.resolve({ answers, inputTokens: 900, ms: 310 });
      },
    },
  });
  try {
    const post = actors["gauge-post"];
    // The facts are mounted first, as a page loads them; llm holds the read until its picture lands.
    await until(() => post.getSnapshot().matches("ready") && post.getSnapshot().context.keySet);
    post.send({ type: "_score" });
    await until(() => post.getSnapshot().context.last != null);
    assert.equal(sent.length, 1, "one request for every tool");
    assert.equal(sent[0].questions.length, 25, "five tools of four questions and a headline each");
    assert.deepEqual(post.getSnapshot().context.last, { tools: 5, questions: 25, ms: 310, inputTokens: 900 });
    const gauges = post.getSnapshot().context.gauges;
    assert.ok(gauges.every((g) => g.reading && g.reading.at === 42 && g.reading.band), "every card has a banded reading");
    await until(() => kept != null);
    const [scoring] = JSON.parse(kept);
    assert.equal(scoring.id, "01K6TEST000000000000000S01");
    assert.equal(scoring.at, 43);
    assert.equal(scoring.gauges.length, 5, "the scoring landed in scorings with every tool");
    assert.ok(scoring.gauges.every((g) => g.direct === 1 && g.label && g.questions.length === 4));
  } finally {
    unwire();
  }
});
