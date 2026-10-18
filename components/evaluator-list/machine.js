import { setup, assign, emit, fromPromise } from "xstate";

// The view component that lists the open book's evaluators (6.4), the list of the
// Evaluators tab's list-then-item. It owns only UI state — the book it shows, the rows,
// the row the editor shows, and a draft id for New evaluator — and points at three facts: it
// asks subject: read for what is open and follows subject.changed, asks evaluators: list
// for the open book and follows evaluator.changed / evaluator.deleted, asks books: list
// for which book is the journal and what each book is called and follows book.changed /
// book.deleted, and asks settings: read for the "Vim keys" preference (12) and follows
// settings.changed (4.3, fourth rule), and asks pins: read for the book the tab is pinned
// to and follows pins.changed. Which row is open it learns only from the editor's
// evaluator.opened, never from its own pick, because the editor also opens evaluators by
// itself (another book, a reload, a pin) and one source keeps the mark right. A pick and a tick leave as gestures (4.3, fifth rule). The
// ask and the id minting arrive through input, so this stays importable in Node.
//
// New evaluator is always the first row and always names a minted id no evaluator has
// yet, so picking it opens an empty editor under that id; once the editor saves,
// evaluator.changed brings the real row and a fresh draft is minted.
//
// The Evaluate box asks llm: decide once per non-empty line of the text, for every askable
// question of the switched-on evaluators, one line after another: the decide slot takes
// one request at a time and tells a second asker "busy". Its results are UI state: kept
// here per line, never emitted, never saved.

export const UNTITLED = "Untitled evaluator";

const live = (items) => items.filter((x) => !x.removing);

// The rows under New evaluator: the book's evaluators, oldest first as the fact answers
// them, leaving out any whose deletion can still be undone.
export const rows = (evaluators) => live(evaluators);

// A question switched off in the editor is kept but not asked; one without `on` is on.
const switchedOn = (question) => question.on !== false;


// The journal lists its own evaluators and every one marked "Show in journal"; any other
// book lists only its own.
export const belongs = (book, journal, evaluator) =>
  evaluator.book === book || (book != null && book === journal && evaluator.journal === true);

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
  !question.removing && switchedOn(question) && filled(question.text) && (question.kind !== "pick" || pickable(question));

// The line under an evaluator's name: how many questions Run would ask (written,
// switched on, and for a pick question two named options), "· off" when its tick is
// off, and, for one shown in the journal from another book, that book's title.
export const subtitle = (evaluator, from = null) => {
  const n = evaluator.questions.filter(askableQuestion).length;
  return `${n} question${n === 1 ? "" : "s"}${evaluator.on ? "" : " · off"}${from == null ? "" : ` · ${from}`}`;
};

// What a run asks: each shown, switched-on evaluator with its askable, switched-on
// questions, so only those are asked; one with none is not run.
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

// The llm: decide payload for one line, from the evaluators as a run took them.
const payload = (text, asked) => ({
  state: { text },
  questions: asked.flatMap((e) => e.questions.map((q) => toQuestion(e.id, q))),
});

// The llm: decide payload for a text and the evaluators shown.
export const request = (text, evaluators) => payload(text, askable(evaluators));

// The lines a run judges, each on its own: blank ones are skipped, and each keeps its
// line number in the text.
export const lines = (text) =>
  text
    .split("\n")
    .map((line, i) => ({ at: i + 1, line: line.trim() }))
    .filter((l) => l.line !== "");

// --- The answers, in words ---------------------------------------------------------
// A line's answers are told in words, never as numbers: how sure Jev is shows in the
// wording, so a reader need not weigh a probability (Norman: one conceptual model).

// A pick answer from every option's probability, highest first (names as written): sure
// from 0.75 up; two close options are both named; otherwise how sure the top one is.
export const sayPick = (ranked) => {
  const [top, second] = ranked;
  if (!top) return "";
  if (top.p >= 0.75) return top.name;
  if (second && top.p - second.p <= 0.15) return `Between: ${top.name} and ${second.name}`;
  if (top.p >= 0.5) return `Probably: ${top.name}`;
  return `Not clear, maybe: ${top.name}`;
};

// A yes / no answer from the probability of yes; an even chance is said to be one.
export const sayYesNo = (p) =>
  p >= 0.45 && p <= 0.55 ? "Not clear" : p >= 0.75 ? "Yes" : p >= 0.5 ? "Probably yes" : p >= 0.25 ? "Probably no" : "No";

