import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, subtitle, bookOf, request, score, results, errorKind } from "../machine.js";

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
const start = async ({ subject = book(A), following = true, fail, kept = KEPT, vimKeys, decide } = {}) => {
  const drafts = [D1, D2];
  const asked = [];
  const actor = createActor(machine, {
    input: {
      following,
      ask: (target, name, payload) => {
        asked.push([target, name, payload]);
        if (target === "subject") return Promise.resolve({ subject });
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        if (target === "llm") return decide(payload);
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
  assert.deepEqual(asked.filter(([t]) => t !== "settings"), []);
});

test("the Vim keys preference is read at start and followed after; without settings it is off", async () => {
  assert.equal((await start()).ctx().vimKeys, false);
  const { actor, ctx } = await start({ vimKeys: true });
  assert.equal(ctx().vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(ctx().vimKeys, false);
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

// The Run box.
const Q = (n) => "01K7TEST0000000000000Q" + String(n).padStart(4, "0");
const qid = (e, q) => e + ":" + q;
const O = (n) => "01K7TEST0000000000000O" + String(n).padStart(4, "0");
const yesno = (n, text, extra = {}) => ({ id: Q(n), kind: "yesno", text, yes: "", no: "", options: [], ...extra });
const option = (n, name, extra = {}) => ({ id: O(n), name, description: "", ...extra });
const pick = (n, text, options, extra = {}) => ({ id: Q(n), kind: "pick", text, yes: "", no: "", options, ...extra });

const MIXED = [
  evaluator(1, A, {
    questions: [
      yesno(1, "Is it kind?", { yes: "It is warm", no: "" }),
      yesno(2, "Is it short?", { removing: true }),
      yesno(3, "  "),
      pick(4, "Which tone?", [option(1, "Calm", { description: "Even" }), option(2, "Angry"), option(3, "Gone", { removing: true })]),
    ],
  }),
  evaluator(2, A, { on: false, questions: [yesno(5, "Off?")] }),
  evaluator(3, A, { removing: true, questions: [yesno(6, "Removing?")] }),
  evaluator(4, A, { questions: [yesno(7, "")] }),
  evaluator(5, A, {
    questions: [
      pick(8, "Too few?", [option(4, "One"), option(5, "Two", { removing: true })]),
      pick(9, "Same names?", [option(6, "Same"), option(7, "Same")]),
      pick(10, "Which?", [option(8, "Left"), option(9, "Right")]),
    ],
  }),
];

test("a run asks every askable question of the switched-on evaluators, under evaluator:question ids", () => {
  assert.deepEqual(request("Hello", MIXED), {
    state: { text: "Hello" },
    questions: [
      { id: qid(id(1), Q(1)), instructions: "Is it kind?", yes: "It is warm" },
      {
        id: qid(id(1), Q(4)),
        instructions: "Which tone?",
        kind: "pick",
        options: [{ id: O(1), name: "Calm", description: "Even" }, { id: O(2), name: "Angry" }],
      },
      { id: qid(id(5), Q(10)), instructions: "Which?", kind: "pick", options: [{ id: O(8), name: "Left" }, { id: O(9), name: "Right" }] },
    ],
  });
});

test("the score is the geometric mean of the yes / no answers; none gives no score", () => {
  assert.equal(score([]), null);
  assert.equal(score([0.25, 1]).toFixed(2), "0.50");
  assert.equal(score([0, 0.9]), 0);
  const out = results(
    [{ id: id(1), questions: [yesno(1, "A?"), yesno(2, "B?"), pick(3, "C?", [option(1, "x"), option(2, "y")])] }],
    [
      { id: qid(id(1), Q(1)), p: 0.81 },
      { id: qid(id(1), Q(2)), p: 0.25 },
      { id: qid(id(1), Q(3)), p: 0.01, choice: O(2) },
    ],
  );
  assert.equal(out[id(1)].score.toFixed(2), "0.45");
  assert.equal(results([{ id: id(2), questions: [pick(3, "C?", [option(1, "x"), option(2, "y")])] }], [{ id: qid(id(2), Q(3)), p: 0.7, choice: O(1) }])[id(2)].score, null);
});

test("error replies come in four kinds", () => {
  assert.equal(errorKind("signed-out"), "signed-out");
  assert.equal(errorKind("no-key"), "key");
  assert.equal(errorKind("bad-key"), "key");
  for (const e of ["rate-limited", "overloaded", "busy"]) assert.equal(errorKind(e), "busy");
  for (const e of ["invalid", "unavailable", "no-answerer", undefined]) assert.equal(errorKind(e), "failed");
});

const ANSWERS = {
  answers: [
    { id: qid(id(1), Q(1)), p: 0.93 },
    { id: qid(id(1), Q(4)), p: 0.6, choice: O(2), probabilities: [{ id: O(1), p: 0.4 }, { id: O(2), p: 0.6 }], confidence: 0.2 },
    { id: qid(id(5), Q(10)), p: 0.8, choice: O(8) },
  ],
  inputTokens: 10,
  ms: 5,
};

const runner = async (reply = ANSWERS) => {
  let settle;
  const decided = [];
  const s = await start({
    kept: { [A]: MIXED, [B]: [] },
    decide: (payload) => {
      decided.push(payload);
      return new Promise((r) => (settle = () => r(reply)));
    },
  });
  return { ...s, decided, settle: async () => (settle(), await flush()) };
};

test("Run asks once, shows it is running, and maps the answers back onto the rows", async () => {
  const { actor, ctx, decided, settle } = await runner();
  actor.send({ type: "_run" });
  assert.equal(decided.length, 0, "no text, no run");
  actor.send({ type: "_type", text: "Hello" });
  actor.send({ type: "_run" });
  assert.equal(ctx().running, true);
  actor.send({ type: "_run" });
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0], request("Hello", MIXED));
  await settle();
  assert.equal(ctx().running, false);
  assert.equal(ctx().error, null);
  assert.deepEqual(ctx().results, {
    [id(1)]: {
      score: 0.93,
      questions: [
        { id: Q(1), text: "Is it kind?", kind: "yesno", label: "Yes", p: 0.93 },
        { id: Q(4), text: "Which tone?", kind: "pick", label: "Angry", p: 0.6 },
      ],
    },
    [id(5)]: { score: null, questions: [{ id: Q(10), text: "Which?", kind: "pick", label: "Left", p: 0.8 }] },
  });
  actor.send({ type: "_clear" });
  assert.deepEqual(ctx().results, {});
});

test("an error reply says which kind and keeps nothing running", async () => {
  const { actor, ctx, settle } = await runner({ error: "no-key" });
  actor.send({ type: "_type", text: "Hello" });
  actor.send({ type: "_run" });
  await settle();
  assert.equal(ctx().running, false);
  assert.equal(ctx().error, "key");
  assert.deepEqual(ctx().results, {});
});

test("nothing switched on with a question to ask is no run", async () => {
  const decided = [];
  const { actor } = await start({ kept: { [A]: [MIXED[1], MIXED[3]] }, decide: (p) => (decided.push(p), Promise.resolve(ANSWERS)) });
  actor.send({ type: "_type", text: "Hello" });
  actor.send({ type: "_run" });
  assert.deepEqual(decided, []);
});

test("a changed or deleted evaluator loses its result, even one still on its way; a rename keeps it", async () => {
  const { actor, ctx, settle } = await runner();
  actor.send({ type: "_type", text: "Hello" });
  actor.send({ type: "_run" });
  actor.send({ type: "evaluator.changed", evaluator: { ...MIXED[4], on: false } });
  await settle();
  assert.deepEqual(Object.keys(ctx().results), [id(1)]);
  actor.send({ type: "evaluator.changed", evaluator: { ...MIXED[0], name: "Renamed", version: 2 } });
  assert.deepEqual(Object.keys(ctx().results), [id(1)]);
  actor.send({ type: "evaluator.changed", evaluator: { ...MIXED[0], questions: [yesno(1, "Is it cruel?")] } });
  assert.deepEqual(ctx().results, {});

  const again = await runner();
  again.actor.send({ type: "_type", text: "Hello" });
  again.actor.send({ type: "_run" });
  await again.settle();
  again.actor.send({ type: "evaluator.deleted", id: id(1), book: A });
  assert.deepEqual(Object.keys(again.ctx().results), [id(5)]);
});

test("another book drops every result and the text", async () => {
  const { actor, ctx, settle } = await runner();
  actor.send({ type: "_type", text: "Hello" });
  actor.send({ type: "_run" });
  await settle();
  actor.send({ type: "subject.changed", subject: book(A) });
  assert.equal(ctx().text, "Hello");
  actor.send({ type: "subject.changed", subject: book(B) });
  await flush();
  assert.equal(ctx().text, "");
  assert.deepEqual(ctx().results, {});
  assert.equal(ctx().running, false);
});
