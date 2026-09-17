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
// user's jump as chapter.selected (4.3, fifth rule).

// Only the fields the contents needs are kept from a read reply or a book.changed (both
// carry the whole book, 4.3, third rule): the id to address a jump at, the tree to
// draw, and the current chapter to mark, which rides the book's saved position.
const pickToc = (b) => ({ id: b.id, toc: b.toc, chapter: b.position.chapter });

// The changed book is the one being shown when its id matches; a book.changed or a
// book.deleted for any other book is the bus's to record as ignored.
const isOurs = ({ context, event }) => Boolean(context.book) && event.id === context.book.id;

export const machine = setup({
  actors: {
    // Which book is open (4.3): the starting picture on load, so a reload shows the
    // contents of the book being read. book.opened is held until the reply (supersededBy).
    open: fromPromise(({ input }) => input.ask("books", "open", {})),
    // The selected book's tree from books. book.changed is held for this ask until the
    // reply lands (supersededBy), so a move that races the read is applied after it.
    read: fromPromise(({ input }) => input.ask("books", "read", { id: input.id })),
  },
  guards: {
    found: ({ event }) => "book" in event.output,
    ours: isOurs,
  },
}).createMachine({
  id: "book-toc",
  meta: {
    kind: "view",
    emits: ["chapter.selected"],
    attributes: [],
    asks: ["books: open", "books: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The book asked for while it loads (which may differ from `book` mid-switch), and
    // the loaded book's id, tree and current chapter, or null before one is selected.
    id: null,
    book: null,
    // The chapter the user chose that the fact has not confirmed yet: marked at once,
    // because the position only arrives after the reader settles and announces.
    jump: null,
  }),
  initial: "starting",
  on: {
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
        jump: ({ context, event }) => (event.position.chapter !== context.book.chapter ? null : context.jump),
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
        // The already-current chapter has nothing to confirm, so it holds no jump.
        enqueue.assign({ jump: event.chapter === context.book.chapter ? null : event.chapter });
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
    showing: {},
  },
});
