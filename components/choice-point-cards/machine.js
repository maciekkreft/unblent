import { setup, assign, enqueueActions, fromPromise, spawnChild, stopChild } from "xstate";

// The view component that shows the choice points of the journal day on the page (6.4).
// It owns only UI state — the day shown, that day's choice points as the fact last
// announced them, which ones are open, their drafts, and which wait to be saved — and
// points at one fact for them: it asks choice-points: list for the shown day and
// follows choice-point.changed / choice-point.deleted after (4.3, fourth rule). The day
// comes from day.shown, so the rule for which day the journal shows stays in
// journal-entry. Writing leaves as choice-point.saved, at a throttle while typing and at
// once on blur or Done (4.3, third rule); a delete leaves as removal.started, and
// `choice-points` marks it until notice-stack settles or undoes it. It also asks
// settings: read for the "Vim keys" preference (12) and follows settings.changed, and
// choice-point-checks: read for Jev's marks, following lines.checked and checks.changed;
// evaluators: list gives only the names of expected answers. The ask, the id
// minting, the clock and the throttle arrive through input, so the machine is importable
// in Node.

export const FIELDS = ["away", "towards", "situation", "thoughts"];

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the
// journal page first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const blank = (id, day) => ({ id, day, situation: "", thoughts: "", away: "", towards: "" });
const draftOf = (r) => ({ id: r.id, day: r.day, situation: r.situation, thoughts: r.thoughts, away: r.away, towards: r.towards });

export const isEmpty = (d) => FIELDS.every((k) => !d[k].trim());

const held = (context, id) => context.choicePoints.find((r) => r.id === id);

// A choice point the fact never had and with nothing written is not one yet: closing it
// keeps nothing, so there is nothing to save or delete. One the fact holds is always
// saved, so clearing its boxes is kept.
export const savable = (context, draft) => Boolean(draft) && (Boolean(held(context, draft.id)) || !isEmpty(draft));

export const draftIn = (context, id) => context.drafts.find((d) => d.id === id);

const saveOne = (enqueue, context, draft) => {
  if (savable(context, draft)) enqueue.emit({ type: "choice-point.saved", ...draft });
};

// Every open sheet with typing that waits to be saved is saved, at the throttle's end.
const saveWaiting = enqueueActions(({ context, enqueue }) => {
  for (const id of context.dirty) saveOne(enqueue, context, draftIn(context, id));
  enqueue.assign({ dirty: [] });
});

const without = (list, id) => list.filter((x) => (x.id ?? x) !== id);

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The day's choice points after one change from the fact. Another day's change passes
// by; an older version than the one held is stale (4.3), and an equal one may carry a
// new removal mark, so it is taken.
const changedList = (context, event) => {
  if (event.type === "choice-point.deleted") return context.choicePoints.filter((r) => r.id !== event.id);
  const r = event.choicePoint;
  if (r.day !== context.day) return context.choicePoints;
  const was = held(context, r.id);
  if (was && r.version < was.version) return context.choicePoints;
  return [...context.choicePoints.filter((x) => x.id !== r.id), r].sort(byId);
};

// Each open sheet follows a change only while nothing typed in it waits to be saved, so a
// change never overwrites what is on screen. One that is gone or being removed closes.
const follow = enqueueActions(({ context, event, enqueue }) => {
  const choicePoints = changedList(context, event);
  let { drafts, dirty } = context;
  for (const draft of context.drafts) {
    const record = choicePoints.find((r) => r.id === draft.id);
    if ((!record && held(context, draft.id)) || record?.removing) {
      drafts = without(drafts, draft.id);
      dirty = without(dirty, draft.id);
    } else if (record && !dirty.includes(draft.id)) drafts = drafts.map((d) => (d.id === draft.id ? draftOf(record) : d));
  }
  enqueue.assign({ choicePoints, drafts, dirty });
});

const opened = (context, event) => Boolean(draftIn(context, event.id));

const edit = assign(({ context, event }) => ({
  drafts: context.drafts.map((d) => (d.id === event.id ? { ...d, [event.field]: event.value } : d)),
  dirty: context.dirty.includes(event.id) ? context.dirty : [...context.dirty, event.id],
}));

const editable = ({ context, event }) => opened(context, event) && FIELDS.includes(event.field) && typeof event.value === "string";

// Done folds the one sheet: what typing in it still waits to save is saved first.
const fold = enqueueActions(({ context, event, enqueue }) => {
  if (context.dirty.includes(event.id)) saveOne(enqueue, context, draftIn(context, event.id));
  enqueue.assign({ drafts: without(context.drafts, event.id), dirty: without(context.dirty, event.id) });
});

