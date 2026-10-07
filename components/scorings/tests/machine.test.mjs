import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, normalise, header, parse, CAP } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "scoring.changed.json");
const LIST = json("queries", "list.json").reply;
const READ = json("queries", "read.json").reply;
// The gestures' schemas live with their emitters; read, never imported (11.2).
const other = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", "..", ...path), "utf8"));
const SCORED = other("gauge-post", "events", "post.scored.json");
const DISCARDED = other("scoring-list", "events", "scoring.discarded.json");
const recorded = [];

// Ids as ULIDs: 26 Crockford characters, the last two varying.
const id = (n) => `01K6TEST0000000000000000${String(n).padStart(2, "0")}`;
const G = id(90);
const Q = id(91);
const scoring = (n, over = {}) => ({
  id: id(n),
  at: 1000 + n,
  text: `Post ${n}\nsecond line`,
  gauges: [{ id: G, name: "Clarity", label: "Is it clear", direct: 0.8, questions: [{ id: Q, label: "Short", p: 0.3 }] }],
  ...over,
});

const start = (stored = null) => {
  const saved = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v) } });
  const emitted = [];
  actor.on("scoring.changed", (e) => {
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
const ask = (actor, name, payload, schema) => {
  let reply;
  actor.send({ type: `${name}?`, cid: 1, payload, reply: (v) => (reply = v) });
  recorded.push({ value: reply, schema });
  return reply;
};

test("normalise keeps the record's shape and drops what does not fit", () => {
  assert.equal(normalise({ id: "nope", at: 1 }), null);
  assert.equal(normalise({ id: id(1), at: 1.5 }), null);
  const s = normalise({
    id: id(1),
    at: 5,
    gauges: [{ id: G, direct: 2, questions: [{ id: Q, p: 0.5 }, { id: Q, p: -1 }, null] }, { id: "bad" }],
  });
  assert.deepEqual(s, { id: id(1), at: 5, text: "", gauges: [{ id: G, name: "", label: "", direct: null, questions: [{ id: Q, label: "", p: 0.5 }] }] });
});

test("a header carries the first line and each tool's band from its headline answer", () => {
  const h = header(normalise(scoring(1, { text: `${"x".repeat(300)}\nmore` })));
  assert.equal(h.text.length, 200);
  assert.deepEqual(h.gauges, [{ id: G, name: "Clarity", band: "high" }]);
  assert.equal(header(normalise(scoring(2, { gauges: [{ id: G, name: "C", label: "", direct: null, questions: [] }] }))).gauges[0].band, null);
  assert.equal(header(normalise(scoring(3))).text, "Post 3");
});

test("nothing stored, or garbage, is an empty history", () => {
  assert.deepEqual(parse(null), []);
  assert.deepEqual(parse("not json"), []);
  assert.deepEqual(parse("{}"), []);
});

test("a scoring goes in first, is stored, and is announced as headers", () => {
  const { actor, saved, emitted } = start();
  send(actor, { type: "post.scored", ...scoring(1) }, SCORED);
  send(actor, { type: "post.scored", ...scoring(2) }, SCORED);
  assert.deepEqual(emitted.at(-1).scorings.map((s) => s.id), [id(2), id(1)]);
  assert.deepEqual(parse(saved.at(-1)).map((s) => s.id), [id(2), id(1)]);
  assert.deepEqual(ask(start(saved.at(-1)).actor, "list", {}, LIST).scorings.map((s) => s.id), [id(2), id(1)], "a reload reads the same");
});

test("only the newest scorings are kept", () => {
  const many = Array.from({ length: CAP }, (_, i) => scoring(i % 100, { id: `01K6TEST00000000000000${String(i).padStart(4, "0")}` })).reverse();
  const { actor, emitted } = start(JSON.stringify(many));
  const NEWEST = "01K6TESTNEW000000000000000";
  send(actor, { type: "post.scored", ...scoring(1, { id: NEWEST }) }, SCORED);
  const ids = emitted.at(-1).scorings.map((s) => s.id);
  assert.equal(ids.length, CAP);
  assert.equal(ids[0], NEWEST);
  assert.ok(!ids.includes("01K6TEST000000000000000000"), "the oldest is dropped");
});

test("a discard removes the scoring; discarding what is gone announces nothing", () => {
  const { actor, emitted } = start(JSON.stringify([scoring(2), scoring(1)]));
  send(actor, { type: "scoring.discarded", id: id(2) }, DISCARDED);
  assert.deepEqual(emitted.at(-1).scorings.map((s) => s.id), [id(1)]);
  send(actor, { type: "scoring.discarded", id: id(2) }, DISCARDED);
  assert.equal(emitted.length, 1);
});

test("read answers the whole record, or null", () => {
  const { actor } = start(JSON.stringify([scoring(1)]));
  assert.deepEqual(ask(actor, "read", { id: id(1) }, READ).scoring, scoring(1));
  assert.deepEqual(ask(actor, "read", { id: id(2) }, READ), { scoring: null });
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
