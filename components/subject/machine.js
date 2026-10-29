import { setup, assign, fromPromise, enqueueActions } from "xstate";

// A derived fact component (3.1): it owns "what the user is working on" as
// { kind, id, title, view } or null, and stores nothing. Some views show a thing; the
// subject is the thing shown by the one of those that was last in front on the stage,
// and it stays while any other view is in front, because a view about the subject does
// not replace it (3.1). It combines `dock`'s staged view with the open item of the fact
// behind the showing view, asking those facts for the starting picture (4.3) and
// following their events after. The table from a view to the kind of thing it shows
// lives here alone (D3): a follower compares kind and id without knowing what kinds
// exist, and a new kind of thing changes only this component. Everything with a side
// effect — the asks — arrives through `input`, so this stays importable in Node.

// The one view → kind table (D3): the views that show a thing. Today both show a book,
// whose id comes from `books: open` and whose title from `books: read`: the book stage,
// which holds the reader and the journal's page, and the reader on its own. A view with
// no row is about the subject and never changes it. The first row is the shower before
// any view has been in front (a desk never arranged), so it names the product's stage.
const STAGE_KINDS = { "book-stage": "book", "book-reader": "book" };

// A stage is a view address, `book-reader` or `book-reader#2` when a page holds more
// than one (4.1); the kind is keyed on the base name.
const viewOf = (stage) => (typeof stage === "string" ? stage.split("#")[0] : null);
const shows = (stage) => viewOf(stage) in STAGE_KINDS;

// The view that shows the subject: the one last in front, or, before any has been (a
// reload with a view about the subject in front), the first row of the table (3.1).
const showing = (context) => context.shower ?? Object.keys(STAGE_KINDS)[0];
const kindOf = (context) => STAGE_KINDS[viewOf(showing(context))];

// A staged view takes over as the shower only when it shows a thing.
const showerAfter = (shower, stage) => (shows(stage) ? stage : shower);

// Letters that NFKD does not split into a plain letter and a mark.
const PLAIN = { "ł": "l", "ø": "o", "đ": "d", "ß": "ss", "æ": "ae", "œ": "oe" };

// A chapter's title as a link names it: lowercase a–z and 0–9, accented letters written
// plainly, every other run of characters one hyphen, none at either end. Empty when the
// title has no letter or digit, and then the chapter has no name. Here alone, so every
// link names a chapter the same way.
export const shortName = (title) =>
  String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[łøđßæœ]/g, (c) => PLAIN[c])
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// The open chapter of the open book, as { chapter, chapterTitle }, or nothing. The
// written book (the Journal) keeps its reading place at today, so its open chapter is the
// day the journal page shows, named by its date; until a page has said which, it is the
// day of the reading place. Any other book's is the chapter of its reading place, named
// by its title.
const chapterOf = (context) => {
  const chapters = Array.isArray(context.chapters) ? context.chapters : [];
  const at = chapters[context.at];
  if (context.written) {
    const day = context.day ?? at?.day;
    if (!day) return {};
    const title = chapters.find((c) => c.day === day)?.title;
    return { chapter: day, chapterTitle: title || day };
  }
  const chapter = shortName(at?.title);
  return chapter ? { chapter, chapterTitle: at.title } : {};
};

// What `book.changed` or a `books: read` reply says about the chapters, keeping what we
// hold for any part it leaves out.
const bookParts = (context, book) => ({
  chapters: Array.isArray(book.chapters) ? book.chapters : context.chapters,
  at: Number.isInteger(book.position?.chapter) ? book.position.chapter : context.at,
  written: typeof book.written === "boolean" ? book.written : "chapters" in book ? false : context.written,
});

// Nothing known about the chapters of a book not yet read.
const noBook = { chapters: [], at: null, written: false };

// The subject the current context makes: an open id and a title we have resolved, of
// the kind the showing view shows, with its open chapter when it has one. Missing either
// is null.
const subjectOf = (context) =>
  context.openId != null && context.title != null
    ? { kind: kindOf(context), id: context.openId, title: context.title, view: showing(context), ...chapterOf(context) }
    : null;

// A move within one chapter keeps the subject; a move to another chapter changes it.
const sameSubject = (a, b) =>
  a === b ||
  Boolean(
    a && b && a.kind === b.kind && a.id === b.id && a.title === b.title && a.view === b.view &&
      a.chapter === b.chapter && a.chapterTitle === b.chapterTitle,
  );

