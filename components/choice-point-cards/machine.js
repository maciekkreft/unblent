import { setup, assign, enqueueActions, fromPromise, spawnChild, stopChild } from "xstate";

// The view component that shows the choice points of the journal day on the page (6.4).
// It owns only UI state — the day shown, that day's choice points as the fact last
// announced them, which ones are open, their drafts, and which wait to be saved — and
// points at one fact for them: it asks choice-points: list for the shown day and
// follows choice-point.changed / choice-point.deleted after (4.3, fourth rule). The day
// comes from day.shown, so the rule for which day the journal shows stays in
// journal-entry. Writing leaves as choice-point.saved, at a throttle while typing and at
// once on blur, Done, Enter or a move to another line (4.3, third rule), the last four
// naming the lines the user finished so `choice-point-checks` checks only those; a save of four empty boxes is how `choice-points`
// learns to remove one, so no event of its own is needed for that. It also asks
// settings: read for the "Vim keys" preference (12) and follows settings.changed, and
// choice-point-checks: read for Jev's marks, following lines.checked and checks.changed;
// evaluators: list gives each question's expected answer, its options' names and icons. The ask, the id
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

// Choice points are written exactly while the day's own text is: the journal page says so
// in day.shown, which keeps yesterday open for an hour past its last edit. Before it has
// said, or from a sender that does not say, only today's date is written on. An earlier
// day's choice points open to be read.
export const writable = (context) => context.dayWritable ?? context.day === dateOf(context.now());

// Four empty boxes are never saved while the sheet is open: to `choice-points` that save
// removes a kept choice point, and the user may be clearing a box only to write it again.
export const savable = (draft) => Boolean(draft) && !isEmpty(draft);

export const draftIn = (context, id) => context.drafts.find((d) => d.id === id);

const saveOne = (enqueue, draft, finished = []) => {
  if (!savable(draft)) return false;
  enqueue.emit({ type: "choice-point.saved", ...draft, ...(finished.length ? { finished } : {}) });
  return true;
};

// The lines of a draft's boxes, each as { field, text }, that `choice-point-checks` is told
// the user has finished, so Jev checks a line only once the user has moved on from it.
export const linesOf = (draft, fields, only) =>
  fields.flatMap((field) =>
    draft[field]
      .split("\n")
      .filter((text) => text.trim() !== "" && (!only || only.includes(text)))
      .map((text) => ({ field, text })),
  );

// Every open sheet with typing that waits to be saved is saved, at the throttle's end. An
// emptied one stays waiting, so a change from the fact does not refill what was cleared.
const saveWaiting = enqueueActions(({ context, enqueue }) => {
  enqueue.assign({ dirty: context.dirty.filter((id) => !saveOne(enqueue, draftIn(context, id))) });
});

const without = (list, id) => list.filter((x) => (x.id ?? x) !== id);

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The day's choice points after one change from the fact. Another day's change passes
// by; an older version than the one held is stale (4.3), and an equal one may carry a
// new pending flag, so it is taken.
const changedList = (context, event) => {
  if (event.type === "choice-point.deleted") return context.choicePoints.filter((r) => r.id !== event.id);
  const r = event.choicePoint;
  if (r.day !== context.day) return context.choicePoints;
  const was = held(context, r.id);
  if (was && r.version < was.version) return context.choicePoints;
  return [...context.choicePoints.filter((x) => x.id !== r.id), r].sort(byId);
};

// Each open sheet follows a change only while nothing typed in it waits to be saved, so a
// change never overwrites what is on screen. One that is gone closes.
const follow = enqueueActions(({ context, event, enqueue }) => {
  const choicePoints = changedList(context, event);
  let { drafts, dirty } = context;
  for (const draft of context.drafts) {
    const record = choicePoints.find((r) => r.id === draft.id);
    if (!record && held(context, draft.id)) {
      drafts = without(drafts, draft.id);
      dirty = without(dirty, draft.id);
    } else if (record && !dirty.includes(draft.id)) drafts = drafts.map((d) => (d.id === draft.id ? draftOf(record) : d));
  }
  enqueue.assign({ choicePoints, drafts, dirty });
});

const opened = (context, event) => Boolean(draftIn(context, event.id));