// The answer a question expects, while it names one still offered, as the choice point
// marks read it: yes or no for a yes / no question, a live option's id for a pick one.
export const expectOf = (question) => {
  const want = question.expect;
  if (question.kind === "pick") return live(question.options ?? []).some((o) => o.id === want) ? want : null;
  return want === "yes" || want === "no" ? want : null;
};

// Right or wrong against what is expected, or null when nothing is; "Between" and "Not
// clear" are compared by the top answer. The glyph is the top option's icon, else, only
// when something is expected, a check or a warning, as on a choice point's marks.
export const toneOf = (expect, top) => (expect == null ? null : top === expect ? "right" : "wrong");
export const glyphOf = (icon, tone) => icon || (tone === "right" ? "check" : tone === "wrong" ? "warning" : null);

// One question's answer for one line. A pick ranks every option by the probabilities Jev
// gave (only the picked one when it gave none); a yes / no answer's top is yes from an
// even chance up. The question's text is shown before a yes / no answer, and before a
// pick when its evaluator asked more than one question, since a lone pick names itself.
export const answerOf = (question, answer, asked = 1) => {
  if (question.kind === "pick") {
    const options = live(question.options ?? []);
    const given = Array.isArray(answer.probabilities) && answer.probabilities.length ? answer.probabilities : [{ id: answer.choice, p: answer.p }];
    const ranked = given
      .map((g) => ({ ...g, option: options.find((o) => o.id === g.id) }))
      .filter((g) => g.option)
      .sort((a, b) => b.p - a.p)
      .map((g) => ({ id: g.id, name: g.option.name, icon: g.option.icon ?? null, p: g.p }));
    if (!ranked.length) return null;
    const tone = toneOf(expectOf(question), ranked[0].id);
    return {
      id: question.id,
      kind: "pick",
      question: asked > 1 ? question.text : null,
      top: ranked[0].id,
      words: sayPick(ranked),
      tone,
      glyph: glyphOf(ranked[0].icon, tone),
      probabilities: ranked.map(({ id, p }) => ({ id, p })),
    };
  }
  const top = answer.p >= 0.5 ? "yes" : "no";
  const tone = toneOf(expectOf(question), top);
  return { id: question.id, kind: "yesno", question: question.text, top, words: sayYesNo(answer.p), tone, glyph: glyphOf(null, tone), p: answer.p };
};

// The answers mapped back onto the evaluators asked, keyed by evaluator id.
export const results = (asked, answers) => {
  const byAnswer = new Map(answers.map((a) => [a.id, a]));
  const out = {};
  for (const e of asked) {
    const questions = [];
    for (const q of e.questions) {
      const a = byAnswer.get(`${e.id}:${q.id}`);
      const said = a && answerOf(q, a, e.questions.length);
      if (said) questions.push(said);
    }
    if (questions.length > 0) out[e.id] = { questions };
  }
  return out;
};

// --- The Evaluate box ------------------------------------------------------------------

// The button's words: how many lines it would evaluate, or that it is evaluating.
export const evaluateLabel = (count, running) =>
  running ? "Evaluating…" : count === 0 ? "Evaluate" : `Evaluate ${count} line${count === 1 ? "" : "s"}`;

// The fold line's words, as [text, bold] parts: who evaluates, by name up to two.
export const foldLine = (names, anyOn) => {
  if (names.length === 0) return [[anyOn ? "No evaluator has a question yet" : "No evaluator is on", false]];
  if (names.length === 1) return [["Evaluated by ", false], [names[0], true]];
  if (names.length === 2) return [["Evaluated by ", false], [names[0], true], [" and ", false], [names[1], true]];
  return [[`Evaluated by ${names.length} evaluators`, false]];
};

// Whether the list starts folded: the user's own last fold in this browser, stored as
// "true" or "false", wins over the page's `folded`.
export const foldedAtStart = (attribute, stored) => (stored === "true" ? true : stored === "false" ? false : Boolean(attribute));

