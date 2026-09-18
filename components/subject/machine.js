import { setup, assign, fromPromise, enqueueActions } from "xstate";

// A derived fact component (3.1): it owns "what the user is working on" — the thing
// on the stage — as { kind, id, title } or null, and stores nothing. It combines
// `dock`'s staged view with the open item of the fact behind that view, asking those
// facts for the starting picture (4.3) and following their events after. The table
// from staged view to kind, and to the fact that names its open item, lives here
// alone (D3): a follower compares kind and id without knowing what kinds exist, and a
// new kind of stage content changes only this component. Everything with a side
// effect — the asks — arrives through `input`, so this stays importable in Node.

// The one staged-view → kind table (D3). Today one row: the reader stages a book,
// whose id comes from `books: open` and whose title from `books: read`. A stage
// showing any other view, or the reader with no book open, is no subject.
const STAGE_KINDS = { "book-reader": "book" };

// A stage is a view address, `book-reader` or `book-reader#2` when a page holds more
// than one (4.1); the kind is keyed on the base name.
const viewOf = (stage) => (typeof stage === "string" ? stage.split("#")[0] : null);
const kindOf = (context) => STAGE_KINDS[viewOf(context.stage)];

// The subject the current context makes: a kind on the stage, an open id, and a
// title we have resolved. Missing any of the three is null.
const subjectOf = (context) => {
  const kind = kindOf(context);
  return kind && context.openId != null && context.title != null
    ? { kind, id: context.openId, title: context.title }
    : null;
};

const sameSubject = (a, b) =>
  a === b || Boolean(a && b && a.kind === b.kind && a.id === b.id && a.title === b.title);

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
    // A book is on the stage but we do not yet hold its title, so it must be read.
    needsTitle: ({ context }) => Boolean(kindOf(context)) && context.openId != null && context.title == null,
    found: ({ event }) => "book" in event.output,
  },
  actions: {
    // Announce the subject only when it actually differs (D3): a dock re-arrangement
    // that keeps the same staged view, or an echo of the same book, changes nothing.
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
    kind: "fact",
    shape: "local-only",
    owns: "current subject",
    emits: ["subject.changed"],
    asks: ["dock: read", "books: open", "books: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The staged view address, the open book id, the title we have resolved for it,
    // and the last subject we announced (to answer read and to emit only on a change).
    stage: null,
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
            stage: ({ event }) => event.output.stage,
            openId: ({ event }) => event.output.openId,
          }),
        },
        onError: "active",
      },
    },
    active: {
      initial: "reconcile",
      on: {
        // The stage moved (4.3): a different view, or none, may change the subject.
        "dock.changed": { actions: assign({ stage: ({ event }) => event.stage ?? null }), target: ".reconcile" },
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
        // The open book was deleted: nothing is on the stage to be a subject.
        "book.deleted": {
          guard: ({ context, event }) => event.id === context.openId,
          actions: assign({ openId: null, title: null }),
          target: ".reconcile",
        },
      },
      states: {
        // Decide whether the current stage and open book need a title read, or settle.
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
