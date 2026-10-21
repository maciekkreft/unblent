import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActor, SimulatedClock } from "xstate";
import { Validator } from "@cfworker/json-schema";
import { machine, rows, subtitle, bookOf, request, lines, results, errorKind, sayPick, sayYesNo, foldLine, foldedAtStart, freeStop, notice, sayExpect, marksOf, tally, focusOf, asExpected, showing, runsOf, waiting, stoppable, RECHECK_MS } from "../machine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = (name) => JSON.parse(readFileSync(resolve(HERE, "..", "events", `${name}.json`), "utf8"));
const SCHEMAS = Object.fromEntries(["evaluator.selected", "evaluator.switched", "evaluator.moved", "evaluator.discarded", "removal.started"].map((n) => [n, schema(n)]));

const A = "01K7TEST000000000000000BA1";
const B = "01K7TEST000000000000000BB1";
const D1 = "01K7TEST000000000000000N01";
const D2 = "01K7TEST000000000000000N02";
const id = (n) => `01K7TEST0000000000000E${String(n).padStart(4, "0")}`;
const q = (n, removing = false) => ({ id: `01K7TEST0000000000000Q${String(n).padStart(4, "0")}`, kind: "yesno", text: `Question ${n}?`, removing });
const evaluator = (n, book, { on = true, removing = false, questions = [q(1)] } = {}) => ({
  id: id(n), book, name: `Evaluator ${n}`, on, removing, questions, version: 1, pending: false,
});
const KEPT = { [A]: [evaluator(1, A), evaluator(3, A, { removing: true }), evaluator(4, A, { on: false })], [B]: [evaluator(2, B)] };
const book = (bid) => ({ kind: "book", id: bid, title: "A book", view: "book-stage" });

