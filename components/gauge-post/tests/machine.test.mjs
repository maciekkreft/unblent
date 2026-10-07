import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, band, leaning, errorText, payload, readings, blocked } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const READ = JSON.parse(readFileSync(resolve(HERE, "..", "events", "gauge.read.json"), "utf8"));
// The decide query's schema lives with its answerer; read, never imported (11.2).
const DECIDE = JSON.parse(readFileSync(resolve(HERE, "..", "..", "llm", "queries", "decide.json"), "utf8"));
const valid = (schema, value) => {
  const result = new Validator(schema, "2020-12").validate(value);
  assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
};

const G = "01K6TEST000000000000000G00";
const H = "01K6TEST000000000000000G01";
const Q1 = "01K6TEST000000000000000Q01";
const Q2 = "01K6TEST000000000000000Q02";
const GAUGES = [
  {
    id: G,
    name: "Clarity",
    question: "Is it clear?",
    yes: "one point",
    no: "a guess",
    rule: "adds",
    questions: [
      { id: Q1, text: "One idea?", yes: "one", no: "many" },
      { id: Q2, text: "  ", yes: "", no: "" },
    ],
    reading: null,
  },
  { id: H, name: "Empty headline", question: "", rule: "adds", questions: [{ id: Q2, text: "Short?", yes: "", no: "" }], reading: null },
];

test("leaning words at the edges of each band", () => {
  assert.equal(leaning(0.8).word, "Yes");
  assert.equal(leaning(0.79).word, "Leans yes");
  assert.equal(leaning(0.6).word, "Leans yes");
  assert.equal(leaning(0.59).word, "Unsure");
  assert.equal(leaning(0.41).side, "unsure");
  assert.equal(leaning(0.4).word, "Leans no");
  assert.equal(leaning(0.21).word, "Leans no");
  assert.equal(leaning(0.2).word, "No");
  assert.equal(band(0.71), "high");
  assert.equal(band(0.4), "mixed");
  assert.equal(band(0.39), "low");
});

test("every error code has a sentence; an unknown one is unavailable", () => {
  assert.equal(errorText("no-key"), "Add your Jev key in Settings.");
  assert.equal(errorText("bad-key"), "Jev did not accept the key. Replace it in Settings.");
  assert.equal(errorText("rate-limited"), "Jev is rate-limiting; try again in a moment.");
  assert.equal(errorText("nonsense"), "Jev is unavailable.");
});

test("one payload carries every written question and headline, the post once", () => {
  const p = payload(GAUGES, "A post.");
  assert.deepEqual(p, {
    state: { post: "A post." },
    questions: [
      { id: `${G}/${Q1}`, instructions: "One idea?", yes: "one", no: "many" },
      { id: `${G}/direct`, instructions: "Is it clear?", yes: "one point", no: "a guess" },
      { id: `${H}/${Q2}`, instructions: "Short?", yes: "", no: "" },
    ],
  });
  valid(DECIDE.payload, p);
});

test("a main question without criteria is sent with them empty, which llm leaves out", () => {
  const [, direct] = payload([{ ...GAUGES[0], yes: undefined, no: undefined }], "A post.").questions;
  assert.deepEqual(direct, { id: `${G}/direct`, instructions: "Is it clear?", yes: "", no: "" });
});

test("the answers split back into one reading per gauge asked", () => {
  const r = readings([
    { id: `${G}/${Q1}`, p: 0.9 },
    { id: `${G}/direct`, p: 0.3 },
    { id: `${H}/${Q2}`, p: 0.5 },
  ]);
  assert.deepEqual(r, [
    { id: G, answers: [{ id: Q1, p: 0.9 }], direct: 0.3 },
    { id: H, answers: [{ id: Q2, p: 0.5 }], direct: null },
  ]);
  valid(READ, { readings: r });
});

test("Score is blocked with a reason until signed in, keyed and given a post", () => {
  const base = { signedIn: true, keySet: true, text: "post", gauges: GAUGES };
  assert.equal(blocked({ ...base, signedIn: false }), "Sign in to score.");
  assert.equal(blocked({ ...base, keySet: false }), "Add your Jev key in Settings.");
  assert.equal(blocked({ ...base, text: " " }), "Paste a post to score.");
  assert.equal(blocked({ ...base, gauges: [] }), "Add a question to a tool to score.");
  assert.equal(blocked(base), null);
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async (decide) => {
  const kept = [];
  const asks = [];
  const ask = (target, name, p) => {
    asks.push(`${target}: ${name}`);
    if (target === "gauge") return Promise.resolve({ gauges: GAUGES });
    if (name === "read") return Promise.resolve({ signedIn: true, jev: { keySet: true } });
    return decide(p);
  };
  const actor = createActor(machine, { input: { ask, recall: () => "Kept post", remember: (t) => kept.push(t) } });
  const emitted = [];
  actor.on("gauge.read", (e) => emitted.push(e));
  actor.start();
  await flush();
  await flush();
  return { actor, emitted, kept, asks };
};

test("a Score asks once, announces the readings and keeps the counts", async () => {
  const { actor, emitted, asks } = await start(() =>
    Promise.resolve({ answers: [{ id: `${G}/${Q1}`, p: 0.9 }, { id: `${G}/direct`, p: 0.3 }, { id: `${H}/${Q2}`, p: 0.5 }], inputTokens: 300, ms: 310 }),
  );
  assert.equal(actor.getSnapshot().context.text, "Kept post", "the post comes back from the device");
  actor.send({ type: "_score" });
  assert.ok(actor.getSnapshot().matches("scoring"));
  await flush();
  assert.deepEqual(asks.filter((a) => a === "llm: decide"), ["llm: decide"]);
  assert.equal(emitted.length, 1);
  assert.deepEqual(actor.getSnapshot().context.last, { tools: 2, questions: 3, ms: 310, inputTokens: 300 });
});

test("a refused Score keeps its error until the next edit, which is kept on the device", async () => {
  const { actor, emitted, kept } = await start(() => Promise.resolve({ error: "rate-limited" }));
  actor.send({ type: "_score" });
  await flush();
  assert.ok(actor.getSnapshot().matches("failed"));
  assert.equal(actor.getSnapshot().context.error, "rate-limited");
  assert.equal(emitted.length, 0);
  actor.send({ type: "_type", text: "Another post" });
  assert.ok(actor.getSnapshot().matches("ready"));
  assert.equal(actor.getSnapshot().context.error, null);
  assert.deepEqual(kept, ["Another post"]);
});

test("llm.changed decides whether Score can run", async () => {
  const { actor } = await start(() => Promise.resolve({ error: "busy" }));
  actor.send({ type: "llm.changed", signedIn: true, jev: { keySet: false } });
  assert.equal(blocked(actor.getSnapshot().context), "Add your Jev key in Settings.");
  actor.send({ type: "_score" });
  assert.ok(actor.getSnapshot().matches("ready"), "a blocked Score does nothing");
});