// The reply's error, in the kinds the user is told apart. A guest has no key of their
// own and no Settings to add one in (8): a guest whose own allowance is spent is told
// so, a guest the admin blocked is told the trial has ended, and any other refusal about
// free use or the guest key is told as free trials being paused, which is true for them
// and asks nothing they cannot do.
export const errorKind = (error, guest = false) =>
  error === "used-up" || error === "blocked"
    ? error
    : error === "paused" || (guest && (error === "no-key" || error === "bad-key"))
      ? "paused"
      : error === "signed-out"
        ? "signed-out"
        : error === "no-key" || error === "bad-key"
          ? "key"
          : error === "rate-limited" || error === "overloaded" || error === "busy"
            ? "busy"
            : "failed";

// Why a guest cannot run now, from llm's freeUse (7.7), or null: blocked by the admin,
// used-up once its own allowance is spent, paused while Jev is paused for every guest.
export const freeStop = (freeUse) =>
  !freeUse
    ? null
    : freeUse.blocked
      ? "blocked"
      : freeUse.left <= 0
        ? "used-up"
        : freeUse.paused.includes("jev")
          ? "paused"
          : null;

// The message under Run (try-links screen 2): what the picture says, else what the
// last run was refused for.
export const notice = (context) =>
  freeStop(context.freeUse) ?? context.runs.find((r) => STOPS.includes(r.error))?.error ?? null;

// The refusals told once under Run rather than on each line.
export const STOPS = ["used-up", "paused", "blocked"];

const asks = (evaluator) => JSON.stringify(request("", [evaluator]).questions);

const without = (map, id) => {
  if (!(id in map)) return map;
  const { [id]: _, ...rest } = map;
  return rest;
};

// A different book, or none, starts the Run box afresh.
const fresh = { text: "", runs: [], asked: [], running: false };

// An evaluator whose asks changed, or that went, loses its answers on every line.
const dropResults = (runs, id) => runs.map((r) => (id in r.results ? { ...r, results: without(r.results, id) } : r));

const settle = (runs, change) => runs.map((r) => (r.status === "asking" ? { ...r, ...change } : r));

// Another line follows only while one waits and an evaluator is still left to ask.
const more = (context) => context.asked.length > 0 && context.runs.some((r) => r.status === "waiting");

// `open` stays: the editor still shows a deleted evaluator until it opens another, and
// an undone delete brings the row back marked.
const gone = (context, id) => ({
  evaluators: context.evaluators.filter((e) => e.id !== id),
  runs: dropResults(context.runs, id),
  asked: context.asked.filter((e) => e.id !== id),
});

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const remint = (context, evaluators) => (evaluators.some((e) => e.id === context.draft) ? context.mint() : context.draft);

const shownHas = (context, id) => rows(context.evaluators).some((e) => e.id === id);

// What books says about the journal and the titles. When that changes whether the book
// shown is the journal, its evaluators are asked for again, since the journal's list
// takes in other books' marked ones.
const learn = (next) => [
  {
    guard: ({ context, event }) => {
      const { journal } = next(context, event);
      return context.book != null && journal !== context.journal && (context.book === journal || context.book === context.journal);
    },
    target: ".loading",
    reenter: true,
    actions: assign(({ context, event }) => next(context, event)),
  },
  { actions: assign(({ context, event }) => next(context, event)) },
];

// The journal is the book books marks written.
const fromList = (context, event) => {
  const books = Array.isArray(event.output?.books) ? event.output.books : [];
  return {
    journal: books.find((b) => b.written === true)?.id ?? null,
    titles: Object.fromEntries(books.map((b) => [b.id, b.title])),
  };
};

const fromChange = (context, event) => ({
  journal: event.written === true ? event.id : context.journal === event.id ? null : context.journal,
  titles: { ...context.titles, [event.id]: event.title },
});

// The book the list shows: the one the tab is pinned to, else the book on the stage.
export const wanted = ({ pin, subject }) => pin ?? bookOf(subject);

// A new subject or pin: `next` gives both. A different book is asked for afresh; no book
// shows the line that says to open one. While pinned the subject is only noted, and
// unpinning shows the book on the stage at once, because a list left on the pinned book
// would offer no way back to it.
const follow = (next) => [
  {
    guard: ({ context, event }) => wanted(next({ context, event })) === context.book,
    actions: assign(({ context, event }) => next({ context, event })),
  },
  {
    guard: ({ context, event }) => wanted(next({ context, event })) != null,
    target: ".loading",
    actions: assign(({ context, event }) => {
      const n = next({ context, event });
      const book = wanted(n);
      return { ...fresh, ...n, book, text: context.drafts.read(book), evaluators: [] };
    }),
  },
  {
    target: ".idle",
    actions: assign(({ context, event }) => ({ ...fresh, ...next({ context, event }), book: null, evaluators: [] })),
  },
];