// The sheets left unfolded on the day before a reload open again, in the order they were
// opened; one no longer kept, or not of this day, is skipped.
const reopened = (context, choicePoints) =>
  context.unfolded
    .read(context.day)
    .map((id) => choicePoints.find((r) => r.id === id && r.day === context.day))
    .filter(Boolean)
    .map(draftOf);

const edit = assign(({ context, event }) => ({
  drafts: context.drafts.map((d) => (d.id === event.id ? { ...d, [event.field]: event.value } : d)),
  dirty: context.dirty.includes(event.id) ? context.dirty : [...context.dirty, event.id],
}));

const typable = ({ context, event }) =>
  writable(context) && opened(context, event) && FIELDS.includes(event.field) && typeof event.value === "string";

// Done folds the one sheet: it is saved with every line finished. Folded with every box
// empty, a kept one is removed, by saving it empty; a new one was never kept, so nothing
// is sent. There is no Delete and no Undo: an empty choice point holds nothing to lose.
const fold = enqueueActions(({ context, event, enqueue }) => {
  const draft = draftIn(context, event.id);
  if (writable(context) && isEmpty(draft) && held(context, draft.id)) enqueue.emit({ type: "choice-point.saved", ...draft });
  else if (writable(context)) saveOne(enqueue, draft, linesOf(draft, FIELDS));
  enqueue.assign({ drafts: without(context.drafts, event.id), dirty: without(context.dirty, event.id) });
});

// A box losing the keyboard saves its sheet at once with every line of that box finished.
const settle = enqueueActions(({ context, event, enqueue }) => {
  const draft = draftIn(context, event.id);
  const finished = writable(context) && FIELDS.includes(event.field) ? linesOf(draft, [event.field]) : [];
  if (!context.dirty.includes(event.id) && !finished.length) return;
  if (saveOne(enqueue, draft, finished)) enqueue.assign({ dirty: without(context.dirty, event.id) });
});

// Enter, or the cursor moving to another line, finishes the lines the view names: the sheet
// is saved at once with them, so Jev checks a line as soon as the user moves on from it.
const finishLines = enqueueActions(({ context, event, enqueue }) => {
  const draft = draftIn(context, event.id);
  const finished = linesOf(draft, [event.field], event.lines);
  if (finished.length && saveOne(enqueue, draft, finished)) enqueue.assign({ dirty: without(context.dirty, event.id) });
});

// --- Jev's marks ----------------------------------------------------------------------
// What choice-point-checks announced is turned into marks here, so the view only draws
// them. The fact sends every answer; which ones show is decided only here, from the box's
// settings (show, when); its colour from the answer the evaluator's question expects, and
// its glyph from the answer's option in the evaluator.

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

// An evaluator by id, as the shown day has it; undefined when it is not known.
const evaluatorIn = (evaluators, id) => evaluators.find((e) => e.id === id);

// One evaluator's question as the evaluator has it now.
const questionOf = (evaluator, questionId) => evaluator?.questions?.find((x) => x.id === questionId);

// A pick answer's option as the evaluator has it now; none for yes or no.
const optionOf = (evaluator, questionId, option) => questionOf(evaluator, questionId)?.options?.find((o) => o.id === option);

// The answer the evaluator's question expects, while it names one still offered: yes or
// no, or an option not waiting out its undo window; null when none is expected.
const expectOf = (q) => {
  const want = q?.expect;
  if (want === "yes" || want === "no") return q.kind === "pick" ? null : want;
  return q?.kind === "pick" && q.options?.some((o) => o.id === want && !o.removing) ? want : null;
};

// The name of the answer expected, for "You expect …": Yes or No, or the pick option's
// name as the evaluator has it.
const expectedName = (evaluator, questionId, option) => {
  if (option === "yes") return "Yes";
  if (option === "no") return "No";
  return optionOf(evaluator, questionId, option)?.name || "another answer";
};

// How sure Jev is, as the mark's opacity: solid from 90% up, fading to a third at an even
// chance, so an unsure answer is seen as one without a number to read.
export const sureOf = (p) => Math.round((1 / 3 + (2 / 3) * Math.min(1, Math.max(0, (p - 0.5) / 0.4))) * 100) / 100;

// The evaluators that check a box, its own first and then the further ones in order,
// each with the box's settings for its questions.
const checkersOf = (box) =>
  [{ evaluator: box?.evaluator, questions: box?.questions ?? [] }, ...(Array.isArray(box?.also) ? box.also : [])].filter(
    (c) => typeof c?.evaluator === "string",
  );

