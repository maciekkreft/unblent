import { setup, assign, fromPromise } from "xstate";

// A container view (3.1, 6.4) for the stage of a page that reads books: it shows the
// right view for the open book. It owns only UI state, whether the open book is written
// (the journal), and points at `books`: it asks books: open and books: read for the
// starting picture and follows book.opened, book.changed and book.deleted after (4.3,
// fourth rule). The asks arrive through `input`, so the machine is importable in Node.

// Which child the view shows: "written" while the open book is the one the user writes,
// "reader" otherwise, also when no book is open or the open book cannot be read.
export const shownOf = (context) => (context.written ? "written" : "reader");

const readInput = ({ context }) => ({ ask: context.ask, id: context.openId });

// A reply that names the open book settles the decision; anything else (not found, no
// answerer) leaves the reader shown, so a page without `books` still reads.
const fromReply = assign({ written: ({ event }) => event.output?.book?.written === true });

export const machine = setup({
  actors: {
    open: fromPromise(({ input }) => input.ask("books", "open", {})),
    read: fromPromise(({ input }) => input.ask("books", "read", { id: input.id })),
  },
  guards: {
    hasBook: ({ context }) => context.openId != null,
  },
}).createMachine({
  id: "book-stage",
  meta: {
    description:
      "The stage of a page that reads books, labelled like the reader it holds. It holds two " +
      "views: the first shows an ordinary book (the book reader), the second the book the user " +
      "writes (the journal's page). It shows the second while the open book is written, and the " +
      "first otherwise, also when no book is open. Both views stay loaded behind it, so each " +
      "keeps its place, and when the shown view changes while the keyboard is on the stage the " +
      "keyboard moves into the newly shown one. It emits nothing; it asks `books` which book is " +
      "open and whether it is written, and follows the open book after.",
    kind: "view",
    emits: [],
    asks: ["books: open", "books: read"],
    attributes: ["height"],
  },
  context: ({ input }) => ({ ask: input.ask, openId: null, written: false }),
  initial: "opening",
  states: {
    // The starting picture (4.3): which book is open. book.opened and book.deleted that
    // race it are held for us until the reply lands (books: open supersededBy).
    opening: {
      invoke: {
        src: "open",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { target: "deciding", actions: assign({ openId: ({ event }) => event.output?.id ?? null }) },
        onError: "ready",
      },
    },
    deciding: {
      always: [{ guard: "hasBook", target: "reading" }, { target: "ready", actions: assign({ written: false }) }],
    },
    // Whether the open book is written. The view shown so far stays until the reply, so
    // nothing flickers; book.changed and book.deleted for the book are held until then.
    reading: {
      invoke: { src: "read", input: readInput, onDone: { target: "ready", actions: fromReply }, onError: { target: "ready", actions: assign({ written: false }) } },
    },
    ready: {},
  },
  on: {
    // Another book opened, here or on another device (5): ask about it afresh.
    "book.opened": { target: ".deciding", reenter: true, actions: assign({ openId: ({ event }) => event.id ?? null }) },
    "book.changed": {
      guard: ({ context, event }) => event.id === context.openId,
      actions: assign({ written: ({ event }) => event.written === true }),
    },
    "book.deleted": {
      guard: ({ context, event }) => event.id === context.openId,
      target: ".ready",
      actions: assign({ openId: null, written: false }),
    },
  },
});
