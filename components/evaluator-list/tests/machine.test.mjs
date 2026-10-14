import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, subtitle, bookOf } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["evaluator.selected", "evaluator.switched"].map((n) => [n, schema(n)]));

const A = "01K7TEST000000000000000BA1";
const B = "01K7TEST000000000000000BB1";
const D1 = "01K7TEST000000000000000N01";
const D2 = "01K7TEST000000000000000N02";
const id = (n) => `01K7TEST0000000000000E${String(n).padStart(4, "0")}`;
const q = (n, removing = false) => ({ id: `01K7TEST0000000000000Q${String(n).padStart(4, "0")}`, removing });
const evaluator = (n, book, { on = true, removing = false, questions = [q(1)] } = {}) => ({
  id: id(n), book, name: `Evaluator ${n}`, on, removing, questions, version: 1, pending: false,
});
const KEPT = { [A]: [evaluator(1, A), evaluator(3, A, { removing: true }), evaluator(4, A, { on: false })], [B]: [evaluator(2, B)] };
const book = (bid) => ({ kind: "book", id: bid, title: "A book", view: "book-stage" });

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ subject = book(A), following = true, fail, kept = KEPT } = {}) => {
  const drafts = [D1, D2];
  const asked = [];
  const actor = createActor(machine, {
    input: {
      following,
      ask: (target, name, payload) => {
        asked.push([target, name, payload]);
        if (target === "subject") return Promise.resolve({ subject });
        return Promise.resolve(fail ?? { evaluators: kept[payload.book] ?? [] });
      },
      mint: () => drafts.shift(),
    },
  });
  const emitted = [];
  for (const type of Object.keys(SCHEMAS)) actor.on(type, (e) => emitted.push(e));
  actor.start();
  await flush();
  await flush();
  return { actor, emitted, asked, ctx: () => actor.getSnapshot().context };
};

const valid = (emitted) => {
  for (const { type, ...rest } of emitted) assert.ok(new Validator(SCHEMAS[type], "2020-12").validate(rest).valid, type);
};

test("the rows leave out an evaluator being deleted; the line under each counts live questions and says off", () => {
  assert.deepEqual(rows(KEPT[A]).map((e) => e.id), [id(1), id(4)]);
  assert.equal(subtitle(evaluator(1, A, { questions: [q(1), q(2), q(3, true)] })), "2 questions");
  assert.equal(subtitle(evaluator(1, A, { on: false })), "1 question · off");
});

test("only a book is a subject with evaluators", () => {
  assert.equal(bookOf(book(A)), A);
  assert.equal(bookOf({ kind: "other", id: A, title: "" }), null);
  assert.equal(bookOf(null), null);
});

test("the open book's evaluators are listed; another book shows its own; no book shows none", async () => {
  const { actor, asked, ctx } = await start();
  assert.ok(actor.getSnapshot().matches("ready"));
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(1), id(4)]);
  actor.send({ type: "subject.changed", subject: book(B) });
  await flush();
  assert.equal(ctx().book, B);
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(2)]);
  actor.send({ type: "subject.changed", subject: null });
  assert.ok(actor.getSnapshot().matches("idle"));
  assert.deepEqual(ctx().evaluators, []);
  assert.deepEqual(asked.filter(([t]) => t === "evaluators").map(([, , p]) => p.book), [A, B]);
});

test("a book picked while another is still loading is the one shown", async () => {
  const pending = new Map();
  const actor = createActor(machine, {
    input: {
      following: true,
      mint: () => D1,
      ask: (target, name, payload) =>
        target === "subject" ? Promise.resolve({ subject: book(A) }) : new Promise((r) => pending.set(payload.book, r)),
    },
  });
  actor.start();
  await flush();
  actor.send({ type: "subject.changed", subject: book(B) });
  pending.get(A)({ evaluators: KEPT[A] });
  await flush();
  assert.ok(actor.getSnapshot().matches("loading"));
  pending.get(B)({ evaluators: KEPT[B] });
  await flush();
  assert.deepEqual(actor.getSnapshot().context.evaluators.map((e) => e.id), [id(2)]);
});

test("without `subject` nothing is asked and it says to open a book", async () => {
  const { actor, asked } = await start({ following: false });
  assert.ok(actor.getSnapshot().matches("idle"));
  assert.deepEqual(asked, []);
});

test("a pick of a shown evaluator or New evaluator emits evaluator.selected with the book; others are refused", async () => {
  const { actor, emitted, ctx } = await start();
  actor.send({ type: "_pick", id: id(1) });
  actor.send({ type: "_pick", id: D1 });
  actor.send({ type: "_pick", id: id(2) });
  actor.send({ type: "_pick", id: id(3) });
  assert.deepEqual(emitted, [
    { type: "evaluator.selected", id: id(1), book: A },
    { type: "evaluator.selected", id: D1, book: A },
  ]);
  assert.equal(ctx().open, D1);
  valid(emitted);
});

test("a tick emits evaluator.switched for a shown evaluator whose state it changes", async () => {
  const { actor, emitted } = await start();
  actor.send({ type: "_switch", id: id(4), on: true });
  actor.send({ type: "_switch", id: id(1), on: true });
  actor.send({ type: "_switch", id: id(2), on: false });
  assert.deepEqual(emitted, [{ type: "evaluator.switched", id: id(4), on: true }]);
  valid(emitted);
});

test("a change to the book shown is folded in, another book's is not; New evaluator gets a fresh id once saved", async () => {
  const { actor, ctx } = await start();
  assert.equal(ctx().draft, D1);
  actor.send({ type: "evaluator.changed", evaluator: { ...evaluator(9, A), id: D1 } });
  assert.equal(ctx().draft, D2);
  assert.ok(ctx().evaluators.some((e) => e.id === D1));
  actor.send({ type: "evaluator.changed", evaluator: evaluator(7, B) });
  assert.ok(!ctx().evaluators.some((e) => e.id === id(7)));
  actor.send({ type: "evaluator.changed", evaluator: { ...evaluator(1, A), name: "Renamed" } });
  assert.equal(ctx().evaluators.find((e) => e.id === id(1)).name, "Renamed");
  actor.send({ type: "evaluator.deleted", id: id(1), book: A });
  assert.ok(!ctx().evaluators.some((e) => e.id === id(1)));
});

test("a fact that cannot answer is an honest failure", async () => {
  const { actor } = await start({ fail: { error: "no-answerer" } });
  assert.ok(actor.getSnapshot().matches("failed"));
});
