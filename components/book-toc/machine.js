import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The view component that shows one book's table of contents (8, kind 4) and lets a
// chapter be jumped to. It owns only UI state — which book's contents it is showing,
// the toc tree, and which chapter is current — and points at `books`, which owns the
// fact. The current chapter is the one the user just chose (a jump the fact has not
// confirmed yet, so the click is answered at once), else the fact's position, which
// stays authoritative as soon as it moves. It asks books: read for the tree when a
// book is selected, then follows
// book.changed (a re-import changes the tree; a page turn moves the current chapter,
// which rides book.changed's position, 4.3, fourth rule) and book.deleted after. It
// never decides what a chapter is; it learns the tree from the fact and announces the
// user's jump as chapter.selected (4.3, fifth rule). For the journal it also asks
// choice-points: list and follows its two events, to count each day's choice points. It
// asks session: read and follows session.changed only for whether anyone is signed in.
// While the book is the journal it asks generators: results for the days' summaries
// and follows generation.changed, to show the marked day's summary under its row.

// Only the fields the contents needs are kept from a read reply or a book.changed (both
// carry the whole book, 4.3, third rule): the id to address a jump at, the tree to
// draw, and the current chapter to mark, which rides the book's saved position. For the
// written book, each chapter's day too, so its rows can be joined to the choice points,
// which name their day; null for any other book, which shows no counts.
const pickToc = (b) => ({
  id: b.id,
  toc: b.toc,
  chapter: b.position.chapter,
  written: b.written === true,
  days: b.written === true ? (b.chapters ?? []).map((c) => c.day ?? null) : null,
});

// The written book's saved position never follows the reader: books keeps it on the
// last day, so it moves only when a day is added, as when yesterday's hour of writing
// runs out and today's empty page appears. The journal's page keeps showing the day
// picked here until another is picked or the journal is opened again, so the pick
// stays marked as long, even a pick of the chapter already current, and a position
// that moves never ends it.
const keepsPick = (book) => book.written;

// What a count needs of a choice point: its day, and its version, so an event older
// than what is held is ignored (4.3, fourth rule).
const held = (c) => ({ day: c.day, version: c.version, removing: c.removing === true });

// How many choice points each day has, by date. One waiting out its undo window is not
// counted: to the user it is already gone, and an undo counts it again.
export const counts = (choicePoints) => {
  const out = {};
  for (const c of Object.values(choicePoints)) if (!c.removing) out[c.day] = (out[c.day] ?? 0) + 1;
  return out;
};

// What a summary needs of a result: its text, and its version, so an announcement
// older than what is held is ignored (4.3, fourth rule).
const summaryOf = (r) => ({ text: r.text, version: r.version });
const isSummary = (r) => r?.generator === "journal-summary";

// The summary to show under the marked row: only the written book's days have one, and
// only a day the generator has written a non-empty text for.
export const markedSummary = (book, summaries, marked) => {
  if (!book?.days || marked == null) return null;
  const day = book.days[marked];
  const text = day ? summaries[day]?.text?.trim() : "";
  return text || null;
};

export const choiceLabel = (n) => (n === 1 ? "1 choice point" : `${n} choice points`);

// The count for each chapter of the shown book, by chapter number: only the written
// book's days have choice points, so any other book gets none.
export const chapterCounts = (book, choicePoints) => {
  if (!book?.days) return {};
  const perDay = counts(choicePoints);
  const out = {};
  book.days.forEach((day, chapter) => {
    if (day && perDay[day]) out[chapter] = perDay[day];
  });
  return out;
};

// A publisher's contents rarely lists every piece of the book (a praise page, a
// dedication, an illustration before a chapter), so the chapter being read may have no
// entry of its own. It belongs to the entry before it: the mark is the last listed
// chapter at or before the current one, and null before the first entry.
export const markedChapter = (toc, chapter) => {
  let marked = null;
  const walk = (entries) => {
    for (const e of entries) {
      if (e.chapter <= chapter && (marked === null || e.chapter > marked)) marked = e.chapter;
      if (e.children?.length) walk(e.children);
    }
  };
  walk(toc);
  return marked;
};