// One mark per shown question whose "Only when" holds. The colour comes from the answer
// the evaluator's question expects: right, wrong, or plain when none is expected. The
// glyph is the icon the evaluator gives the option answered; a yes / no answer, or an
// option without one, gets a warning when it is not the expected answer and a check
// otherwise, also when nothing is expected, so every shown answer has a mark to point at.
function questionMarks(checker, evaluator, answer) {
  const out = [];
  for (const q of checker.questions) {
    if (!q.show) continue;
    const a = answer(q.id);
    if (!a) continue;
    if (q.when) {
      const w = answer(q.when.question);
      if (!w || w.option !== q.when.option) continue;
    }
    const expect = expectOf(questionOf(evaluator, q.id));
    const tone = expect == null ? "plain" : a.option === expect ? "right" : "wrong";
    const chosen = optionOf(evaluator, q.id, a.option)?.icon;
    out.push({
      question: q.id,
      name: a.name,
      p: a.p,
      tone,
      icon: chosen || (tone === "wrong" ? "warning" : "check"),
      expected: expect == null ? null : expectedName(evaluator, q.id, expect),
      sure: sureOf(a.p),
    });
  }
  return out;
}

// The value a question of Your values asks about, read from its text, which names it
// between curly quotes; the question carries no name of its own.
export const valueName = (q) => /“(.*?)”(?: \(|\?$)/.exec(q?.text ?? "")?.[1] || "one of your values";

// A combined evaluator (Your values) answers with one mark for the line, a compass:
// green when any question got the answer it expects (the line serves a value), named
// after the first such value in the evaluator's order; else red when any answer is an
// option marked as going against, named the same way; else uncoloured, Jev not able to
// tell. Its sureness is the deciding answer's, and for an uncoloured mark the least sure
// answer's, since every one of them had to miss. With no question answered, such as Your
// values with no values written, there is no mark at all: none would suggest Jev looked.
function combinedMark(evaluator, answer) {
  const answered = (evaluator.questions ?? [])
    .filter((q) => !q.removing && q.on !== false)
    .map((q) => ({ q, a: answer(q.id) }))
    .filter((x) => x.a);
  if (!answered.length) return [];
  const mark = (tone, { q, a }, name) => ({ question: q.id, combined: true, name, p: a.p, tone, icon: "compass", expected: null, sure: sureOf(a.p) });
  const served = answered.find(({ q, a }) => expectOf(q) != null && a.option === expectOf(q));
  if (served) return [mark("right", served, `Serves ${valueName(served.q)}`)];
  const against = answered.find(({ q, a }) => q.options?.some((o) => o.id === a.option && o.against));
  if (against) return [mark("wrong", against, `Goes against ${valueName(against.q)}`)];
  const least = answered.reduce((x, y) => (y.a.p < x.a.p ? y : x));
  return [mark("plain", least, "Can't tell which of your values this serves")];
}

// The marks one checked line gets in its box: a dot while Jev is checking, then the marks
// of each of the box's evaluators in turn, its own first.
export function marksOf(box, line, evaluators = []) {
  const checkers = checkersOf(box);
  if (!checkers.length || !line) return [];
  if (line.status === "pending") return [{ pending: true }];
  if (line.status !== "done") return [];
  const answer = (id) => line.answers.find((a) => a.question === id);
  return checkers.flatMap((c) => {
    const evaluator = evaluatorIn(evaluators, c.evaluator);
    return evaluator?.combined ? combinedMark(evaluator, answer) : questionMarks(c, evaluator, answer);
  });
}

// What the status line says about one line's marks, short: the name of each answer, and
// for one that is not expected, the answer that is; both answers go on the one line. A
// combined mark already says it in a sentence.
export function sayMarks(marks) {
  if (!marks.length) return null;
  if (marks[0].pending) return "Jev is checking…";
  return marks.map((m) => (m.tone === "wrong" && !m.combined ? `${m.name} · you expect ${m.expected}` : m.name)).join(" · ");
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
// not the answer its evaluator expects.
export function cardWarnings(context, record) {
  const out = {};
  for (const field of ["situation", "away", "towards"]) {
    const written = new Set(record[field].split("\n"));
    out[field] = boxMarks(context, record.id, field).some((l) => written.has(l.text) && l.marks.some((m) => m.tone === "wrong"));
  }
  return out;
}

// The status line under an open sheet: Jev's answers about the line the pointer is over,
// the mark last tapped, or the line the text cursor is on, in that order; otherwise why
// Jev could not check when it could not. Saving is not reported: it always happens.
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
  return ERROR_SENTENCES[reportOf(context, draft.id)?.error] ?? "";
}

// A derived evaluator is announced with today's questions (Your values after today's
// values were edited); on an earlier day the questions it had that day are kept, so the
// day's marks still name that day's values.
const changedOn = (context, evaluator) => {
  const was = context.evaluators.find((e) => e.id === evaluator.id);
  return evaluator.derivedFrom && was && context.day !== dateOf(context.now()) ? { ...evaluator, questions: was.questions } : evaluator;
};

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
    // Each question's expected answer and its options' names and icons; every book's
    // evaluators, a derived one (Your values) as it stood on the shown day. The day rides
    // along so a reply for a day left meanwhile is dropped.
    evaluators: fromPromise(({ input }) =>
      input.ask("evaluators", "list", { day: input.day }).then((reply) => ({ day: input.day, reply })),
    ),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "choice-point-cards",
  meta: {
    description:
      "Shows the choice points of the journal day on the page, under the day's text, in a " +
      "section headed \"Choice points\". On today's page a \"New choice point\" row after the " +
      "day's choice points, muted with a plus like the New note row, adds one and opens it in " +
      "place with the keyboard in Situation: the V drawing and four boxes, Away · hooked, " +
      "Towards · unhooked, Situation, and Thoughts & feelings. The boxes grow with what is " +
      "written and take Vim's keys when Vim keys is on, where p pastes text or a link copied in the reader with Vim keys, paragraphs kept; Tab moves on to the next box or " +
      "button. What is written is saved a short time into typing and at once when a box loses " +
      "focus; the sheet does not say so. Jev checks a line once the user has finished it and " +
      "moved on: Enter to a new line, which stands after a short gap, or Shift+Enter to one " +
      "right under it, the cursor moved to another line, the box losing focus, " +
      "or the sheet folding; the line being typed gets no mark until then. Done, or Escape, " +
      "folds that sheet into a card " +
      "showing the situation and the away and towards moves, one line each; with Vim keys on, " +
      "the first Escape in a box leaves insert mode and the next one folds the sheet. " +
      "Pressing a card opens it again. Each choice point folds and unfolds on its own, so " +
      "several can be open at once; the ones left open stay open after a reload, kept per day " +
      "in this browser. A choice point folded with all four boxes empty is " +
      "removed, also one kept before; there is no Delete button and no Undo, because an empty " +
      "one holds nothing to lose. Choice points are written exactly while the day's own text " +
      "is, as the journal page says: today's page, and yesterday's for the hour after midnight " +
      "the journal keeps it open; when that hour runs out an open sheet becomes read only. On " +
      "an earlier day there is no New choice point row, and a card opens its sheet " +
      "to be read, with boxes that cannot be typed in and a Close button instead of Done. It " +
      "follows the day the journal page shows from day.shown, and shows today until the page " +
      "has said. On a narrow width the V stands above the boxes. When Settings has an " +
      "evaluator check a box, Jev's marks stand at the right end of each checked line, inside " +
      "the box: a pulsing dot while Jev is checking, then a mark per shown answer, green when " +
      "it is the answer the evaluator's question expects, red when not, uncoloured when it " +
      "expects none, solid when " +
      "Jev is sure and faded when it is not; the mark shows the icon the evaluator gives the " +
      "option answered, and a yes / no answer or an option with no icon gets a check, or a " +
      "warning when it is not the expected one. Settings may name a further evaluator for a " +
      "box (Also check with); its marks follow the box's own. Your values, as either one, " +
      "draws one compass per line instead of a mark per value: green when the move serves " +
      "any of the values, red when it serves none and goes against one, uncoloured when Jev " +
      "can't tell, solid or faded as the answer that decided it, or the least sure answer " +
      "for an uncoloured one; with no values written there is no compass at all. Its hint " +
      "names the value: \"Serves Being a present parent\", \"Goes against Health\", or " +
      "\"Can't tell which of your values this serves\", the first value in the values' order " +
      "when several fit. An earlier day's marks name that day's values. A line edited since it was " +
      "checked has no mark until it is checked again. The marks are not text: they do not " +
      "move the cursor or count for Vim. The answer's name, and for a red mark the expected " +
      "answer (\"Emotional Goal · you expect Behavioral Goal\"), is the mark's hint and is said " +
      "in the status line under the boxes while the pointer is over a mark, after a mark is " +
      "tapped until something else is pressed, or while the text cursor is on a checked line; " +
      "otherwise the status line says why Jev could not check when it could not, and is " +
      "empty. A folded card shows a red warning beside the situation, away or towards line " +
      "when a line there has a red mark, a red compass included.",
    kind: "view",
    emits: ["choice-point.saved"],
    asks: ["choice-points: list", "settings: read", "choice-point-checks: read", "evaluators: list"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Puts text copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    mint: input.mint,
    now: input.now,
    throttleMs: input.throttleMs ?? 400,
    // Which choice points were unfolded, per day, kept by the view across reloads (3.1);
    // without it every sheet starts folded.
    unfolded: input.unfolded ?? { read: () => [] },
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
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
  ],
  // The checks and the evaluators are asked per day, beside the states, so a reply is kept
  // whatever the sheet is doing; asked again, by the same ids, when the day changes.
  entry: [
    spawnChild("checks", { id: "checks", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
    spawnChild("evaluators", { id: "evaluators", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
  ],
  initial: "loading",
  on: {
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, blocks a blank line apart as paragraphs are.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
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
    "xstate.done.actor.evaluators": {
      guard: ({ context, event }) => event.output?.day === context.day && Array.isArray(event.output.reply?.evaluators),
      actions: assign({ evaluators: ({ event }) => event.output.reply.evaluators }),
    },
    "evaluator.changed": {
      actions: assign({ evaluators: ({ context, event }) => [...context.evaluators.filter((e) => e.id !== event.evaluator.id), changedOn(context, event.evaluator)] }),
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
    // The same day closing to writing (the hour after midnight runs out) saves what was
    // typed while it was open, and the open sheets stay, now to be read.
    "day.shown": [
      {
        guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
        target: ".loading",
        actions: [
          saveWaiting,
          assign(({ context, event }) => ({
            day: event.day,
            dayWritable: typeof event.writable === "boolean" ? event.writable : null,
            drafts: [],
            dirty: [],
            choicePoints: [],
            checks: { ...context.checks, reports: {} },
          })),
          stopChild("checks"),
          spawnChild("checks", { id: "checks", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
          stopChild("evaluators"),
          spawnChild("evaluators", { id: "evaluators", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
        ],
      },
      {
        guard: ({ event }) => isDay(event.day),
        actions: [saveWaiting, assign({ dayWritable: ({ event }) => (typeof event.writable === "boolean" ? event.writable : null) })],
      },
    ],
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
            actions: assign(({ context, event }) => {
              const choicePoints = [...event.output.choicePoints].sort(byId);
              return { choicePoints, drafts: reopened(context, choicePoints) };
            }),
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
        _add: { guard: ({ context }) => writable(context), actions: assign(({ context }) => ({ drafts: [...context.drafts, blank(context.mint(), context.day)] })) },
        _open: {
          guard: ({ context, event }) => {
            const r = held(context, event.id);
            return Boolean(r) && !opened(context, event);
          },
          actions: assign(({ context, event }) => ({ drafts: [...context.drafts, draftOf(held(context, event.id))] })),
        },
        _blur: { guard: ({ context, event }) => opened(context, event), actions: settle },
        _finish: {
          guard: ({ context, event }) =>
            writable(context) && opened(context, event) && FIELDS.includes(event.field) && Array.isArray(event.lines),
          actions: finishLines,
        },
        _done: { guard: ({ context, event }) => opened(context, event), actions: fold },
        "choice-point.changed": { actions: follow },
        "choice-point.deleted": { actions: follow },
      },
      states: {
        idle: {
          on: { _edit: { guard: typable, target: "typing", actions: edit } },
        },
        // Typing within the window, in any open sheet, joins the one save at its end: a
        // throttle, not a debounce, so the targetless edits below never restart the timer.
        typing: {
          on: { _edit: { guard: typable, actions: edit } },
          after: { throttle: { target: "idle", actions: saveWaiting } },
        },
      },
    },
    failed: {},
  },
});