export const machine = setup({
  actors: {
    // The starting picture: the pin, then the subject. pins.changed and subject.changed are
    // each held for this ask until their reply lands (supersededBy), so they are applied
    // after, in order.
    readSubject: fromPromise(async ({ input }) => {
      if (!input.following) return { subject: null, pin: null };
      const pins = await input.ask("pins", "read", {});
      const subject = await input.ask("subject", "read", {});
      return { subject: subject?.subject ?? null, pin: typeof pins?.evaluators === "string" ? pins.evaluators : null };
    }),
    // The book's evaluators; evaluator.changed / evaluator.deleted are held for this ask
    // until its reply lands, so a change that races it is applied after it.
    // The journal asks for every book's, as it lists the marked ones of any book.
    load: fromPromise(({ input }) =>
      input.ask("evaluators", "list", input.book === input.journal ? {} : { book: input.book }),
    ),
    // book.changed / book.deleted are held for this ask until its reply lands. A page
    // without books gets no-answerer, and then no book is the journal.
    books: fromPromise(({ input }) => (input.following ? input.ask("books", "list", {}) : Promise.resolve({ books: [] }))),
    // The "Vim keys" device preference (12); on a page without a settings fact the ask
    // replies no-answerer and the letters stay off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // A guest's free use (7.7); llm.changed is held for this ask until its reply lands.
    llm: fromPromise(({ input }) => input.ask("llm", "read", {})),
    // Whether the account is a guest, which changes how a refused Run is told;
    // session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // decide is superseded by nothing, so nothing is held for it.
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
  },
}).createMachine({
  id: "evaluator-list",
  meta: {
    description:
      "Lists the evaluators kept with the open book and tries them on a text. At the top a box labelled" +
      " \"Write one sentence per line\" takes a text, and its button evaluates each line on its own with " +
      "the switched-on evaluators, asking only their switched-on questions; the button says \"Evaluate\"," +
      " or \"Evaluate 1 line\" or \"Evaluate N lines\" once there is text, and \"Evaluating…\" while it " +
      "works. Blank lines are skipped, and each line is one request to Jev, sent one after another, " +
      "never two at once. Typing during a run does not change it. Beside the button a line says who " +
      "evaluates: \"Evaluated by\" and the one or two switched-on evaluators by name, or how many when " +
      "there are three or more, or \"No evaluator is on\" (\"No evaluator has a question yet\" when those on have none to ask); pressing it shows or hides the list of " +
      "evaluators under it. With `folded` the list starts hidden, without it shown; the user's own " +
      "showing or hiding is remembered in this browser and wins over the page. The list: New evaluator " +
      "is the first row and opens an empty editor; the evaluator appears in the list once something is " +
      "written in it. Each row has a tick box that switches the evaluator on or off, its name, greyed " +
      "when off, and how many of its questions would be asked: those written and switched on. With " +
      "`subject` it follows the book open on the stage, and another book shows that book's evaluators; " +
      "while no book is open, or without `subject`, it says to open a book. While the Journal is open " +
      "it lists the Journal's evaluators and every evaluator of another book marked Show in journal, " +
      "that book's title on the line under its name; its tick, opening it and evaluating work as for " +
      "the Journal's own. The arrow keys move between the rows, and with Vim keys on so do j, k, gg and" +
      " G; Enter opens the row. Under the list come the results, one block per line as it is answered: " +
      "the line's text, then each answer in words, never as a number. A pick answer names the option " +
      "when Jev is sure (75% or more), \"Between: A and B\" when the top two are within 15 points, " +
      "\"Probably: A\" from an even chance, and \"Not clear, maybe: A\" below it; a yes / no answer is Yes," +
      " Probably yes, Probably no or No, split at 75%, 50% and 25%, and \"Not clear\" from 45% to 55%. An" +
      " answer starts with its option's icon when the option has one, and with the question's text when" +
      " the question is yes / no or its evaluator asks more than one. When the question expects an " +
      "answer, the icon is green when Jev gave it and red when not, judged by the top answer for " +
      "Between and Not clear, and an answer without an icon gets a check or a warning in the same " +
      "colours; nothing expected, no colour. With more than one evaluator, each one's answers sit under" +
      " its name. A failed line says why in one sentence and stops the run: the lines already answered " +
      "stay, the ones after it are not asked, and the button starts every line over. On a try page, " +
      "when a guest has used all its free use the button is off and under it says \"You have used all " +
      "your free use.\"; while free trials are paused for every guest, or Jev cannot be asked on the " +
      "guest's behalf, it is off and says \"Free trials are paused for now.\"; a guest the admin blocked " +
      "has it off and reads \"This trial has ended.\" Results are not saved: Clear removes them and stops" +
      " a run, a change to an evaluator removes its own from every line, and another book removes all " +
      "of them. The text is kept per book in this browser, so a reload or coming back to the book shows" +
      " it again. With `subject`, a line at the top names the book shown. While the editor's pin is on," +
      " as `pins` says, the list stays on that book when another comes on the stage, and unpinning " +
      "brings the stage's book back at once. The row of the evaluator the editor shows is marked, " +
      "whether the user picked it or the editor opened it by itself on another book, after a reload or " +
      "a pin, and the keyboard starts from it.",
    kind: "view",
    emits: ["evaluator.selected", "evaluator.switched"],
    attributes: ["subject", "folded"],
    asks: ["evaluators: list", "subject: read", "settings: read", "llm: decide", "books: list", "pins: read", "llm: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    // The Run box's text per book, kept by the view across reloads (3.1); without one
    // the text lives only for this page.
    drafts: input.drafts ?? { read: () => "", write: () => {} },
    following: Boolean(input.following),
    subject: null,
    book: null,
    // The book `pins` holds for this tab, and whether pins.changed came before the start
    // reply, which is then the older picture.
    pin: null,
    pinsObserved: false,
    evaluators: [],
    // The journal's book id, null until books answers, and each book's title by id.
    journal: null,
    titles: {},
    // The evaluator the editor shows, learned from evaluator.opened; the row marked.
    open: null,
    draft: input.mint(),
    vimKeys: false,
    guest: false,
    // llm's freeUse while the account is a guest (7.7), else null.
    freeUse: null,
    // The Run box (UI state): the text, whether a run is in flight, the last run's lines
    // ({ at, line, status: waiting | asking | done | failed, results by evaluator id,
    // error }), and the evaluators and questions as the run took them.
    ...fresh,
  }),
  // The subject and settings reads run for the machine's whole life, so a book's load
  // never cancels them.
  invoke: [
    {
      src: "readSubject",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: follow(({ context, event }) => ({
        subject: event.output?.subject ?? null,
        pin: context.pinsObserved ? context.pin : (event.output?.pin ?? null),
      })),
      onError: { actions: [] },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "llm",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ freeUse: ({ event }) => event.output?.freeUse ?? null }) },
      onError: { actions: [] },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ guest: ({ event }) => event.output?.guest === true }) },
      onError: { actions: [] },
    },
    {
      src: "books",
      input: ({ context }) => ({ ask: context.ask, following: context.following }),
      onDone: learn(fromList),
      onError: { actions: [] },
    },
  ],
  initial: "idle",
  states: {
    idle: {},
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, book: context.book, journal: context.journal }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.evaluators),
            target: "ready",
            actions: assign(({ context, event }) => {
              const evaluators = event.output.evaluators.filter((e) => belongs(context.book, context.journal, e));
              return { evaluators, draft: remint(context, evaluators) };
            }),
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
            // The lines and evaluators are taken once, so typing during the run changes
            // nothing it asks.
            _run: {
              guard: ({ context }) =>
                filled(context.text) && askable(context.evaluators).length > 0 && freeStop(context.freeUse) == null,
              target: "running",
              actions: assign(({ context }) => ({
                asked: askable(context.evaluators),
                runs: lines(context.text).map((l) => ({ ...l, status: "waiting", results: {}, error: null })),
              })),
            },
          },
        },
        // One line per entry: the first waiting line is asked, and the answer re-enters
        // for the next one, so two requests are never open at once.
        running: {
          entry: assign(({ context }) => {
            const next = context.runs.findIndex((r) => r.status === "waiting");
            return { running: true, runs: context.runs.map((r, i) => (i === next ? { ...r, status: "asking" } : r)) };
          }),
          exit: assign({ running: false }),
          invoke: {
            src: "decide",
            input: ({ context }) => ({ ask: context.ask, payload: payload(context.runs.find((r) => r.status === "asking").line, context.asked) }),
            onDone: [
              {
                guard: ({ context, event }) => Array.isArray(event.output?.answers) && more(context),
                target: "running",
                reenter: true,
                actions: assign(({ context, event }) => ({
                  runs: settle(context.runs, { status: "done", results: results(context.asked, event.output.answers) }),
                })),
              },
              {
                guard: ({ event }) => Array.isArray(event.output?.answers),
                target: "waiting",
                actions: assign(({ context, event }) => ({
                  runs: settle(context.runs, { status: "done", results: results(context.asked, event.output.answers) }),
                  asked: [],
                })),
              },
              {
                target: "waiting",
                actions: assign(({ context, event }) => ({
                  runs: settle(context.runs, { status: "failed", error: errorKind(event.output?.error, context.guest) }),
                  asked: [],
                })),
              },
            ],
            onError: {
              target: "waiting",
              actions: assign(({ context }) => ({ runs: settle(context.runs, { status: "failed", error: "failed" }), asked: [] })),
            },
          },
        },
      },
      on: {
        _type: {
          actions: [
            assign({ text: ({ event }) => (typeof event.text === "string" ? event.text : "") }),
            ({ context }) => context.book != null && context.drafts.write(context.book, context.text),
          ],
        },
        // Clear also stops a run, so nothing it had still on its way comes back.
        _clear: { target: ".waiting", actions: assign({ runs: [], asked: [] }) },
        // The gestures (7.2: internal messages from the view). A pick names a shown
        // evaluator or the draft; a tick names a shown evaluator and changes it.
        _pick: {
          guard: ({ context, event }) => event.id === context.draft || shownHas(context, event.id),
          actions: [
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
    "llm.changed": { actions: assign({ freeUse: ({ event }) => event.freeUse ?? null }) },
    "session.changed": { actions: assign({ guest: ({ event }) => event.guest === true }) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "evaluator.opened": { actions: assign({ open: ({ event }) => event.id }) },
    "subject.changed": follow(({ context, event }) => ({ subject: event.subject ?? null, pin: context.pin })),
    // `pins`' news (4.3, fourth rule): the tab's book pinned, or unpinned.
    "pins.changed": [
      { guard: ({ context }) => !context.following, actions: [] },
      ...follow(({ context, event }) => ({ subject: context.subject, pin: event.evaluators ?? null, pinsObserved: true })),
    ],
    "book.changed": learn(fromChange),
    "book.deleted": { actions: assign({ titles: ({ context, event }) => without(context.titles, event.id) }) },
    // The fact's news (4.3, fourth rule), for the evaluators shown only. One that no
    // longer belongs, as when "Show in journal" is turned off, leaves the journal's list
    // as a deleted one does.
    "evaluator.changed": [
      {
        guard: ({ context, event }) =>
          !belongs(context.book, context.journal, event.evaluator) && context.evaluators.some((e) => e.id === event.evaluator.id),
        actions: assign(({ context, event }) => gone(context, event.evaluator.id)),
      },
      {
        guard: ({ context, event }) => belongs(context.book, context.journal, event.evaluator),
        actions: assign(({ context, event }) => {
          const evaluators = [...context.evaluators.filter((e) => e.id !== event.evaluator.id), event.evaluator].sort(byId);
          // When what it would ask changed (its questions, a question's tick, or its
          // own tick), its answers no longer match, so its result goes, and so does an
          // answer still on its way. A rename or the server's acknowledgement keeps them,
          // and so does every other evaluator's.
          const before = context.evaluators.find((e) => e.id === event.evaluator.id);
          const keep = before && asks(before) === asks(event.evaluator);
          return {
            evaluators,
            draft: remint(context, evaluators),
            ...(keep
              ? {}
              : {
                  runs: dropResults(context.runs, event.evaluator.id),
                  asked: context.asked.filter((e) => e.id !== event.evaluator.id),
                }),
          };
        }),
      },
    ],
    "evaluator.deleted": { actions: assign(({ context, event }) => gone(context, event.id)) },
  },
});