// The changed book is the one being shown when its id matches; a book.changed or a
// book.deleted for any other book is the bus's to record as ignored.
const isOurs = ({ context, event }) => Boolean(context.book) && event.id === context.book.id;

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the contents.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the contents show of the account (14, signed out): "wait" until session answers,
// so neither the rows nor the sign-in line flashes; "sign-in" signed out, since the
// chapters and the journal's days are the account's; "show" otherwise. A try page (8)
// shows them to a visitor who is not yet a guest.
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

export const machine = setup({
  actors: {
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Which book is open (4.3): the starting picture on load, so a reload shows the
    // contents of the book being read. book.opened is held until the reply (supersededBy).
    open: fromPromise(({ input }) => input.ask("books", "open", {})),
    // The selected book's tree from books. book.changed is held for this ask until the
    // reply lands (supersededBy), so a move that races the read is applied after it.
    read: fromPromise(({ input }) => input.ask("books", "read", { id: input.id })),
    // Every choice point, for the journal's counts. The two choice-point events are held
    // until the reply lands (supersededBy).
    choicePoints: fromPromise(({ input }) => input.ask("choice-points", "list", {})),
    // Whether anyone is signed in; session.changed is held for this ask until its reply lands.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    // The journal's days' summaries; generation.changed is held until the reply lands
    // (supersededBy).
    summaries: fromPromise(({ input }) => input.ask("generators", "results", { generator: "journal-summary" })),
  },
  guards: {
    found: ({ event }) => "book" in event.output,
    ours: isOurs,
  },
}).createMachine({
  id: "book-toc",
  meta: {
    description:
      "Shows the open book's table of contents and lets the user jump to a chapter. The current " +
      "chapter is marked: the one just clicked, until the book's saved position moves, and then " +
      "the position. In the journal, whose saved position is always its last day, the day " +
      "clicked stays marked until another is clicked or the journal is opened again, as the " +
      "journal's page keeps showing it. A part of the book the contents does not list, such as a dedication page, " +
      "counts as part of the entry before it. While the book is the journal, a day with choice " +
      "points says how many under its date, \"· 1 choice point\" or \"· 3 choice points\"; one " +
      "being deleted is not counted while its Undo is offered, and counts again after an undo. " +
      "Under the marked day the journal also shows that day's summary, one short sentence the " +
      "account's journal summary generator wrote, and updates it when a new one arrives; today " +
      "shows none until one is written. " +
      "Any other book shows no counts and no summaries, and when the choice points or the " +
      "summaries cannot be read the journal's contents show none of them and work as before. Signed out they show only \"Sign in to see " +
      "your books.\", and the same book's contents come back when the user signs in, without " +
      "a reload. On a try page a visitor not yet signed in still sees them.",
    kind: "view",
    emits: ["chapter.selected"],
    attributes: [],
    asks: ["books: open", "books: read", "settings: read", "choice-points: list", "session: read", "generators: results"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // The book asked for while it loads (which may differ from `book` mid-switch), and
    // the loaded book's id, tree and current chapter, or null before one is selected.
    id: null,
    book: null,
    // The chapter the user chose that the fact has not confirmed yet: marked at once,
    // because the position only arrives after the reader settles and announces.
    jump: null,
    // Every choice point by id, as held(): only the journal's counts are drawn from them.
    choicePoints: {},
    // Each journal day's summary by date, as summaryOf(): only drawn while the book is
    // the journal.
    summaries: {},
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
  }),
  // Beside the states, so the preference arrives whatever the view is doing.
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    // An error reply (no choice-points on the page) leaves the contents without counts.
    {
      src: "choicePoints",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ event }) => Array.isArray(event.output?.choicePoints),
        actions: assign(({ event }) => ({ choicePoints: Object.fromEntries(event.output.choicePoints.map((c) => [c.id, held(c)])) })),
      },
      onError: {},
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
  ],
  initial: "starting",
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null }) },
    // An equal version is taken: the removing flag changes without a new version.
    "choice-point.changed": {
      guard: ({ context, event }) => !(context.choicePoints[event.choicePoint.id]?.version > event.choicePoint.version),
      actions: assign(({ context, event }) => ({ choicePoints: { ...context.choicePoints, [event.choicePoint.id]: held(event.choicePoint) } })),
    },
    "generation.changed": {
      guard: ({ context, event }) => isSummary(event.result) && !(context.summaries[event.result.item]?.version > event.result.version),
      actions: assign(({ context, event }) => ({ summaries: { ...context.summaries, [event.result.item]: summaryOf(event.result) } })),
    },
    "choice-point.deleted": {
      actions: assign(({ context, event }) => {
        const { [event.id]: _gone, ...rest } = context.choicePoints;
        return { choicePoints: rest };
      }),
    },
    // The open book changed (4.3, fourth rule), opened here or on another device and
    // pulled: read its contents. A switch drops the old tree at once, so the panel never
    // shows stale contents while the new ones load; null empties it.
    "book.opened": [
      {
        guard: ({ event }) => event.id != null,
        target: ".opening",
        actions: assign({ id: ({ event }) => event.id, book: null, jump: null }),
      },
      { target: ".empty", actions: assign({ id: null, book: null, jump: null }) },
    ],
    // The fact's news for the open book (4.3, fourth rule): a re-import brings a new
    // tree, and a page turn rides in as a new position, whose chapter is the one to
    // mark. Both are just the fresh row folded in. A position whose chapter moved is
    // the fact confirming the jump, or a newer move overriding it, so the jump ends;
    // one with the chapter unchanged (an ack of an earlier turn) must not flick the
    // mark back, so the jump stays.
    "book.changed": {
      guard: "ours",
      actions: assign({
        jump: ({ context, event }) =>
          event.position.chapter !== context.book.chapter && !keepsPick(context.book) ? null : context.jump,
        book: ({ event }) => pickToc(event),
      }),
    },
    // The open book is gone: back to the empty panel.
    "book.deleted": {
      guard: "ours",
      target: ".empty",
      actions: assign({ id: null, book: null, jump: null }),
    },
    // The user chose an entry (7.2, internal gesture): announce the jump. The payload is
    // the book and the chapter; an entry deep in a chapter opens the chapter's first
    // page (a block target would be an additive extension, proposed when a book needs
    // it). Guarded so a click during a switch, before the tree is loaded, is dropped.
    _select: {
      guard: ({ context, event }) => Boolean(context.book) && context.book.id === event.id,
      actions: enqueueActions(({ context, event, enqueue }) => {
        // The already-current chapter has nothing to confirm, so it holds no jump, unless
        // the position will not follow the pick (keepsPick).
        enqueue.assign({ jump: event.chapter === context.book.chapter && !keepsPick(context.book) ? null : event.chapter });
        enqueue.emit({ type: "chapter.selected", id: event.id, chapter: event.chapter });
      }),
    },
  },
  states: {
    // On load, ask which book is open and show its contents; none, or a stale one, is
    // the empty panel. book.opened while this is open is held until the reply.
    starting: {
      invoke: {
        src: "open",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => event.output.id != null, target: "opening", actions: assign({ id: ({ event }) => event.output.id }) },
          { target: "empty" },
        ],
        onError: "empty",
      },
    },
    // No book yet: the shelf's selection brings one.
    empty: {},
    // The read for the selected book. not-found (a stale selection) falls back to empty.
    opening: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.id }),
        onDone: [
          { guard: "found", target: "showing", actions: assign({ book: ({ event }) => pickToc(event.output.book) }) },
          { target: "empty" },
        ],
        onError: "empty",
      },
    },
    // The journal asks for its days' summaries each time it is shown; any other book
    // asks nothing. An error reply (no generators on the page, signed out) shows none.
    showing: {
      initial: "deciding",
      states: {
        deciding: {
          always: [{ guard: ({ context }) => context.book?.written === true, target: "summarising" }, { target: "settled" }],
        },
        summarising: {
          invoke: {
            src: "summaries",
            input: ({ context }) => ({ ask: context.ask }),
            onDone: [
              {
                guard: ({ event }) => Array.isArray(event.output?.results),
                target: "settled",
                actions: assign(({ event }) => ({
                  summaries: Object.fromEntries(event.output.results.filter(isSummary).map((r) => [r.item, summaryOf(r)])),
                })),
              },
              { target: "settled" },
            ],
            onError: "settled",
          },
        },
        settled: {},
      },
    },
  },
});
