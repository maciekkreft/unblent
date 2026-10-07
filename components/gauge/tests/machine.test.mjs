import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, normalise, score, band, parse, SEED } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "gauge.changed.json");
const READ = json("queries", "read.json").reply;
// The gestures' schemas live with their emitters; read, never imported (11.2).
const SAVED = JSON.parse(readFileSync(resolve(HERE, "..", "..", "gauge-editor", "events", "gauge.saved.json"), "utf8"));
const GREAD = JSON.parse(readFileSync(resolve(HERE, "..", "..", "gauge-post", "events", "gauge.read.json"), "utf8"));
const recorded = [];

const G = "01K6TEST000000000000000G00";
const Q1 = "01K6TEST000000000000000Q01";
const Q2 = "01K6TEST000000000000000Q02";
const GAUGE = {
  id: G,
  name: "Clarity",
  question: "Is it clear?",
  yes: "one point, plainly made",
  no: "the reader has to guess",
  rule: "adds",
  questions: [
    { id: Q1, text: "One idea?", yes: "one", no: "many" },
    { id: Q2, text: "Short?", yes: "", no: "", label: "Short" },
  ],
};

const start = (stored = "[]", at = 1000) => {
  const saved = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v), now: () => at } });
  const emitted = [];
  actor.on("gauge.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.start();
  return { actor, saved, emitted };
};
const send = (actor, event, schema) => {
  recorded.push({ value: event, schema });
  actor.send(event);
};
const read = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  recorded.push({ value: reply, schema: READ });
  return reply;
};
const gauges = (actor) => read(actor).gauges;

test("score: adds is the average, holds the geometric mean, none is null", () => {
  assert.equal(score("adds", [{ p: 0.2 }, { p: 0.8 }]), 0.5);
  assert.ok(Math.abs(score("holds", [{ p: 0.2 }, { p: 0.8 }]) - 0.4) < 1e-9);
  assert.ok(score("holds", [{ p: 0 }, { p: 1 }]) < 0.01, "a zero sinks a holds gauge without breaking it");
  assert.equal(score("adds", []), null);
});

test("band: high above 0.7, mixed from 0.4, low below", () => {
  assert.equal(band(0.71), "high");
  assert.equal(band(0.7), "mixed");
  assert.equal(band(0.4), "mixed");
  assert.equal(band(0.39), "low");
  assert.equal(band(null), null);
});

test("normalise keeps the contract shape and drops what does not fit", () => {
  assert.equal(normalise({ id: "nope" }), null);
  const g = normalise({ id: G, name: 3, rule: "odd", questions: [{ id: Q1, text: "x" }, { id: "bad", text: "y" }, null] });
  assert.deepEqual(g, { id: G, name: "", question: "", yes: "", no: "", rule: "adds", questions: [{ id: Q1, text: "x", yes: "", no: "" }], reading: null });
});

test("nothing stored, or garbage, is the seed; an empty list stays empty", () => {
  assert.equal(parse(null).length, 4);
  assert.deepEqual(parse("not json").map((g) => g.name), ["Followability", "Shareability", "Likeability", "Saveability"]);
  assert.deepEqual(parse("[]"), []);
  for (const g of SEED) {
    assert.equal(g.questions.length, 4);
    assert.ok(g.questions.every((q) => q.label && q.yes && q.no));
    assert.ok(g.yes && g.no, `${g.name} carries criteria for its main question`);
  }
  assert.equal(gauges(start(null).actor).length, 4);
});

test("a save is stored and announced once; a repeat does nothing", () => {
  const { actor, saved, emitted } = start();
  send(actor, { type: "gauge.saved", ...GAUGE }, SAVED);
  send(actor, { type: "gauge.saved", ...GAUGE }, SAVED);
  assert.equal(emitted.length, 1);
  assert.deepEqual(gauges(actor), [{ ...GAUGE, reading: null }]);
  assert.deepEqual(gauges(start(saved.at(-1)).actor), [{ ...GAUGE, reading: null }], "what was stored is what a reload reads");
});

test("the main question's criteria are kept as written; a stored list without them reads them as empty", () => {
  const { actor } = start(JSON.stringify([{ ...GAUGE, yes: undefined, no: undefined }]));
  assert.equal(gauges(actor)[0].yes, "");
  send(actor, { type: "gauge.saved", ...GAUGE }, SAVED);
  assert.equal(gauges(actor)[0].yes, "one point, plainly made");
  assert.equal(gauges(actor)[0].no, "the reader has to guess");
});

test("a reading is kept, scored and banded; unknown answers and gauges are dropped", () => {
  const { actor } = start(JSON.stringify([GAUGE]), 5000);
  send(
    actor,
    {
      type: "gauge.read",
      readings: [
        { id: G, answers: [{ id: Q1, p: 0.9 }, { id: Q2, p: 0.7 }, { id: "01K6TEST000000000000000Q99", p: 0 }], direct: 0.6 },
        { id: "01K6TEST000000000000000G99", answers: [], direct: null },
      ],
    },
    GREAD,
  );
  const [g] = gauges(actor);
  assert.equal(g.reading.at, 5000);
  assert.deepEqual(g.reading.answers, [{ id: Q1, p: 0.9 }, { id: Q2, p: 0.7 }]);
  assert.equal(g.reading.direct, 0.6);
  assert.ok(Math.abs(g.reading.score - 0.8) < 1e-9);
  assert.equal(g.reading.band, "high");
});

test("a rule change re-scores the kept reading; a removed question's answer is dropped", () => {
  const { actor } = start(JSON.stringify([GAUGE]));
  send(actor, { type: "gauge.read", readings: [{ id: G, answers: [{ id: Q1, p: 0.9 }, { id: Q2, p: 0.1 }], direct: null }] }, GREAD);
  assert.equal(gauges(actor)[0].reading.band, "mixed");
  send(actor, { type: "gauge.saved", ...GAUGE, rule: "holds" }, SAVED);
  assert.ok(Math.abs(gauges(actor)[0].reading.score - 0.3) < 1e-9);
  assert.equal(gauges(actor)[0].reading.band, "low");
  send(actor, { type: "gauge.saved", ...GAUGE, questions: [GAUGE.questions[0]] }, SAVED);
  assert.deepEqual(gauges(actor)[0].reading.answers, [{ id: Q1, p: 0.9 }]);
  assert.equal(gauges(actor)[0].reading.score, 0.9);
});

test("a discard removes the gauge, and the empty list is stored as empty", () => {
  const { actor, saved, emitted } = start(JSON.stringify([GAUGE]));
  send(actor, { type: "gauge.discarded", id: G }, { type: "object" });
  assert.deepEqual(emitted.at(-1).gauges, []);
  assert.equal(saved.at(-1), "[]");
  send(actor, { type: "gauge.discarded", id: G }, { type: "object" });
  assert.equal(emitted.length, 1, "discarding what is gone announces nothing");
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