// Only what is kept, or about to be, can be deleted with an Undo: what typing still
// waits to save is saved first, so the fact holds what it is about to mark. A blank new
// one just closes, because closing it already keeps nothing.
const remove = enqueueActions(({ context, event, enqueue }) => {
  const draft = draftIn(context, event.id);
  if (savable(context, draft)) {
    if (context.dirty.includes(draft.id) || !held(context, draft.id)) enqueue.emit({ type: "choice-point.saved", ...draft });
    enqueue.emit({ type: "removal.started", kind: "choice-point", id: draft.id, name: draft.situation.trim() });
  }
  enqueue.assign({ drafts: without(context.drafts, event.id), dirty: without(context.dirty, event.id) });
});

// While a box has the keyboard its blur saves that sheet at once.
const settle = enqueueActions(({ context, event, enqueue }) => {
  if (!context.dirty.includes(event.id)) return;
  saveOne(enqueue, context, draftIn(context, event.id));
  enqueue.assign({ dirty: without(context.dirty, event.id) });
});

// --- Jev's marks ----------------------------------------------------------------------
// What choice-point-checks announced is turned into marks here, so the view only draws
// them. The fact sends every answer; which ones show is decided only here, from the box's
// settings (show, when, expect, icons).

const NO_BOX = { evaluator: null, questions: [] };

// Why Jev could not check, in one plain sentence under the sheet.
export const ERROR_SENTENCES = {
  "signed-out": "Jev could not check: sign in to have your lines checked.",
  "no-key": "Jev could not check: add your Jev key in Settings.",
  "bad-key": "Jev could not check: your Jev key was refused. Check it in Settings.",
  "rate-limited": "Jev could not check: too many requests. It tries again at your next change.",
  overloaded: "Jev could not check: Jev is busy. It tries again at your next change.",
  busy: "Jev could not check: Jev is busy. It tries again at your next change.",
  invalid: "Jev could not check: the evaluator's questions could not be asked.",
  unavailable: "Jev could not be reached. It tries again at your next change.",
};

// The name of an answer the box expects, for "You expect …": Yes or No, or the pick
// option's name as the evaluator has it.
const expectedName = (evaluators, box, questionId, option) => {
  if (option === "yes") return "Yes";
  if (option === "no") return "No";
  const q = evaluators.find((e) => e.id === box.evaluator)?.questions?.find((x) => x.id === questionId);
  return q?.options?.find((o) => o.id === option)?.name || "another answer";
};

// How sure Jev is, as the mark's opacity: solid from 90% up, fading to a third at an even
// chance, so an unsure answer is seen as one without a number to read.
export const sureOf = (p) => Math.round((1 / 3 + (2 / 3) * Math.min(1, Math.max(0, (p - 0.5) / 0.4))) * 100) / 100;

// The marks one checked line gets in its box: a dot while Jev is checking, then one mark
// per shown question whose "Only when" holds. The colour comes from the expected answer:
// right, wrong, or plain when none is expected. An answer without a chosen icon (auto)
// gets a warning when it is not the expected answer and a check otherwise, also when
// nothing is expected, so every shown answer has a mark to point at; "none" shows nothing.
export function marksOf(box, line, evaluators = []) {
  if (!box?.evaluator || !line) return [];
  if (line.status === "pending") return [{ pending: true }];
  if (line.status !== "done") return [];
  const answer = (id) => line.answers.find((a) => a.question === id);
  const out = [];
  for (const q of box.questions) {
    if (!q.show) continue;
    const a = answer(q.id);
    if (!a) continue;
    if (q.when) {
      const w = answer(q.when.question);
      if (!w || w.option !== q.when.option) continue;
    }
    const tone = q.expect == null ? "plain" : a.option === q.expect ? "right" : "wrong";
    const chosen = q.icons?.[a.option] ?? "auto";
    if (chosen === "none") continue;
    out.push({
      question: q.id,
      name: a.name,
      p: a.p,
      tone,
      icon: chosen === "auto" ? (tone === "wrong" ? "warning" : "check") : chosen,
      expected: q.expect == null ? null : expectedName(evaluators, box, q.id, q.expect),
      sure: sureOf(a.p),
    });
  }
  return out;
}

// What the status line says about one line's marks, short: the name of each answer, and
// for one that is not expected, the answer that is; both answers go on the one line.
export function sayMarks(marks) {
  if (!marks.length) return null;
  if (marks[0].pending) return "Jev is checking…";
  return marks.map((m) => (m.tone === "wrong" ? `${m.name} · you expect ${m.expected}` : m.name)).join(" · ");
}

const reportOf = (context, id) => context.checks.reports[id];
const boxOf = (context, field) => context.checks.settings?.[field] ?? NO_BOX;