export const machine = setup({
  actors: {
    // The starting picture (4.3): which view is on the stage, which book is open, and
    // which day the journal page shows. dock.changed and book.opened that race these asks
    // are held for us until the replies land (their supersededBy), so nothing is lost; a
    // page with no journal answers no-answerer, and the day stays unknown.
    load: fromPromise(async ({ input }) => {
      const [dock, open, journal] = await Promise.all([
        input.ask("dock", "read", {}),
        input.ask("books", "open", {}),
        input.ask("journal", "open", {}),
      ]);
      return { stage: dock?.stage ?? null, openId: open?.id ?? null, day: journal?.shown?.day ?? null };
    }),
    // The open book's title and chapters. book.changed and book.deleted for it are held until this
    // reply lands (books: read supersededBy), so a change that races it is applied after.
    read: fromPromise(({ input }) => input.ask("books", "read", { id: input.id })),
  },
  guards: {
    // A book is open but we do not yet hold its title, so it must be read.
    needsTitle: ({ context }) => context.openId != null && context.title == null,
    found: ({ event }) => "book" in event.output,
  },
  actions: {
    // Announce the subject only when it actually differs (D3): a view about the subject
    // coming to the front, or an echo of the same book, changes nothing.
    settle: enqueueActions(({ context, enqueue }) => {
      const next = subjectOf(context);
      if (sameSubject(next, context.subject)) return;
      enqueue.assign({ subject: next });
      enqueue.emit({ type: "subject.changed", subject: next });
    }),
  },
}).createMachine({
  id: "subject",
  meta: {
    description:
      "Owns what the user is working on, as a kind, an id, a title and the view that shows it, " +
      "or nothing; it stores nothing and combines what `dock` and `books` announce. Some views " +
      "show a thing, today `book-stage` and `book-reader`, which show the open book; the subject " +
      "is the thing " +
      "shown by the one of those last in front on the stage, and it stays while any other view " +
      "is in front, because those views are about the subject. After a reload, before any such " +
      "view has been in front, the subject is the open item of the first view in its table. The " +
      "table from a view to the kind of thing it shows lives only here, so a new kind of thing " +
      "changes only this component, and a follower compares kind and id without knowing what " +
      "kinds exist. It also names the open chapter, by a short name and its title: for a book, " +
      "the chapter of the reading place, its title in lowercase letters, digits and hyphens " +
      "(none when the title has no letter or digit); for the Journal, the day its page shows, " +
      "named by its date. It announces a change only when the answer differs, so moving to " +
      "another chapter is a change and moving within one is not.",
    kind: "fact",
    shape: "local-only",
    owns: "current subject",
    emits: ["subject.changed"],
    asks: ["dock: read", "books: open", "books: read", "journal: open"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The address of the view that last showed a thing in front (memory only, 3.1), the
    // open book id, the title we have resolved for it, and the last subject we announced
    // (to answer read and to emit only on a change). Then the open book's chapters, the
    // chapter of its reading place, whether it is the written book, and the day the
    // journal page last showed.
    shower: null,
    openId: null,
    title: null,
    subject: null,
    ...noBook,
    day: null,
  }),
  initial: "starting",
  on: {
    // Query for the starting picture (4.3): honest even before the first asks land,
    // when the answer is null; subject.changed carries every change after.
    "read?": { actions: ({ context, event }) => event.reply({ subject: context.subject }) },
    // The day is not held for the journal: open ask (journal.changed supersedes it), so a
    // day.shown that lands while starting is kept here and wins over the older reply.
    "day.shown": { actions: assign({ day: ({ event }) => event.day }) },
  },
  states: {
    // Ask the stage and the open book before answering anything but null.
    starting: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "active",
          actions: assign({
            shower: ({ context, event }) => showerAfter(context.shower, event.output.stage),
            openId: ({ event }) => event.output.openId,
            day: ({ context, event }) => context.day ?? event.output.day,
          }),
        },
        onError: "active",
      },
    },
    active: {
      initial: "reconcile",
      on: {
        // The stage moved (4.3): only a view that shows a thing takes the subject over.
        "dock.changed": {
          actions: assign({ shower: ({ context, event }) => showerAfter(context.shower, event.stage) }),
          target: ".reconcile",
        },
        // The open book changed here or on another device. A new id needs its title
        // read; the same id keeps the title we hold.
        "book.opened": {
          actions: assign(({ context, event }) =>
            event.id === context.openId ? {} : { openId: event.id ?? null, title: null, ...noBook },
          ),
          target: ".reconcile",
        },
        // The open book's row changed (a rename, a re-import, the reading place moved):
        // take its new title and chapter.
        "book.changed": {
          guard: ({ context, event }) => event.id === context.openId,
          actions: assign(({ context, event }) => ({ title: event.title, ...bookParts(context, event) })),
          target: ".reconcile",
        },
        // The journal page moved to another day: the Journal's open chapter.
        "day.shown": {
          actions: assign({ day: ({ event }) => event.day }),
          target: ".reconcile",
        },
        // Supersedes journal: open, so it is followed (4.3); the day the page shows rides
        // day.shown, not this, so there is nothing to take from it.
        "journal.changed": { actions: () => {} },
        // The open book was deleted: nothing open, so no subject.
        "book.deleted": {
          guard: ({ context, event }) => event.id === context.openId,
          actions: assign({ openId: null, title: null, ...noBook }),
          target: ".reconcile",
        },
      },
      states: {
        // Decide whether the open book needs a title read, or settle.
        reconcile: {
          always: [
            { guard: "needsTitle", target: "resolving" },
            { actions: "settle", target: "ready" },
          ],
        },
        // Read the open book's title. not-found or an error means the open book is not
        // readable (a race that a later book.opened resolves), so drop it to no subject.
        resolving: {
          invoke: {
            src: "read",
            input: ({ context }) => ({ ask: context.ask, id: context.openId }),
            onDone: [
              {
                guard: "found",
                actions: assign(({ context, event }) => ({ title: event.output.book.title, ...bookParts(context, event.output.book) })),
                target: "reconcile",
              },
              { actions: assign({ openId: null, title: null, ...noBook }), target: "reconcile" },
            ],
            onError: { actions: assign({ openId: null, title: null, ...noBook }), target: "reconcile" },
          },
        },
        ready: {},
      },
    },
  },
});
