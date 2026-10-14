import { setup, assign, emit, fromPromise } from "xstate";

// The view component that lists the open book's evaluators (6.4), the list of the
// Evaluators tab's list-then-item. It owns only UI state — the book it shows, the rows,
// the row last opened, and a draft id for New evaluator — and points at three facts: it
// asks subject: read for what is open and follows subject.changed, asks evaluators: list
// for the open book and follows evaluator.changed / evaluator.deleted, and asks
// settings: read for the "Vim keys" preference (12) and follows settings.changed (4.3,
// fourth rule). A pick and a tick leave as gestures (4.3, fifth rule). The
// ask and the id minting arrive through input, so this stays importable in Node.
//
// New evaluator is always the first row and always names a minted id no evaluator has
// yet, so picking it opens an empty editor under that id; once the editor saves,
// evaluator.changed brings the real row and a fresh draft is minted.
//
// The Run box asks llm: decide once for every askable question of the switched-on
// evaluators. Its results are UI state: kept here, never emitted, never saved.

export const UNTITLED = "Untitled evaluator";

const live = (items) => items.filter((x) => !x.removing);

// The rows under New evaluator: the book's evaluators, oldest first as the fact answers
// them, leaving out any whose deletion can still be undone.
export const rows = (evaluators) => live(evaluators);

// The line under an evaluator's name: its questions, leaving out any being removed, and
// "· off" when its tick is off.
export const subtitle = (evaluator) => {
  const n = live(evaluator.questions).length;
  return `${n} question${n === 1 ? "" : "s"}${evaluator.on ? "" : " · off"}`;
};

// An evaluator is kept with a book, so only a subject that is a book has evaluators.
export const bookOf = (subject) => (subject?.kind === "book" ? subject.id : null);

const filled = (s) => typeof s === "string" && s.trim() !== "";

// A pick question needs two live options with distinct names, because Jev knows an
// option by its name (llm: decide).
const pickable = (question) => {
  const names = live(question.options ?? []).map((o) => o.name.trim());
  return names.length >= 2 && names.every((n) => n !== "") && new Set(names).size === names.length;
};

const askableQuestion = (question) =>
  !question.removing && filled(question.text) && (question.kind !== "pick" || pickable(question));

// What a run asks: each shown, switched-on evaluator with its askable questions; one with
// none is not run.
export const askable = (evaluators) =>
  rows(evaluators)
    .filter((e) => e.on)
    .map((e) => ({ id: e.id, questions: e.questions.filter(askableQuestion) }))
    .filter((e) => e.questions.length > 0);

const toQuestion = (evaluatorId, question) => {
  const asked = { id: `${evaluatorId}:${question.id}`, instructions: question.text };
  if (question.kind === "pick") {
    asked.kind = "pick";
    asked.options = live(question.options).map((o) => ({
      id: o.id,
      name: o.name,
      ...(filled(o.description) ? { description: o.description } : {}),
    }));
  } else {
    if (filled(question.yes)) asked.yes = question.yes;
    if (filled(question.no)) asked.no = question.no;
  }
  return asked;
};

// The one llm: decide payload for a run.
export const request = (text, evaluators) => ({
  state: { text },
  questions: askable(evaluators).flatMap((e) => e.questions.map((q) => toQuestion(e.id, q))),
});

// An evaluator's score: the geometric mean of its yes / no answers; a pick answer does
// not count, so an evaluator with only pick questions has none.
export const score = (ps) => {
  if (ps.length === 0) return null;
  if (ps.some((p) => p <= 0)) return 0;
  return Math.exp(ps.reduce((sum, p) => sum + Math.log(p), 0) / ps.length);
};