// The checked lines of one box of a choice point, each with its marks, for the view to
// put at the end of the line of the same text. A line whose text has changed since it was
// checked matches none, so it shows no mark until it is checked again.
export function boxMarks(context, id, field) {
  const box = boxOf(context, field);
  const lines = reportOf(context, id)?.lines ?? [];
  return lines
    .filter((l) => l.field === field)
    .map((l) => ({ text: l.text, marks: marksOf(box, l, context.evaluators) }))
    .filter((l) => l.marks.length);
}

// The folded card's warning: for each move it shows, whether a line written there now is
// not the answer the box expects.
export function cardWarnings(context, record) {
  const out = {};
  for (const field of ["situation", "away", "towards"]) {
    const written = new Set(record[field].split("\n"));
    out[field] = boxMarks(context, record.id, field).some((l) => written.has(l.text) && l.marks.some((m) => m.tone === "wrong"));
  }
  return out;
}

// The status line under an open sheet: Jev's answers about the line the pointer is over,
// the mark last tapped, or the line the text cursor is on, in that order; otherwise
// Saving… or Saved as before, with why Jev could not check when it could not.
export function statusOf(context, id) {
  const { pointed } = context;
  const draft = draftIn(context, id);
  if (!draft) return "";
  for (const at of [pointed.hover, pointed.tap, pointed.cursor]) {
    if (!at || at.id !== draft.id) continue;
    if (!draft[at.field].split("\n").includes(at.text)) continue;
    const line = boxMarks(context, draft.id, at.field).find((l) => l.text === at.text);
    const said = line && sayMarks(line.marks);
    if (said) return said;
  }
  if (context.dirty.includes(id)) return "Saving…";
  if (!savable(context, draft)) return "Kept once you write in a box";
  const error = ERROR_SENTENCES[reportOf(context, draft.id)?.error];
  return error ? `Saved. ${error}` : "Saved";
}

