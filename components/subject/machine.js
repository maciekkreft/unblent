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

// The one view → kind table (D3): the views that show a thing. Today one row: the
// reader shows a book, whose id comes from `books: open` and whose title from
// `books: read`. A view with no row is about the subject and never changes it.
const STAGE_KINDS = { "book-reader": "book" };

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

// The subject the current context makes: an open id and a title we have resolved, of
// the kind the showing view shows. Missing either is null.
const subjectOf = (context) =>
  context.openId != null && context.title != null
    ? { kind: kindOf(context), id: context.openId, title: context.title, view: showing(context) }
    : null;

const sameSubject = (a, b) =>
  a === b || Boolean(a && b && a.kind === b.kind && a.id === b.id && a.title === b.title && a.view === b.view);

export const machine = setup({
  actors: {
    // The starting picture (4.3): which view is on the stage, and which book is open.
    // dock.changed and book.opened that race these asks are held for us until the
    // replies land (their supersededBy), so nothing is lost.
    load: fromPromise(async ({ input }) => {
      const [dock, open] = await Promise.all([
        input.ask("dock", "read", {}),
        input.ask("books", "open", {}),
      ]);
      return { stage: dock?.stage ?? null, openId: open?.id ?? null };
    }),
    // The open book's title. book.changed and book.deleted for it are held until this
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
      "show a thing, today `book-reader`, which shows the open book; the subject is the thing " +
      "shown by the one of those last in front on the stage, and it stays while any other view " +
      "is in front, because those views are about the subject. After a reload, before any such " +
      "view has been in front, the subject is the open item of the first view in its table. The " +
      "table from a view to the kind of thing it shows lives only here, so a new kind of thing " +
      "changes only this component, and a follower compares kind and id without knowing what " +
      "kinds exist. It announces a change only when the answer differs.",
    kind: "fact",
    shape: "local-only",
    owns: "current subject",
    emits: ["subject.changed"],
    asks: ["dock: read", "books: open", "books: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The address of the view that last showed a thing in front (memory only, 3.1), the
    // open book id, the title we have resolved for it, and the last subject we announced
    // (to answer read and to emit only on a change).
    shower: null,
    openId: null,
    title: null,
    subject: null,
  }),
  initial: "starting",
  on: {
    // Query for the starting picture (4.3): honest even before the first asks land,
    // when the answer is null; subject.changed carries every change after.
    "read?": { actions: ({ context, event }) => event.reply({ subject: context.subject }) },
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
          actions: assign({
            openId: ({ event }) => event.id ?? null,
            title: ({ context, event }) => (event.id === context.openId ? context.title : null),
          }),
          target: ".reconcile",
        },
        // The open book's row changed (a rename, a re-import): take its new title.
        "book.changed": {
          guard: ({ context, event }) => event.id === context.openId,
          actions: assign({ title: ({ event }) => event.title }),
          target: ".reconcile",
        },
        // The open book was deleted: nothing open, so no subject.
        "book.deleted": {
          guard: ({ context, event }) => event.id === context.openId,
          actions: assign({ openId: null, title: null }),
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
              { guard: "found", actions: assign({ title: ({ event }) => event.output.book.title }), target: "reconcile" },
              { actions: assign({ openId: null, title: null }), target: "reconcile" },
            ],
            onError: { actions: assign({ openId: null, title: null }), target: "reconcile" },
          },
        },
        ready: {},
      },
    },
  },
});