// The answers mapped back onto the evaluators asked, keyed by evaluator id: each asked
// question's text, its label (Yes, or the picked option's name) and p, and the score.
export const results = (asked, answers) => {
  const byAnswer = new Map(answers.map((a) => [a.id, a]));
  const out = {};
  for (const e of asked) {
    const questions = [];
    for (const q of e.questions) {
      const a = byAnswer.get(`${e.id}:${q.id}`);
      if (!a) continue;
      const label = q.kind === "pick" ? live(q.options).find((o) => o.id === a.choice)?.name : "Yes";
      if (label == null) continue;
      questions.push({ id: q.id, text: q.text, kind: q.kind === "pick" ? "pick" : "yesno", label, p: a.p });
    }
    if (questions.length === 0) continue;
    out[e.id] = { score: score(questions.filter((q) => q.kind === "yesno").map((q) => q.p)), questions };
  }
  return out;
};

// The reply's error, in the four kinds the user is told apart.
export const errorKind = (error) =>
  error === "signed-out"
    ? "signed-out"
    : error === "no-key" || error === "bad-key"
      ? "key"
      : error === "rate-limited" || error === "overloaded" || error === "busy"
        ? "busy"
        : "failed";

const asks = (evaluator) => JSON.stringify(request("", [evaluator]).questions);

const without = (map, id) => {
  if (!(id in map)) return map;
  const { [id]: _, ...rest } = map;
  return rest;
};

// A different book, or none, starts the Run box afresh.
const fresh = { text: "", results: {}, asked: [], error: null, running: false };

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const remint = (context, evaluators) => (evaluators.some((e) => e.id === context.draft) ? context.mint() : context.draft);

const shownHas = (context, id) => rows(context.evaluators).some((e) => e.id === id);

// A new subject: a different book is asked for afresh; no book shows the line that
// says to open one.
const follow = (subjectOf) => [
  {
    guard: ({ context, event }) => bookOf(subjectOf(event)) === context.book,
    actions: assign({ subject: ({ event }) => subjectOf(event) }),
  },
  {
    guard: ({ event }) => bookOf(subjectOf(event)) != null,
    target: ".loading",
    actions: assign(({ event }) => ({ ...fresh, subject: subjectOf(event), book: bookOf(subjectOf(event)), evaluators: [], open: null })),
  },
  {
    target: ".idle",
    actions: assign(({ event }) => ({ ...fresh, subject: subjectOf(event), book: null, evaluators: [], open: null })),
  },
];

