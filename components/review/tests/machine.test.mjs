import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, normalise } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "review.changed.json");
const READ = json("queries", "read.json").reply;
// Every emit and reply the tests below produce, checked against its schema last.
const recorded = [];

const A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const B = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const TEXT = "# Title\n\nA book was a path through the box.";

// The actor is driven with a fake store; `saved` records every write.
const start = (stored = null) => {
  const saved = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(v) } });
  const emitted = [];
  actor.on("review.changed", (e) => {
    emitted.push(e);
    recorded.push({ value: e, schema: CHANGED });
  });
  actor.start();
  return { actor, saved, emitted };
};

const read = (actor) => {
  let reply;
  actor.send({ type: "read?", cid: 1, reply: (v) => (reply = v) });
  recorded.push({ value: reply, schema: READ });
  return reply;
};

test("nothing stored, or garbage, reads as no review", () => {
  assert.deepEqual(read(start().actor), { review: null });
  assert.deepEqual(read(start("not json").actor), { review: null });
});

test("a save is stored and announced once; a repeat does nothing", () => {
  const { actor, saved, emitted } = start();
  const review = { text: TEXT, comments: [{ id: A, start: 9, end: 15, quote: "A book", text: "Say an app" }] };
  actor.send({ type: "review.saved", ...review });
  actor.send({ type: "review.saved", ...review });
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].review, review);
  assert.deepEqual(JSON.parse(saved.at(-1)), review);
  assert.deepEqual(read(actor), { review });
  // What was stored is what a reload reads.
  assert.deepEqual(read(start(saved.at(-1)).actor), { review });
});

test("an empty text clears the review to null", () => {
  const { actor, saved, emitted } = start(JSON.stringify({ text: TEXT, comments: [] }));
  actor.send({ type: "review.saved", text: "", comments: [] });
  assert.deepEqual(emitted.at(-1), { type: "review.changed", review: null });
  assert.equal(saved.at(-1), "");
  assert.deepEqual(read(actor), { review: null });
});

test("comments outside the text or overlapping an earlier one are dropped, the rest sorted", () => {
  const review = normalise({
    text: TEXT,
    comments: [
      { id: B, start: 20, end: 24, quote: "x", text: "later" },
      { id: A, start: 9, end: 22, quote: "x", text: "first" },
      { id: "C", start: 40, end: 400, quote: "x", text: "out of range" },
      { id: "D", start: 5, end: 5, quote: "", text: "empty" },
    ],
  });
  assert.deepEqual(review.comments, [{ id: A, start: 9, end: 22, quote: TEXT.slice(9, 22), text: "first" }]);
});

test("every payload matches its schema", () => {
  assert.ok(recorded.length > 0, "the tests above recorded traffic");
  for (const { value, schema } of recorded) {
    const { type, ...rest } = value;
    const result = new Validator(schema, "2020-12").validate(rest);
    assert.ok(result.valid, `${JSON.stringify(value).slice(0, 160)}: ${JSON.stringify(result.errors?.[0])}`);
  }
});