const POINTS = new Set(["hover", "tap", "cursor"]);

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("choice-points", "list", { day: input.day })),
    // On a page without a settings fact the ask replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // The day's checks; the day rides along so a reply for a day left meanwhile is dropped.
    checks: fromPromise(({ input }) =>
      input.ask("choice-point-checks", "read", { day: input.day }).then((reply) => ({ day: input.day, reply })),
    ),
    // Only for the names of expected answers in the status line; every book's evaluators.
    evaluators: fromPromise(({ input }) => input.ask("evaluators", "list", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "choice-point-cards",
  meta: {
    description:
      "Shows the choice points of the journal day on the page, under the day's text, in a " +
      "section headed \"Choice points\". A \"Choice point\" pill adds one to that day and opens it " +
      "in place with the keyboard in Situation: the V drawing and four boxes, Away · hooked, " +
      "Towards · unhooked, Situation, and Thoughts & feelings. The boxes grow with what is " +
      "written and take Vim's keys when Vim keys is on; Tab moves on to the next box or " +
      "button. What is written is saved a short time into typing and at once when a box " +
      "loses focus, and the sheet says Saving… or Saved. Done, or Escape, folds that sheet " +
      "into a card showing the situation and the away and towards moves, one line each; with " +
      "Vim keys on, the first Escape in a box leaves insert mode and the next one folds the " +
      "sheet. Pressing a card opens it again. Each choice point folds and unfolds on its own, " +
      "so several can be open at once. A choice point opened " +
      "and closed with nothing written is not kept. A choice point stays editable on every " +
      "day, also after the day's own text is closed. Delete shows the usual notice with Undo. " +
      "It follows the day the journal page shows from day.shown, and shows today until the " +
      "page has said. On a narrow width the V stands above the boxes. When Settings has an " +
      "evaluator check a box, Jev's marks stand at the right end of each checked line, " +
      "inside the box: a pulsing dot while Jev is checking, then a mark per shown answer, " +
      "green when it is the answer expected, red when not, uncoloured when none is " +
      "expected, solid when Jev is sure and faded when it is not; an answer given no icon " +
      "in Settings gets a check, or a warning when it is not the expected one. A line edited " +
      "since it was checked has no mark until it is checked again. The marks are not text: " +
      "they do not move the cursor or count for Vim. The answer's name, and for a red mark " +
      "the expected answer (\"Emotional Goal · you expect Behavioral Goal\"), is the mark's " +
      "hint and is said in the status line under the boxes while the pointer is over a mark, " +
      "after a mark is tapped until something else is pressed, or while the text cursor is " +
      "on a checked line; otherwise the status line says Saving… or Saved, and why Jev could " +
      "not check when it could not. A folded card shows a red warning beside the situation, " +
      "away or towards line when a line there is not the expected answer.",
    kind: "view",
    emits: ["choice-point.saved", "removal.started"],
    asks: ["choice-points: list", "settings: read", "choice-point-checks: read", "evaluators: list"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 400,
    day: dateOf(input.now()),
    choicePoints: [],
    // The open choice points' texts as typed, in the order they were opened, and the ids
    // of those whose typing waits to be saved.
    drafts: [],
    dirty: [],
    vimKeys: false,
    // What choice-point-checks last said for the shown day: the settings of the four
    // boxes, and per choice point its lines and why the last check failed.
    checks: { settings: null, reports: {} },
    evaluators: [],
    // The line whose answers the status line says, by how it was pointed at: each
    // { id, field, text } or null.
    pointed: { hover: null, tap: null, cursor: null },
  }),
  // Beside the states, so the preference arrives whatever the sheet is doing; a
  // settings.changed that races it is held until the reply lands (4.2).
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "evaluators",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ event }) => Array.isArray(event.output?.evaluators),
        actions: assign({ evaluators: ({ event }) => event.output.evaluators }),
      },
      onError: { actions: [] },
    },
  ],
  // The checks are asked per day, beside the states, so a reply is kept whatever the
  // sheet is doing; asked again, by the same id, when the day changes.
  entry: spawnChild("checks", { id: "checks", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
  initial: "loading",
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // On a page without the checks fact the reply is no-answerer and no line is marked.
    "xstate.done.actor.checks": {
      guard: ({ context, event }) => event.output?.day === context.day && Array.isArray(event.output.reply?.choicePoints),
      actions: assign({
        checks: ({ event }) => ({
          settings: event.output.reply.settings,
          reports: Object.fromEntries(event.output.reply.choicePoints.map((r) => [r.choicePoint, { lines: r.lines, error: r.error }])),
        }),
      }),
    },
    "checks.changed": { actions: assign({ checks: ({ context, event }) => ({ ...context.checks, settings: event.settings }) }) },
    "lines.checked": {
      guard: ({ context, event }) => event.day === context.day,
      actions: assign({
        checks: ({ context, event }) => ({
          ...context.checks,
          reports: { ...context.checks.reports, [event.choicePoint]: { lines: event.lines, error: event.error } },
        }),
      }),
    },
    "evaluator.changed": {
      actions: assign({
        evaluators: ({ context, event }) => [...context.evaluators.filter((e) => e.id !== event.evaluator.id), event.evaluator],
      }),
    },
    "evaluator.deleted": { actions: assign({ evaluators: ({ context, event }) => context.evaluators.filter((e) => e.id !== event.id) }) },
    // The view says which line the pointer is over, which mark was tapped, and which line
    // the text cursor is on, by sheet; a null field clears that one.
    _point: {
      guard: ({ event }) => POINTS.has(event.source),
      actions: assign({
        pointed: ({ context, event }) => ({
          ...context.pointed,
          [event.source]:
            opened(context, event) && FIELDS.includes(event.field) && typeof event.text === "string"
              ? { id: event.id, field: event.field, text: event.text }
              : null,
        }),
      }),
    },
    // Moving to another day settles the open choice points and asks for the new day's.
    "day.shown": {
      guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
      target: ".loading",
      actions: [
        saveWaiting,
        assign(({ context, event }) => ({ day: event.day, drafts: [], choicePoints: [], checks: { ...context.checks, reports: {} } })),
        stopChild("checks"),
        spawnChild("checks", { id: "checks", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
      ],
    },
  },
  states: {
    // A change the fact makes meanwhile is held for this ask and arrives once the reply
    // has landed (4.2).
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, day: context.day }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.choicePoints),
            target: "ready",
            actions: assign({ choicePoints: ({ event }) => [...event.output.choicePoints].sort(byId) }),
          },
          // The fact could not answer: an honest failure rather than an empty day.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      initial: "idle",
      on: {
        // A new one opens beside any already open; it is saved once something is written.
        _add: { actions: assign(({ context }) => ({ drafts: [...context.drafts, blank(context.mint(), context.day)] })) },
        _open: {
          guard: ({ context, event }) => {
            const r = held(context, event.id);
            return Boolean(r) && !r.removing && !opened(context, event);
          },
          actions: assign(({ context, event }) => ({ drafts: [...context.drafts, draftOf(held(context, event.id))] })),
        },
        _blur: { guard: ({ context, event }) => opened(context, event), actions: settle },
        _done: { guard: ({ context, event }) => opened(context, event), actions: fold },
        _delete: { guard: ({ context, event }) => opened(context, event), actions: remove },
        "choice-point.changed": { actions: follow },
        "choice-point.deleted": { actions: follow },
      },
      states: {
        idle: {
          on: { _edit: { guard: editable, target: "typing", actions: edit } },
        },
        // Typing within the window, in any open sheet, joins the one save at its end: a
        // throttle, not a debounce, so the targetless edits below never restart the timer.
        typing: {
          on: { _edit: { guard: editable, actions: edit } },
          after: { throttle: { target: "idle", actions: saveWaiting } },
        },
      },
    },
    failed: {},
  },
});
