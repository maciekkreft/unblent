import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (...path) => JSON.parse(readFileSync(resolve(HERE, "..", ...path), "utf8"));
const CHANGED = json("events", "pins.changed.json");
const READ = json("queries", "read.json").reply;
const recorded = [];

const NOTE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CHAT = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const BOOK = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

const start = (stored = null) => {
  const saved = [];
  const actor = createActor(machine, { input: { stored, save: (v) => saved.push(JSON.parse(v)) } });
  const emitted = [];
  actor.on("pins.changed", (e) => {
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

test("nothing stored, or something unreadable, is nothing pinned", () => {
  for (const stored of [null, "not json", JSON.stringify({ note: "nope", chat: 3 })]) {
    assert.deepEqual(read(start(stored).actor), { note: null, chat: null, evaluators: null });
  }
});

test("a pin is kept, saved and announced, and each of the three is its own", () => {
  const { actor, saved, emitted } = start();
  actor.send({ type: "pin.toggled", what: "note", id: NOTE });
  actor.send({ type: "pin.toggled", what: "chat", id: CHAT });
  actor.send({ type: "pin.toggled", what: "evaluators", id: BOOK });
  const all = { note: NOTE, chat: CHAT, evaluators: BOOK };
  assert.deepEqual(read(actor), all);
  assert.deepEqual(saved.at(-1), all);
  assert.equal(emitted.length, 3);
  assert.deepEqual({ ...emitted.at(-1), type: undefined }, { ...all, type: undefined });

  actor.send({ type: "pin.toggled", what: "chat", id: null });
  assert.deepEqual(read(actor), { ...all, chat: null }, "unpinning one leaves the others");
});

test("a repeat changes nothing and announces nothing", () => {
  const { actor, saved, emitted } = start(JSON.stringify({ note: NOTE, chat: null, evaluators: null }));
  actor.send({ type: "pin.toggled", what: "note", id: NOTE });
  actor.send({ type: "pin.toggled", what: "chat", id: null });
  assert.equal(saved.length, 0);
  assert.equal(emitted.length, 0);
});

test("a stored pin survives a reload", () => {
  const first = start();
  first.actor.send({ type: "pin.toggled", what: "evaluators", id: BOOK });
  const again = start(JSON.stringify(first.saved.at(-1)));
  assert.deepEqual(read(again.actor), { note: null, chat: null, evaluators: BOOK });
});

test("every emit and reply matches its schema", () => {
  for (const { value, schema } of recorded) {
    const { type, ...payload } = value;
    const result = new Validator(schema, "2020-12").validate(payload);
    assert.ok(result.valid, JSON.stringify(result.errors));
  }
});
