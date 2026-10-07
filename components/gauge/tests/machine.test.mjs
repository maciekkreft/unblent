import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, normalise, band, parse, SEED, SEED_VERSION } from "../machine.js";

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
  label: "",
  yes: "one point, plainly made",
  no: "the reader has to guess",
  rule: "adds",
  questions: [
    { id: Q1, text: "One idea?", yes: "one", no: "many" },
    { id: Q2, text: "Short?", yes: "", no: "", label: "Short" },
  ],
};

// A list as the current store writes it, so these tests see no seed catch-up.
const store = (gauges) => JSON.stringify({ version: SEED_VERSION, gauges });

const start = (stored = store([]), at = 1000) => {
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
  assert.deepEqual(g, { id: G, name: "", question: "", label: "", yes: "", no: "", rule: "adds", questions: [{ id: Q1, text: "x", yes: "", no: "" }], reading: null });
});

const NAMES = ["Replyability", "Viewability", "Followability", "Shareability", "Likeability", "Saveability"];

test("nothing stored, or garbage, is the whole seed; an empty current list stays empty", () => {
  assert.deepEqual(parse(null).map((g) => g.name), NAMES);
  assert.deepEqual(parse("not json").map((g) => g.name), NAMES);
  assert.deepEqual(parse(store([])), []);
  assert.ok(SEED.every((g) => !("since" in g)), "since never leaves the machine");
  for (const g of SEED) {
    assert.equal(g.questions.length, 4);
    assert.ok(g.questions.every((q) => q.label && q.yes && q.no));
    assert.ok(g.yes && g.no, `${g.name} carries criteria for its main question`);
  }
  assert.equal(gauges(start(null).actor).length, 6);
});

test("a fresh browser gets the whole seed and stores it at the current version on its first change", () => {
  const { actor, saved } = start(null);
  const { reading, ...first } = gauges(actor)[0];
  send(actor, { type: "gauge.saved", ...first, name: "Views" }, SAVED);
  const written = JSON.parse(saved.at(-1));
  assert.equal(written.version, SEED_VERSION);
  assert.deepEqual(written.gauges.map((g) => g.name), ["Views", ...NAMES.slice(1)]);
  assert.ok(written.gauges.every((g) => !("since" in g)));
});

// What seed version 1 stored: a bare list of the four tools that version had, without the main
// question's wording, which that version did not have.
const V1 = SEED.slice(2).map((g) => ({ ...g, yes: undefined, no: undefined }));

test("a version-1 list gets the main-question wording and the new tool, first", () => {
  const list = parse(JSON.stringify(V1));
  assert.deepEqual(list.map((g) => g.name), NAMES);
  assert.deepEqual(list, parse(null));
});

test("a version-1 list keeps the user's own wording, names, questions and rule", () => {
  const mine = { id: "01K6TEST000000000000000Q77", text: "My question?", yes: "", no: "" };
  const [follow, ...rest] = V1;
  const edited = {
    ...follow,
    name: "Follow-worthy",
    rule: "holds",
    yes: "my yes",
    questions: [{ ...follow.questions[0], yes: "my own yes", no: "" }, ...follow.questions.slice(1), mine],
  };
  const [, , got] = parse(JSON.stringify([edited, ...rest]));
  assert.equal(got.name, "Follow-worthy");
  assert.equal(got.rule, "holds");
  assert.equal(got.yes, "my yes", "non-empty wording is never touched");
  assert.equal(got.no, SEED[2].no, "empty wording is filled from the seed");
  assert.equal(got.questions[0].yes, "my own yes");
  assert.equal(got.questions[0].no, SEED[2].questions[0].no);
  assert.deepEqual(got.questions.at(-1), mine, "a question the user added is left alone");
});

test("a seed tool deleted under version 1 stays deleted", () => {
  const list = parse(JSON.stringify(V1.filter((g) => g.name !== "Likeability")));
  assert.deepEqual(list.map((g) => g.name), ["Replyability", "Viewability", "Followability", "Shareability", "Saveability"]);
  assert.deepEqual(parse(JSON.stringify([])).map((g) => g.name), ["Replyability", "Viewability"], "only what a newer seed added appears");
});

test("a list at the current version is read untouched", () => {
  const list = [{ ...SEED[1], yes: "", no: "" }];
  assert.deepEqual(parse(store(list)), list);
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
  const { actor } = start(store([{ ...GAUGE, yes: undefined, no: undefined }]));
  assert.equal(gauges(actor)[0].yes, "");
  send(actor, { type: "gauge.saved", ...GAUGE }, SAVED);
  assert.equal(gauges(actor)[0].yes, "one point, plainly made");
  assert.equal(gauges(actor)[0].no, "the reader has to guess");
});

test("a reading is kept, scored and banded; unknown answers and gauges are dropped", () => {
  const { actor } = start(store([GAUGE]), 5000);
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
  assert.equal(g.reading.score, 0.6, "the score is the headline question's answer");
  assert.equal(g.reading.band, "mixed");
});

test("editing the questions keeps the reading's score; a removed question's answer is dropped", () => {
  const { actor } = start(store([GAUGE]));
  send(actor, { type: "gauge.read", readings: [{ id: G, answers: [{ id: Q1, p: 0.9 }, { id: Q2, p: 0.1 }], direct: 0.8 }] }, GREAD);
  assert.equal(gauges(actor)[0].reading.band, "high");
  send(actor, { type: "gauge.saved", ...GAUGE, questions: [GAUGE.questions[0]] }, SAVED);
  assert.deepEqual(gauges(actor)[0].reading.answers, [{ id: Q1, p: 0.9 }]);
  assert.equal(gauges(actor)[0].reading.score, 0.8);
  assert.equal(gauges(actor)[0].reading.band, "high");
});

test("a version-2 list gets the seed's short names once; the user's own is kept", () => {
  const [view, follow, ...rest] = SEED.map((g) => ({ ...g, label: "" }));
  const list = parse(JSON.stringify({ version: 2, gauges: [{ ...view, label: "Mine" }, follow, ...rest] }));
  assert.equal(list[0].label, "Mine");
  assert.deepEqual(list.slice(1).map((g) => g.label), SEED.slice(1).map((g) => g.label));
  assert.ok(SEED.every((g) => g.label), "every seed tool has a short name");
});

test("a discard removes the gauge, and the empty list is stored as empty", () => {
  const { actor, saved, emitted } = start(store([GAUGE]));
  send(actor, { type: "gauge.discarded", id: G }, { type: "object" });
  assert.deepEqual(emitted.at(-1).gauges, []);
  assert.deepEqual(JSON.parse(saved.at(-1)), { version: SEED_VERSION, gauges: [] });
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