const flush = () => new Promise((r) => setTimeout(r, 0));
const start = async ({ subject = book(A), following = true, fail, kept = KEPT, vimKeys, decide, pinned = null, texts, freeUse, session, tryPage, memory, clock, undoMs } = {}) => {
  const drafts = [D1, D2];
  const asked = [];
  const actor = createActor(machine, {
    input: {
      following,
      tryPage,
      ask: (target, name, payload) => {
        asked.push([target, name, payload]);
        if (target === "subject") return Promise.resolve({ subject });
        if (target === "session") return Promise.resolve(session ?? { error: "no-answerer" });
        if (target === "pins") return Promise.resolve({ note: null, chat: null, evaluators: pinned });
        if (target === "settings") return Promise.resolve(vimKeys == null ? { error: "no-answerer" } : { vimKeys });
        if (target === "llm" && name === "read") return Promise.resolve(freeUse ? { signedIn: true, freeUse } : { signedIn: false });
        if (target === "llm") return decide(payload);
        return Promise.resolve(fail ?? { evaluators: kept[payload.book] ?? [] });
      },
      mint: () => drafts.shift(),
      ...(texts ? { drafts: texts } : {}),
      ...(memory ? { memory } : {}),
      ...(undoMs ? { undoMs } : {}),
    },
    ...(clock ? { clock } : {}),
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

test("the count leaves out a question switched off; one without `on` counts as on", () => {
  assert.equal(subtitle(evaluator(1, A, { questions: [q(1), { ...q(2), on: false }, { ...q(3), on: true }] })), "2 questions");
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

// The journal, like any book, lists only its own evaluators. Records may still carry
// `journal: true` from the retired Show in journal tick; it is ignored.
const J = "01K7TEST000000000000000BJ1";
const BOOKS = [
  { id: J, title: "Journal", written: true },
  { id: A, title: "Atomic Habits" },
];

test("the journal lists only its own evaluators, an old Show in journal mark changing nothing", async () => {
  const asking = [{ ...q(1), kind: "yesno", text: "Is it kind?", yes: "", no: "", options: [] }];
  const marked = { ...evaluator(6, A, { questions: asking }), journal: true };
  const kept = [evaluator(5, J, { questions: asking }), marked];
  const asked = [];
  const actor = createActor(machine, {
    input: {
      following: true,
      mint: () => D1,
      ask: (target, name, payload) => {
        asked.push([target, name, payload]);
        if (target === "subject") return Promise.resolve({ subject: book(J) });
        if (target === "books") return Promise.resolve({ books: BOOKS });
        if (target === "settings") return Promise.resolve({ error: "no-answerer" });
        // A fact answering more than the book asked for still shows only that book's.
        return Promise.resolve({ evaluators: kept });
      },
    },
  }).start();
  const ctx = () => actor.getSnapshot().context;
  await flush();
  await flush();
  assert.ok(actor.getSnapshot().matches("ready"));
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(5)]);
  assert.deepEqual(asked.filter(([t]) => t === "evaluators").map(([, , p]) => p), [{ book: J }], "the journal asks for its own only");
  assert.equal(ctx().titles[J], "Journal");
  assert.deepEqual(request("Hi", ctx().evaluators).questions.map((q) => q.id.split(":")[0]), [id(5)]);
  // News of another book's evaluator, marked or not, leaves the journal's list as it is.
  actor.send({ type: "evaluator.changed", evaluator: { ...marked, name: "Renamed" } });
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(5)]);
  assert.equal(subtitle(marked), "1 question");
});

test("a book picked while another is still loading is the one shown", async () => {
  const pending = new Map();
  const actor = createActor(machine, {
    input: {
      following: true,
      mint: () => D1,
      ask: (target, name, payload) =>
        target === "subject"
          ? Promise.resolve({ subject: book(A) })
          : target === "pins"
            ? Promise.resolve({ note: null, chat: null, evaluators: null })
            : new Promise((r) => pending.set(payload.book, r)),
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

test("pinned at start, the list shows the pinned book and stays on it when the stage moves", async () => {
  const { actor, ctx, asked } = await start({ subject: book(A), pinned: B });
  assert.equal(ctx().book, B);
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(2)]);
  actor.send({ type: "subject.changed", subject: book(A) });
  await flush();
  assert.equal(ctx().book, B, "still the pinned book");
  assert.deepEqual(asked.filter(([t]) => t === "evaluators").map(([, , p]) => p), [{ book: B }], "A was never asked for");
});

test("pinned to the book shown, the list stays on it; unpinned, it shows the stage's book at once", async () => {
  const { actor, ctx } = await start({ subject: book(A) });
  actor.send({ type: "pins.changed", note: null, chat: null, evaluators: A });
  actor.send({ type: "subject.changed", subject: book(B) });
  await flush();
  assert.equal(ctx().book, A, "pinned: stays on A");
  actor.send({ type: "pins.changed", note: null, chat: null, evaluators: null });
  await flush();
  await flush();
  assert.equal(ctx().book, B, "unpinned: the book on the stage");
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(2)]);
});

test("pins.changed unpinning elsewhere follows the stage; pinning the shown book changes nothing shown", async () => {
  const { actor, ctx } = await start({ subject: book(A), pinned: B });
  actor.send({ type: "pins.changed", note: null, chat: null, evaluators: null });
  await flush();
  await flush();
  assert.equal(ctx().book, A);
  actor.send({ type: "pins.changed", note: null, chat: null, evaluators: A });
  assert.equal(ctx().book, A);
  assert.ok(actor.getSnapshot().matches("ready"));
});

test("without `subject` nothing is asked and it says to open a book", async () => {
  const { actor, asked } = await start({ following: false });
  assert.ok(actor.getSnapshot().matches("idle"));
  assert.deepEqual(asked.filter(([t, n]) => t !== "settings" && t !== "session" && !(t === "llm" && n === "read")), []);
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
  assert.equal(ctx().open, null, "the mark waits for the editor");
  actor.send({ type: "evaluator.opened", id: id(1) });
  assert.equal(ctx().open, id(1));
  actor.send({ type: "evaluator.opened", id: null });
  assert.equal(ctx().open, null);
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

test("a run leaves out a question switched off, so the score uses only the switched-on ones", () => {
  const both = evaluator(6, A, { questions: [yesno(11, "On?"), yesno(12, "Off?", { on: false }), yesno(13, "Also on?", { on: true })] });
  assert.deepEqual(
    request("Hi", [both]).questions.map((x) => x.id),
    [qid(id(6), Q(11)), qid(id(6), Q(13))],
  );
  assert.deepEqual(request("Hi", [evaluator(7, A, { questions: [yesno(14, "Off?", { on: false })] })]).questions, []);
});

test("a pick answer is told in words from every option's probability", () => {
  const ranked = (...ps) => ps.map(([name, p]) => ({ name, p }));
  assert.equal(sayPick(ranked(["Calm", 0.75], ["Angry", 0.25])), "Calm");
  assert.equal(sayPick(ranked(["Calm", 0.5], ["Angry", 0.4], ["Sad", 0.1])), "Between: Calm and Angry");
  assert.equal(sayPick(ranked(["Calm", 0.6], ["Angry", 0.3], ["Sad", 0.1])), "Probably: Calm");
  assert.equal(sayPick(ranked(["Calm", 0.4], ["Angry", 0.2], ["Sad", 0.2], ["Gone", 0.2])), "Not clear, maybe: Calm");
  assert.equal(sayPick(ranked(["a Name  as written", 0.9])), "a Name  as written", "names exactly as written");
});

test("a yes / no answer is told in words, an even chance as not clear", () => {
  const said = [0.9, 0.75, 0.74, 0.56, 0.55, 0.5, 0.45, 0.44, 0.25, 0.24, 0].map(sayYesNo);
  assert.deepEqual(said, ["Yes", "Yes", "Probably yes", "Probably yes", "Not clear", "Not clear", "Not clear", "Probably no", "Probably no", "No", "No"]);
});

test("an answer is green when it is the one expected, red when not, plain when none is", () => {
  const icons = [option(1, "Calm", { icon: "brain" }), option(2, "Angry"), option(3, "Gone", { removing: true })];
  const asked = [
    {
      id: id(1),
      questions: [
        yesno(1, "Kind?", { expect: "yes" }),
        yesno(2, "Short?", { expect: "yes" }),
        yesno(3, "Plain?"),
        pick(4, "Tone?", icons, { expect: O(1) }),
        pick(5, "Tone again?", icons, { expect: O(1) }),
        pick(6, "Unsure tone?", icons, { expect: O(1) }),
        pick(7, "Expects a gone one?", icons, { expect: O(3) }),
      ],
    },
  ];
  const out = results(asked, [
    { id: qid(id(1), Q(1)), p: 0.9 },
    { id: qid(id(1), Q(2)), p: 0.52 },
    { id: qid(id(1), Q(3)), p: 0.1 },
    { id: qid(id(1), Q(4)), p: 0.8, choice: O(1), probabilities: [{ id: O(1), p: 0.8 }, { id: O(2), p: 0.2 }] },
    { id: qid(id(1), Q(5)), p: 0.9, choice: O(2), probabilities: [{ id: O(1), p: 0.1 }, { id: O(2), p: 0.9 }] },
    { id: qid(id(1), Q(6)), p: 0.5, choice: O(2), probabilities: [{ id: O(1), p: 0.45 }, { id: O(2), p: 0.55 }] },
    { id: qid(id(1), Q(7)), p: 0.9, choice: O(1) },
  ])[id(1)].questions;
  assert.deepEqual(
    out.map((a) => [a.question, a.words, a.tone, a.glyph]),
    [
      ["Kind?", "Yes", "right", "check"],
      ["Short?", "Not clear", "right", "check"],
      ["Plain?", "No", null, null],
      ["Tone?", "Calm", "right", "brain"],
      ["Tone again?", "Angry", "wrong", "warning"],
      ["Unsure tone?", "Between: Angry and Calm", "wrong", "warning"],
      ["Expects a gone one?", "Calm", null, "brain"],
    ],
  );
  assert.deepEqual(out[5].probabilities, [{ id: O(2), p: 0.55 }, { id: O(1), p: 0.45 }], "every option's probability is kept, highest first");
  const lone = results([{ id: id(2), questions: [pick(3, "C?", [option(1, "x"), option(2, "y")])] }], [{ id: qid(id(2), Q(3)), p: 0.7, choice: O(1) }]);
  assert.equal(lone[id(2)].questions[0].question, null, "a lone pick question names itself");
  assert.equal(lone[id(2)].questions[0].words, "Probably: x");
  assert.equal("score" in lone[id(2)], false, "no score");
});

test("the fold line says who evaluates", () => {
  const said = (names, anyOn = true) => foldLine(names, anyOn).map(([t, b]) => (b ? `<b>${t}</b>` : t)).join("");
  assert.equal(said([], false), "No evaluator is on");
  assert.equal(said([], true), "No evaluator has a question yet");
  assert.equal(said(["Kind"]), "Evaluated by <b>Kind</b>");
  assert.equal(said(["Kind", "Short"]), "Evaluated by <b>Kind</b> and <b>Short</b>");
  assert.equal(said(["Kind", "Short", "Clear"]), "Evaluated by 3 evaluators");
});

test("the list starts folded as the page says, unless this browser remembers the user's own fold", () => {
  assert.equal(foldedAtStart(true, null), true);
  assert.equal(foldedAtStart(false, null), false);
  assert.equal(foldedAtStart(true, "false"), false);
  assert.equal(foldedAtStart(false, "true"), true);
  assert.equal(foldedAtStart(false, "nonsense"), false);
});

test("error replies come in the kinds the user tells apart", () => {
  assert.equal(errorKind("signed-out"), "signed-out");
  assert.equal(errorKind("no-key"), "key");
  assert.equal(errorKind("bad-key"), "key");
  for (const e of ["rate-limited", "overloaded", "busy"]) assert.equal(errorKind(e), "busy");
  for (const e of ["invalid", "unavailable", "no-answerer", undefined]) assert.equal(errorKind(e), "failed");
  assert.equal(errorKind("used-up", true), "used-up");
  for (const e of ["no-key", "bad-key", "paused"]) assert.equal(errorKind(e, true), "paused");
  assert.equal(errorKind("blocked", true), "blocked", "a blocked guest is told the trial has ended");
  assert.equal(errorKind("busy", true), "busy", "a guest is told busy like anyone");
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

// Jev answers each request when the test settles it, in the order asked.
const runner = async (replies = () => ANSWERS, freeUse, extra = {}) => {
  const pending = [];
  const decided = [];
  let open = 0;
  let most = 0;
  const s = await start({
    ...extra,
    freeUse,
    kept: { [A]: MIXED, [B]: [] },
    decide: (payload) => {
      decided.push(payload);
      most = Math.max(most, ++open);
      const n = decided.length;
      return new Promise((resolve, reject) =>
        pending.push(() => {
          open--;
          const r = replies(n, payload);
          return r instanceof Error ? reject(r) : resolve(r);
        }),
      );
    },
  });
  const settle = async () => (pending.shift()(), await flush());
  return { ...s, decided, settle, most: () => most };
};

const lineResults = (status, line, at, extra = {}) => ({ at, line, status, results: {}, error: null, ...extra });

const ONE = {
  [id(1)]: {
    questions: [
      { id: Q(1), kind: "yesno", question: "Is it kind?", top: "yes", words: "Yes", tone: null, glyph: null, sure: true, also: null, meaning: null, expected: null, p: 0.93 },
      {
        id: Q(4),
        kind: "pick",
        question: "Which tone?",
        top: O(2),
        words: "Probably: Angry",
        tone: null,
        glyph: null,
        sure: false,
        also: null,
        meaning: null,
        expected: null,
        probabilities: [{ id: O(2), p: 0.6 }, { id: O(1), p: 0.4 }],
      },
    ],
  },
  [id(5)]: {
    questions: [
      { id: Q(10), kind: "pick", question: null, top: O(8), words: "Left", tone: null, glyph: null, sure: true, also: null, meaning: null, expected: null, probabilities: [{ id: O(8), p: 0.8 }] },
    ],
  },
};

test("a text is judged line by line: blank lines are skipped and each keeps its line number", () => {
  assert.deepEqual(lines("  First \n\n   \nSecond\nThird  "), [
    { at: 1, line: "First" },
    { at: 4, line: "Second" },
    { at: 5, line: "Third" },
  ]);
  assert.deepEqual(lines(" \n "), []);
});

const statuses = (ctx) => runsOf(ctx()).map((r) => r.status);

test("a finished line is asked once, one at a time, and remembered; a line not finished is not asked", async () => {
  const memory = new Map();
  const { actor, ctx, decided, settle, most } = await runner(undefined, undefined, { memory: { get: (k) => memory.get(k), put: (k, v) => memory.set(k, v) } });
  actor.send({ type: "_type", text: "Hello\n\nWorld" });
  assert.equal(decided.length, 0, "typing alone asks nothing");
  assert.deepEqual(statuses(ctx), ["new", "new"]);
  actor.send({ type: "_finish", lines: ["Hello "] });
  assert.equal(decided.length, 1);
  assert.deepEqual(decided[0], request("Hello", MIXED));
  actor.send({ type: "_finish", lines: ["World", "Hello"] });
  assert.deepEqual(statuses(ctx), ["asking", "waiting"]);
  assert.equal(decided.length, 1, "never two at once");
  await settle();
  assert.deepEqual(decided[1], request("World", MIXED));
  await settle();
  assert.deepEqual(runsOf(ctx()), [lineResults("done", "Hello", 1, { results: ONE }), lineResults("done", "World", 3, { results: ONE })]);
  assert.equal(most(), 1, "never two requests at once");
  actor.send({ type: "_finish", lines: ["Hello"] });
  assert.equal(decided.length, 2, "a line already answered is not asked again");
  assert.equal(memory.size, 4, "one answer per evaluator and line");

  // Another page with the same memory shows the marks and asks nothing.
  const again = await runner(() => assert.fail("nothing is asked"), undefined, {
    memory: { get: (k) => memory.get(k), put: () => assert.fail("nothing is kept") },
    texts: { read: () => "Hello\n\nWorld", write: () => {} },
  });
  assert.deepEqual(runsOf(again.ctx()).map((r) => [r.status, Object.keys(r.results)]), [["done", [id(1), id(5)]], ["done", [id(1), id(5)]]]);
  again.actor.send({ type: "_finish", all: true });
  assert.equal(again.decided.length, 0);
});

test("a paste finishes every line; Stop shows while two or more wait and asks no more", async () => {
  const { actor, ctx, decided, settle } = await runner();
  actor.send({ type: "_type", text: "One\nTwo\nThree" });
  actor.send({ type: "_finish", lines: ["One", "Two", "Three"] });
  assert.deepEqual(statuses(ctx), ["asking", "waiting", "waiting"]);
  assert.equal(waiting(ctx()), 3);
  assert.equal(stoppable(ctx()), true);
  await settle();
  assert.equal(stoppable(ctx()), true, "one asked and one waiting are two");
  actor.send({ type: "_stop" });
  assert.equal(stoppable(ctx()), false);
  await settle();
  assert.deepEqual(statuses(ctx), ["done", "done", "new"]);
  assert.equal(decided.length, 2, "the line in flight is answered, the rest is not asked");
  actor.send({ type: "_finish", all: true });
  assert.equal(decided.length, 3, "leaving the box finishes every line");
  assert.equal(decided[2].state.text, "Three");
});

test("a deleted or edited line loses its marks; one waiting is not asked", async () => {
  const { actor, ctx, decided, settle } = await runner();
  actor.send({ type: "_type", text: "One\nTwo" });
  actor.send({ type: "_finish", lines: ["One", "Two"] });
  actor.send({ type: "_type", text: "One" });
  await settle();
  assert.deepEqual(statuses(ctx), ["done"]);
  assert.equal(decided.length, 1, "Two left the box before its turn");
  actor.send({ type: "_type", text: "One more" });
  assert.deepEqual(runsOf(ctx()).map((r) => Object.keys(r.results).length), [0]);
});

test("a failed line says why, stops what waits, and is asked again once finished again", async () => {
  const { actor, ctx, decided, settle } = await runner((n) => (n === 2 ? { error: "no-key" } : ANSWERS));
  actor.send({ type: "_type", text: "One\nTwo\nThree" });
  actor.send({ type: "_finish", lines: ["One", "Two", "Three"] });
  await settle();
  await settle();
  assert.equal(decided.length, 2, "line 3 is not asked");
  assert.deepEqual(runsOf(ctx()), [
    lineResults("done", "One", 1, { results: ONE }),
    lineResults("failed", "Two", 2, { error: "key" }),
    lineResults("new", "Three", 3),
  ]);
  actor.send({ type: "_finish", lines: ["Two"] });
  assert.deepEqual(statuses(ctx), ["done", "asking", "new"]);
});

test("a guest made by the first check without a guest key is told trials are paused, not to add a key", async () => {
  const { actor, ctx, settle } = await runner(() => ({ error: "no-key" }));
  actor.send({ type: "_type", text: "One" });
  actor.send({ type: "_finish", lines: ["One"] });
  // session.changed reaches the list before llm's reply, since llm makes the guest first.
  actor.send({ type: "session.changed", userId: "g1", registrationOpen: true, guest: true, name: "Guest 1" });
  await settle();
  assert.deepEqual(runsOf(ctx()).map((r) => [r.status, r.error]), [["failed", "paused"]]);
  assert.equal(notice(ctx()), "paused");
});

test("a request that throws fails its line as one Jev could not answer", async () => {
  const { actor, ctx, settle } = await runner(() => new Error("down"));
  actor.send({ type: "_type", text: "One\nTwo" });
  actor.send({ type: "_finish", lines: ["One", "Two"] });
  await settle();
  assert.deepEqual(runsOf(ctx()).map((r) => [r.status, r.error]), [["failed", "failed"], ["new", null]]);
});

test("nothing switched on with a question to ask asks nothing", async () => {
  const decided = [];
  const { actor } = await start({ kept: { [A]: [MIXED[1], MIXED[3]] }, decide: (p) => (decided.push(p), Promise.resolve(ANSWERS)) });
  actor.send({ type: "_type", text: "Hello" });
  actor.send({ type: "_finish", lines: ["Hello"] });
  assert.deepEqual(decided, []);
});

const kept = (ctx) => runsOf(ctx()).map((r) => Object.keys(r.results));

test("a change to what an evaluator asks takes its marks and checks every line again once it settles; a rename asks nothing", async () => {
  const clock = new SimulatedClock();
  const { actor, ctx, decided, settle } = await runner(undefined, undefined, { clock });
  actor.send({ type: "_type", text: "One\nTwo\nThree" });
  actor.send({ type: "_finish", lines: ["One", "Two"] });
  await settle();
  await settle();
  assert.deepEqual(kept(ctx), [[id(1), id(5)], [id(1), id(5)], []]);
  actor.send({ type: "evaluator.changed", evaluator: { ...MIXED[0], name: "Renamed", version: 2, position: MIXED[0].position } });
  assert.deepEqual(statuses(ctx), ["done", "done", "new"], "a rename asks nothing");
  const cruel = { ...MIXED[0], questions: [yesno(1, "Is it cruel?")] };
  actor.send({ type: "evaluator.changed", evaluator: cruel });
  assert.deepEqual(kept(ctx), [[id(5)], [id(5)], []], "its marks go at once");
  assert.deepEqual(statuses(ctx), ["waiting", "waiting", "waiting"], "every line waits to be checked again");
  clock.increment(RECHECK_MS - 1);
  await flush();
  assert.equal(decided.length, 2, "nothing is asked while the change may go on");
  clock.increment(1);
  await flush();
  assert.equal(decided.length, 3);
  assert.deepEqual(decided[2], request("One", [cruel]), "only the changed evaluator is asked");
  await settle();
  await settle();
  await settle();
  assert.deepEqual(kept(ctx), [[id(1), id(5)], [id(1), id(5)], [id(1), id(5)]], "every line, the one never finished too");
  actor.send({ type: "evaluator.deleted", id: id(1), book: A });
  assert.deepEqual(kept(ctx), [[id(5)], [id(5)], [id(5)]]);
});

test("switching a question off takes only that evaluator's marks; on again shows them without asking", async () => {
  const clock = new SimulatedClock();
  const { actor, ctx, decided, settle } = await runner(undefined, undefined, { clock });
  actor.send({ type: "_type", text: "Hello" });
  actor.send({ type: "_finish", lines: ["Hello"] });
  await settle();
  const [first] = MIXED;
  const off = { ...first, questions: first.questions.map((x) => (x.id === Q(1) ? { ...x, on: false } : x)) };
  actor.send({ type: "evaluator.changed", evaluator: off });
  assert.deepEqual(kept(ctx), [[id(5)]]);
  clock.increment(RECHECK_MS);
  await flush();
  assert.deepEqual(decided[1].questions.map((x) => x.id), [qid(id(1), Q(4))], "asked again with what it now asks");
  await settle();
  actor.send({ type: "evaluator.changed", evaluator: first });
  clock.increment(RECHECK_MS);
  await flush();
  assert.deepEqual(kept(ctx), [[id(1), id(5)]]);
  assert.equal(decided.length, 2, "the evaluator as it was is remembered");
  // A question already off, or one never asked, changes nothing asked.
  const unasked = { ...first, questions: first.questions.map((x) => (x.id === Q(3) ? { ...x, on: false } : x)) };
  actor.send({ type: "evaluator.changed", evaluator: unasked });
  assert.deepEqual(statuses(ctx), ["done"]);
});

test("another book drops what waits and the text", async () => {
  const { actor, ctx, settle } = await runner();
  actor.send({ type: "_type", text: "Hello\nWorld" });
  actor.send({ type: "_finish", lines: ["Hello", "World"] });
  await settle();
  actor.send({ type: "subject.changed", subject: book(A) });
  assert.equal(ctx().text, "Hello\nWorld");
  actor.send({ type: "subject.changed", subject: book(B) });
  await flush();
  assert.equal(ctx().text, "");
  assert.deepEqual(runsOf(ctx()), []);
  assert.deepEqual([ctx().queue, ctx().asking], [[], null]);
});

test("the text is kept per book and comes back after a reload", async () => {
  const kept = {};
  const texts = { read: (b) => kept[b] ?? "", write: (b, text) => (text ? (kept[b] = text) : delete kept[b]) };
  const first = await start({ texts, kept: { [A]: [], [B]: [] } });
  first.actor.send({ type: "_type", text: "One\n\nTwo" });
  assert.deepEqual(kept, { [A]: "One\n\nTwo" });
  first.actor.send({ type: "subject.changed", subject: book(B) });
  await flush();
  assert.equal(first.ctx().text, "", "another book shows its own text");
  first.actor.send({ type: "_type", text: "Other" });
  first.actor.send({ type: "subject.changed", subject: book(A) });
  await flush();
  assert.equal(first.ctx().text, "One\n\nTwo", "coming back shows the book's text");
  first.actor.stop();
  const again = await start({ texts, kept: { [A]: [], [B]: [] } });
  assert.equal(again.ctx().text, "One\n\nTwo", "a reload shows the text last typed");
  again.actor.send({ type: "_type", text: "" });
  assert.deepEqual(kept, { [B]: "Other" }, "an emptied box keeps nothing");
});

test("a guest out of free use, or paused, is not checked, and the message under the box says why", async () => {
  assert.equal(freeStop(null), null);
  assert.equal(freeStop({ left: 0.66, blocked: false, paused: [] }), null);
  assert.equal(freeStop({ left: 0, blocked: false, paused: ["jev"] }), "used-up");
  assert.equal(freeStop({ left: 0.4, blocked: false, paused: ["jev"] }), "paused");
  assert.equal(freeStop({ left: 0.4, blocked: false, paused: ["anthropic"] }), null, "another provider paused leaves Jev");
  assert.equal(freeStop({ left: 0.4, blocked: true, paused: [] }), "blocked");
  assert.equal(freeStop({ left: 0, blocked: true, paused: ["jev"] }), "blocked", "blocked says so before anything else");

  const { actor, ctx, decided } = await runner(undefined, { left: 0, blocked: false, paused: [] });
  actor.send({ type: "_type", text: "One" });
  actor.send({ type: "_finish", lines: ["One"] });
  await flush();
  assert.deepEqual(decided, [], "nothing is asked");
  assert.equal(notice(ctx()), "used-up");
  actor.send({ type: "llm.changed", signedIn: true, freeUse: { left: 0.5, blocked: false, paused: [] } });
  assert.equal(notice(ctx()), null, "a picture with use left clears it");
  assert.equal(decided.length, 1, "and the line waiting is asked");
});

test("a request refused as used up says so under the box, not on the line", async () => {
  const { actor, ctx, settle } = await runner(() => ({ error: "used-up" }), { left: 0.01, blocked: false, paused: [] });
  actor.send({ type: "_type", text: "One" });
  actor.send({ type: "_finish", lines: ["One"] });
  await settle();
  assert.deepEqual(runsOf(ctx()).map((r) => [r.status, r.error]), [["failed", "used-up"]]);
  assert.equal(notice(ctx()), "used-up");
});

test("the line under a name counts only the questions Run would ask", () => {
  const empty = { ...q(2), text: "  " };
  const lonePick = { ...q(3), kind: "pick", options: [{ id: "o1", name: "Only" }] };
  const pick = { ...q(4), kind: "pick", options: [{ id: "o1", name: "Yes" }, { id: "o2", name: "No" }] };
  assert.equal(subtitle(evaluator(1, A, { questions: [empty] })), "0 questions", "an empty question is not counted");
  assert.equal(subtitle(evaluator(1, A, { questions: [q(1), empty, lonePick, pick] })), "2 questions");
  assert.equal(subtitle(evaluator(1, A, { questions: [q(1), { ...q(5), on: false }] })), "1 question");
});

// --- The marks and the panel ----------------------------------------------------------

const GOAL = [
  option(1, "Behavioral Goal", { icon: "footprints", description: "What do I want to do?\nSomething to start, do more of, or do differently." }),
  option(2, "Emotional Goal", { icon: "heart" }),
  option(3, "Vague Goal"),
];
const kindOf = pick(20, "Which kind of goal?", GOAL, { expect: O(1) });
const said = (probabilities) => results([{ id: id(9), questions: [kindOf] }], [{ id: qid(id(9), Q(20)), p: probabilities[0].p, choice: probabilities[0].id, probabilities }])[id(9)].questions[0];

test("an answer says whether it is sure, what else was close, what the option means and what was expected", () => {
  const sure = said([{ id: O(1), p: 0.9 }, { id: O(2), p: 0.1 }]);
  assert.deepEqual([sure.words, sure.sure, sure.also, sure.meaning, sure.expected], ["Behavioral Goal", true, null, "What do I want to do?", "Behavioral Goal"]);
  const between = said([{ id: O(2), p: 0.5 }, { id: O(1), p: 0.4 }, { id: O(3), p: 0.1 }]);
  assert.deepEqual([between.words, between.sure, between.also, between.meaning], ["Between: Emotional Goal and Behavioral Goal", false, "Behavioral Goal", null]);
  const unclear = said([{ id: O(3), p: 0.4 }, { id: O(2), p: 0.2 }, { id: O(1), p: 0.2 }]);
  assert.deepEqual([unclear.words, unclear.sure, unclear.also], ["Not clear, maybe: Vague Goal", false, "Emotional Goal"]);
  const probably = said([{ id: O(1), p: 0.6 }, { id: O(2), p: 0.3 }, { id: O(3), p: 0.1 }]);
  assert.deepEqual([probably.sure, probably.also], [false, null], "Probably names no second option");
  const yes = results([{ id: id(9), questions: [yesno(21, "Kind?", { expect: "no" })] }], [{ id: qid(id(9), Q(21)), p: 0.6 }])[id(9)].questions[0];
  assert.deepEqual([yes.words, yes.sure, yes.expected], ["Probably yes", false, "No"]);
  assert.equal(results([{ id: id(9), questions: [yesno(22, "Kind?")] }], [{ id: qid(id(9), Q(22)), p: 0.1 }])[id(9)].questions[0].sure, true, "No is sure");
});

test("the expectation is told as \"<Option>, as expected\" or \"<Option> is expected\", never as what the user expects", () => {
  assert.deepEqual(sayExpect(said([{ id: O(1), p: 0.9 }])), { text: "Behavioral Goal, as expected", tone: "right" });
  assert.deepEqual(sayExpect(said([{ id: O(2), p: 0.9 }])), { text: "Behavioral Goal is expected", tone: "wrong" });
  const yesno1 = (expect, p) => results([{ id: id(9), questions: [yesno(21, "Kind?", { expect })] }], [{ id: qid(id(9), Q(21)), p }])[id(9)].questions[0];
  assert.deepEqual(sayExpect(yesno1("yes", 0.2)), { text: "Yes is expected", tone: "wrong" });
  assert.deepEqual(sayExpect(yesno1("no", 0.2)), { text: "No, as expected", tone: "right" });
  assert.equal(sayExpect(yesno1(undefined, 0.2)), null, "nothing expected, nothing said");
});

const run = (at, line, status, answers = []) => ({ at, line, status, error: null, results: answers.length ? { [id(9)]: { questions: answers } } : {} });

test("a line's marks: a dot while asked, then one per answer, its icon or a check or warning, faded when unsure", () => {
  assert.deepEqual(marksOf(run(1, "A", "waiting")), []);
  assert.deepEqual(marksOf(run(1, "A", "asking")), [{ pending: true, label: "Asking Jev" }]);
  assert.deepEqual(marksOf({ ...run(1, "A", "failed"), error: "busy" }), []);
  const wrong = said([{ id: O(3), p: 0.5 }, { id: O(2), p: 0.4 }]);
  const plain = results([{ id: id(9), questions: [yesno(22, "Kind?"), yesno(23, "Short?")] }], [
    { id: qid(id(9), Q(22)), p: 0.9 },
    { id: qid(id(9), Q(23)), p: 0.6 },
  ])[id(9)].questions;
  assert.deepEqual(marksOf(run(1, "A", "done", [said([{ id: O(1), p: 0.9 }]), wrong, ...plain])), [
    { icon: "footprints", tone: "right", sure: true, label: "Behavioral Goal" },
    { icon: "warning", tone: "wrong", sure: false, label: "Between: Vague Goal and Emotional Goal" },
    { icon: "check", tone: null, sure: true, label: "Kind? Yes" },
    { icon: "check", tone: null, sure: false, label: "Short? Probably yes" },
  ]);
});

test("the tally counts the lines evaluated and, when something is expected, those as expected", () => {
  const right = said([{ id: O(1), p: 0.9 }]);
  const wrong = said([{ id: O(2), p: 0.9 }]);
  const runs = [run(1, "A", "done", [right]), run(2, "B", "done", [wrong]), run(3, "C", "done", [right]), run(4, "D", "asking"), run(5, "E", "waiting")];
  assert.deepEqual(tally(runs), { done: 3, total: 5, words: "3 evaluated · 2 as expected" });
  assert.equal(asExpected(runs[0]), true);
  assert.equal(asExpected(runs[1]), false);
  const plain = results([{ id: id(9), questions: [yesno(22, "Kind?")] }], [{ id: qid(id(9), Q(22)), p: 0.9 }])[id(9)].questions;
  assert.deepEqual(tally([run(1, "A", "done", plain)]), { done: 1, total: 1, words: "1 evaluated" }, "nothing expected, no second half");
});

test("the panel tells about the line just answered while running, else the line pointed at when answered", () => {
  const runs = [run(1, "A", "done"), run(3, "B", "done"), run(4, "A", "done"), run(5, "C", "asking"), run(6, "D", "waiting")];
  assert.equal(focusOf({ runs: [], running: false, picked: null }), -1, "nothing answered, no panel");
  assert.equal(focusOf({ runs: [run(1, "A", "asking")], running: true, picked: null }), -1);
  assert.equal(focusOf({ runs, running: true, picked: { at: 1, line: "A" } }), 2, "running: the line just answered, whatever is pointed at");
  assert.equal(focusOf({ runs, running: false, picked: null }), 2);
  assert.equal(focusOf({ runs, running: false, picked: { at: 3, line: "B" } }), 1);
  assert.equal(focusOf({ runs, running: false, picked: { at: 1, line: "A" } }), 0, "of two with one text, the nearer");
  assert.equal(focusOf({ runs, running: false, picked: { at: 6, line: "D" } }), 2, "a line not answered keeps the last one answered");
  assert.equal(focusOf({ runs, running: false, picked: { at: 2, line: "A edited" } }), 2);
  assert.equal(focusOf({ runs: [{ ...run(1, "A", "failed"), error: "used-up" }], running: false, picked: null }), -1, "a refusal told under the button is no line to show");
});

test("a point picks the panel's line", async () => {
  const { actor, ctx } = await runner();
  actor.send({ type: "_type", text: "One" });
  actor.send({ type: "_point", at: 1, line: " One " });
  assert.deepEqual(ctx().picked, { at: 1, line: "One" });
});

// --- The list: its order and Vim's keys (12) ----------------------------------------------

const placed = (n, position, extra = {}) => ({ ...evaluator(n, A, extra), position });
const ORDERED = [placed(1, "V"), placed(2, "a"), placed(3, "b")];
const shownIds = (ctx) => rows(ctx().evaluators).map((e) => e.id);

test("the rows follow the places the fact gives, one without a place after them by id", async () => {
  const { actor, ctx } = await start({ kept: { [A]: [placed(3, "b"), evaluator(5, A), placed(1, "V"), evaluator(4, A)] } });
  assert.deepEqual(shownIds(ctx), [id(1), id(3), id(4), id(5)]);
  actor.send({ type: "evaluator.changed", evaluator: placed(5, "0V") });
  assert.deepEqual(shownIds(ctx), [id(5), id(1), id(3), id(4)]);
});

test("dd cuts a row and p puts it between neighbours; u puts a cut row back; New evaluator is never cut", async () => {
  const { actor, ctx, emitted } = await start({ kept: { [A]: ORDERED } });
  actor.send({ type: "_cut", id: D1 });
  assert.equal(ctx().cut, null, "New evaluator stays put");
  actor.send({ type: "_cut", id: id(1) });
  assert.deepEqual(ctx().cut, { id: id(1), name: "Evaluator 1" });
  actor.send({ type: "_paste", after: id(2), before: id(3) });
  assert.equal(ctx().cut, null);
  assert.deepEqual(shownIds(ctx), [id(2), id(1), id(3)], "shown there at once");
  assert.deepEqual(emitted.at(-1), { type: "evaluator.moved", id: id(1), after: id(2), before: id(3) });
  actor.send({ type: "_cut", id: id(3) });
  actor.send({ type: "_uncut" });
  assert.equal(ctx().cut, null);
  assert.equal(emitted.filter((e) => e.type === "evaluator.moved").length, 1);
  valid(emitted);
});

test("Escape on a cut row counts down on the row; u takes it back; its end deletes it, with no corner notice", async () => {
  const clock = new SimulatedClock();
  const { actor, ctx, emitted } = await start({ kept: { [A]: ORDERED }, clock, undoMs: 3000 });
  actor.send({ type: "_cut", id: id(2) });
  actor.send({ type: "_escape" });
  assert.deepEqual([...ctx().discarding.keys()], [id(2)]);
  actor.send({ type: "_undo", id: id(2) });
  assert.equal(ctx().discarding.size, 0);
  clock.increment(3000);
  assert.equal(emitted.filter((e) => e.type === "removal.started").length, 0, "taken back, nothing goes");
  actor.send({ type: "_cut", id: id(2) });
  actor.send({ type: "_escape" });
  clock.increment(3000);
  assert.deepEqual(emitted.at(-1), { type: "evaluator.discarded", id: id(2) });
  assert.equal(emitted.filter((e) => e.type === "removal.started").length, 0, "one Undo: no corner notice");
  assert.equal(ctx().discarding.size, 0);
  // A row already cut, cut again over, counts down too and ends the same way.
  actor.send({ type: "_cut", id: id(1) });
  actor.send({ type: "_cut", id: id(3) });
  assert.deepEqual([...ctx().discarding.keys()], [id(1)]);
  clock.increment(3000);
  assert.deepEqual(emitted.at(-1), { type: "evaluator.discarded", id: id(1) });
  assert.equal(emitted.filter((e) => e.type === "removal.started").length, 0);
  valid(emitted);
});

test("the keyboard leaving the list, or a row opened, hands a cut or a countdown to the corner notice", async () => {
  const clock = new SimulatedClock();
  const { actor, ctx, emitted } = await start({ kept: { [A]: ORDERED }, clock });
  actor.send({ type: "_cut", id: id(1) });
  actor.send({ type: "_escape" });
  actor.send({ type: "_cut", id: id(2) });
  actor.send({ type: "_left" });
  assert.deepEqual(emitted.filter((e) => e.type === "removal.started").map((e) => e.id), [id(1), id(2)]);
  assert.deepEqual([ctx().cut, ctx().discarding.size], [null, 0]);
  clock.increment(5000);
  assert.equal(emitted.filter((e) => e.type === "removal.started").length, 2, "its own timer is gone");
  assert.equal(emitted.filter((e) => e.type === "evaluator.discarded").length, 0, "the notice decides now");
  actor.send({ type: "_cut", id: id(3) });
  actor.send({ type: "_pick", id: D1 });
  assert.deepEqual(emitted.slice(-2).map((e) => e.type), ["removal.started", "evaluator.selected"]);
  valid(emitted);
});

test("o or O opens a new evaluator, which goes where it was started once it exists", async () => {
  const { actor, emitted } = await start({ kept: { [A]: ORDERED } });
  actor.send({ type: "_place", after: id(1), before: id(2) });
  assert.deepEqual(emitted.at(-1), { type: "evaluator.selected", id: D1, book: A });
  actor.send({ type: "evaluator.changed", evaluator: { ...evaluator(9, A), id: D1, position: "1" } });
  assert.deepEqual(emitted.at(-1), { type: "evaluator.moved", id: D1, after: id(1), before: id(2) });
  actor.send({ type: "evaluator.changed", evaluator: { ...evaluator(9, A), id: D1, position: "W" } });
  assert.equal(emitted.filter((e) => e.type === "evaluator.moved").length, 1, "only once");
  valid(emitted);
});

const SIGNED_IN = { userId: "u1", registrationOpen: false, guest: false, name: "Ann" };
const SIGNED_OUT = { userId: null, registrationOpen: true, guest: false, name: null };

test("signed out the list asks to sign in, and nothing is checked; signed in, or with no session to ask, it shows", async () => {
  assert.equal(showing({ tryPage: false, signedIn: null }), "wait", "nothing until session answers");
  const out = await start({ session: SIGNED_OUT, decide: () => assert.fail("a run is not asked signed out") });
  assert.equal(showing(out.ctx()), "sign-in");
  out.actor.send({ type: "_type", text: "One line" });
  out.actor.send({ type: "_finish", all: true });
  assert.equal(out.ctx().asking, null);
  assert.equal(showing((await start({ session: SIGNED_IN })).ctx()), "show");
  assert.equal(showing((await start()).ctx()), "show", "a page without session counts as signed in");
});

test("on a try page a visitor not yet signed in sees the starters", async () => {
  const { ctx } = await start({ session: SIGNED_OUT, tryPage: true });
  assert.equal(showing(ctx()), "show");
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(1), id(4)]);
});

test("signing in brings the evaluators back without a reload, and signing out hides them again", async () => {
  const { actor, ctx } = await start({ session: SIGNED_OUT });
  assert.deepEqual(rows(ctx().evaluators).map((e) => e.id), [id(1), id(4)], "still kept while hidden");
  actor.send({ type: "session.changed", ...SIGNED_IN });
  assert.equal(showing(ctx()), "show");
  actor.send({ type: "session.changed", ...SIGNED_OUT });
  assert.equal(showing(ctx()), "sign-in");
});

// Text or a link copied in the reader goes into Vim's register (one per page), so p
// pastes it here, in any state.
test("a copied text or link goes into Vim's register", () => {
  const pushed = [];
  const actor = createActor(machine, {
    input: { ask: () => Promise.resolve({ error: "no-answerer" }), mint: () => "01K7TEST0000000000000E0001", pushRegister: (text) => pushed.push(text) },
  }).start();
  actor.send({ type: "text.copied", text: "One.\n\nTwo." });
  actor.send({ type: "link.copied", id: "01K7TEST0000000000000H0001", text: "[q](note:01K7TEST0000000000000H0001)" });
  assert.deepEqual(pushed, ["One.\n\nTwo.", "[q](note:01K7TEST0000000000000H0001)"]);
  actor.stop();
});