export const machine = setup({
  actors: {
    // The subject starting picture; subject.changed is held for this ask until its reply
    // lands (subject: read supersededBy), so it is applied after, in order.
    readSubject: fromPromise(({ input }) => (input.following ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null }))),
    // The book's evaluators; evaluator.changed / evaluator.deleted are held for this ask
    // until its reply lands, so a change that races it is applied after it.
    load: fromPromise(({ input }) => input.ask("evaluators", "list", { book: input.book })),
    // The "Vim keys" device preference (12); on a page without a settings fact the ask
    // replies no-answerer and the letters stay off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // decide is superseded by nothing, so nothing is held for it.
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
  },
}).createMachine({
  id: "evaluator-list",
  meta: {
    description:
      "Lists the evaluators kept with the open book. New evaluator is the first row and opens " +
      "an empty editor; the evaluator appears in the list once something is written in it. Each " +
      "row has a tick box that switches the evaluator on or off, its name, greyed when off, and " +
      "how many questions it has. With `subject` it follows the book open on the stage, and " +
      "another book shows that book's evaluators; while no book is open, or without `subject`, " +
      "it says to open a book. The arrow keys move between the rows, and with Vim keys on so " +
      "do j, k, gg and G; Enter opens the row. Above New evaluator, a text box and Run try " +
      "the switched-on evaluators on a text in one request to Jev; each evaluator's row then " +
      "shows each question with its answer and how likely it is, and evaluators with yes / no " +
      "questions a score, the geometric mean of those answers. Results are not saved: Clear " +
      "removes them, a change to an evaluator removes its own, and another book removes all " +
      "of them and the text. A failed run says why in one sentence.",
    kind: "view",
    emits: ["evaluator.selected", "evaluator.switched"],
    attributes: ["subject"],
    asks: ["evaluators: list", "subject: read", "settings: read", "llm: decide"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    following: Boolean(input.following),
    subject: null,
    book: null,
    evaluators: [],
    // The row last opened; UI state, so the list marks what the editor was opened on.
    open: null,
    draft: input.mint(),
    vimKeys: false,
    // The Run box (UI state): the text, whether a run is in flight, the last results by
    // evaluator id, the evaluators and questions as they were asked, and the last error.
    ...fresh,
  }),
  // The subject and settings reads run for the machine's whole life, so a book's load
  // never cancels them.
  invoke: [
    {
      src: "readSubject",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: follow(({ output }) => output?.subject ?? null),
      onError: { actions: [] },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
  ],
  initial: "idle",
  states: {
    idle: {},
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, book: context.book }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.evaluators),
            target: "ready",
            actions: assign(({ context, event }) => ({
              evaluators: event.output.evaluators,
              draft: remint(context, event.output.evaluators),
            })),
          },
          // The fact could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      initial: "waiting",
      states: {
        waiting: {
          on: {
            _run: {
              guard: ({ context }) => filled(context.text) && askable(context.evaluators).length > 0,
              target: "running",
            },
          },
        },
        running: {
          entry: assign(({ context }) => ({ running: true, error: null, asked: askable(context.evaluators) })),
          exit: assign({ running: false }),
          invoke: {
            src: "decide",
            input: ({ context }) => ({ ask: context.ask, payload: request(context.text, context.evaluators) }),
            onDone: [
              {
                guard: ({ event }) => Array.isArray(event.output?.answers),
                target: "waiting",
                actions: assign(({ context, event }) => ({ results: results(context.asked, event.output.answers), asked: [] })),
              },
              {
                target: "waiting",
                actions: assign(({ event }) => ({ error: errorKind(event.output?.error), asked: [] })),
              },
            ],
            onError: { target: "waiting", actions: assign({ error: "failed", asked: [] }) },
          },
        },
      },
      on: {
        _type: { actions: assign({ text: ({ event }) => (typeof event.text === "string" ? event.text : "") }) },
        _clear: { actions: assign({ results: {}, error: null }) },
        // The gestures (7.2: internal messages from the view). A pick names a shown
        // evaluator or the draft; a tick names a shown evaluator and changes it.
        _pick: {
          guard: ({ context, event }) => event.id === context.draft || shownHas(context, event.id),
          actions: [
            assign(({ event }) => ({ open: event.id })),
            emit(({ context, event }) => ({ type: "evaluator.selected", id: event.id, book: context.book })),
          ],
        },
        _switch: {
          guard: ({ context, event }) =>
            typeof event.on === "boolean" && rows(context.evaluators).some((e) => e.id === event.id && e.on !== event.on),
          actions: emit(({ event }) => ({ type: "evaluator.switched", id: event.id, on: event.on })),
        },
      },
    },
    failed: {},
  },
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "subject.changed": follow(({ subject }) => subject ?? null),
    // The fact's news (4.3, fourth rule), for the book shown only.
    "evaluator.changed": {
      guard: ({ context, event }) => event.evaluator.book === context.book,
      actions: assign(({ context, event }) => {
        const evaluators = [...context.evaluators.filter((e) => e.id !== event.evaluator.id), event.evaluator].sort(byId);
        // When what it would ask changed (its questions, or its tick), its answers no
        // longer match, so its result goes, and so does an answer still on its way. A
        // rename or the server's acknowledgement keeps them.
        const before = context.evaluators.find((e) => e.id === event.evaluator.id);
        const keep = before && asks(before) === asks(event.evaluator);
        return {
          evaluators,
          draft: remint(context, evaluators),
          ...(keep
            ? {}
            : {
                results: without(context.results, event.evaluator.id),
                asked: context.asked.filter((e) => e.id !== event.evaluator.id),
              }),
        };
      }),
    },
    "evaluator.deleted": {
      actions: assign(({ context, event }) => ({
        evaluators: context.evaluators.filter((e) => e.id !== event.id),
        open: context.open === event.id ? null : context.open,
        results: without(context.results, event.id),
        asked: context.asked.filter((e) => e.id !== event.id),
      })),
    },
  },
});
