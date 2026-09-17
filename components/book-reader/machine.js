import { setup, assign, fromPromise, emit } from "xstate";

// The view component that reads one book (8, kind 4): it owns only UI state — which
// book and chapter it is showing, that chapter's fragment, a place it still owes the
// view to open, and the place it last announced — and points at `books`, which owns
// the fact. It asks books: read for the book (and its saved position) when a book is
// selected, and books: chapter for each chapter's fragment, then follows book.changed
// and book.deleted after (4.3, fourth rule). It never holds a copy of a book it would
// be sad to lose; the position is the one thing it produces, announced as
// book.progressed at a short throttle after a page turn settles (Decision 4).
//
// Rendering, pagination and the page a block sits on are the view's job (view.js);
// the machine only knows a chapter is a fragment and a place is { chapter, block }.
// Everything with a side effect — the queries — arrives through input, so this stays
// a pure definition importable in Node.

// The pause after a page turn the announcement waits for (Decision 4): a further turn
// records the new place but does not restart the window, so a run of turns announces
// once, the note-editor throttle rather than a debounce (4.3, third rule).
const PROGRESS_MS = 600;

// Only the fields the reader needs are kept from a read reply or a book.changed (both
// carry the whole book, 4.3, third rule): the chapter titles and count for the footer,
// the versions to tell a newer change from an echo, the saved position to open at.
const pickBook = (b) => ({
  id: b.id,
  title: b.title,
  author: b.author,
  chapters: b.chapters,
  position: b.position,
  version: b.version,
  contentVersion: b.contentVersion,
});

const samePos = (a, b) => Boolean(a && b && a.chapter === b.chapter && a.block === b.block);

// The book.changed news for the open book is either the echo of a place this reader
// announced (same position as what it last sent), a re-import (a new contentVersion,
// so the fragments changed and the chapter must be re-fetched), or another device's
// move (a newer version at a different place). Each is decided by a guard below.
const isOurs = ({ context, event }) => Boolean(context.book) && event.id === context.book.id;
const reimported = (args) => isOurs(args) && args.event.contentVersion !== args.context.book.contentVersion;
const movedElsewhere = (args) =>
  isOurs(args) &&
  args.event.version > args.context.book.version &&
  !samePos(args.event.position, args.context.sent);

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("books", "read", { id: input.id })),
    chapter: fromPromise(({ input }) => input.ask("books", "chapter", { id: input.id, chapter: input.chapter })),
  },
  guards: {
    // A read that found the book, versus one that says there is none by that id.
    found: ({ event }) => "book" in event.output,
    hasHtml: ({ event }) => "html" in event.output,
    unavailable: ({ event }) => event.output.error === "unavailable",
    reimported,
    // Another device's move that lands in a different chapter needs the fragment
    // re-fetched; one within the open chapter only re-opens a block.
    movedToOtherChapter: (args) => movedElsewhere(args) && args.event.position.chapter !== args.context.chapter,
    movedInChapter: (args) => movedElsewhere(args) && args.event.position.chapter === args.context.chapter,
    ours: isOurs,
  },
  actions: {
    // Announce where the user turned to (Decision 4). The place last recorded by a
    // settle is what is sent; `books` ignores it when it has not moved.
    announce: emit(({ context }) => ({
      type: "book.progressed",
      id: context.book.id,
      chapter: context.sent.chapter,
      block: context.sent.block,
    })),
  },
}).createMachine({
  id: "book-reader",
  meta: {
    kind: "view",
    emits: ["book.progressed"],
    attributes: ["height"],
    asks: ["books: read", "books: chapter"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The book being read, or null before one is selected. `id` is the book asked for
    // while it loads, which may differ from `book` mid-switch.
    id: null,
    book: null,
    // The chapter now shown, its fragment, a place still owed to the view to open
    // (cleared once the view settles), and the place last announced (to tell an echo
    // of book.changed from a real move).
    chapter: 0,
    html: "",
    pending: null,
    sent: null,
  }),
  initial: "empty",
  on: {
    // The user opened a book in the shelf (4.3, fifth rule). Read it for its metadata
    // and saved position; a switch from another book drops the old context.
    "book.selected": {
      target: ".opening",
      actions: assign({ id: ({ event }) => event.id, book: null, html: "", pending: null, sent: null, chapter: 0 }),
    },
    // The fact's news that the open book is gone (4.3, fourth rule): back to the empty
    // page. A deletion of another book is left to the bus to record as ignored.
    "book.deleted": {
      guard: ({ context, event }) => Boolean(context.book) && event.id === context.book.id,
      target: ".empty",
      actions: assign({ id: null, book: null, html: "", pending: null, sent: null, chapter: 0 }),
    },
  },
  states: {
    // No book yet: the shelf's selection brings one.
    empty: {},
    // The read for the selected book. Its reply carries the saved position, which the
    // reader opens at; not-found (a stale selection) falls back to empty.
    opening: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.id }),
        onDone: [
          {
            guard: "found",
            target: "reading",
            actions: assign({
              book: ({ event }) => pickBook(event.output.book),
              chapter: ({ event }) => event.output.book.position.chapter,
              pending: ({ event }) => ({ ...event.output.book.position }),
            }),
          },
          { target: "empty" },
        ],
        onError: "empty",
      },
    },
    reading: {
      initial: "fetching",
      on: {
        // A page turn that ran past the chapter's edge (the view decides; an intra-
        // chapter turn never reaches here): load the neighbour and open its first page,
        // or, going back, its last (block Infinity clamps to the last block in the view).
        _next: {
          guard: ({ context }) => context.chapter + 1 < context.book.chapters.length,
          target: ".fetching",
          actions: assign({
            chapter: ({ context }) => context.chapter + 1,
            pending: ({ context }) => ({ chapter: context.chapter + 1, block: 0 }),
          }),
        },
        _prev: {
          guard: ({ context }) => context.chapter > 0,
          target: ".fetching",
          actions: assign({
            chapter: ({ context }) => context.chapter - 1,
            pending: ({ context }) => ({ chapter: context.chapter - 1, block: Infinity }),
          }),
        },
        // The contents' jump (4.3, fifth rule): open a chapter's first page. Within the
        // open chapter it only re-opens the block; another chapter is re-fetched.
        "chapter.selected": [
          {
            guard: ({ context, event }) => event.id === context.book.id && event.chapter !== context.chapter,
            target: ".fetching",
            actions: assign({ chapter: ({ event }) => event.chapter, pending: ({ event }) => ({ chapter: event.chapter, block: 0 }) }),
          },
          {
            guard: ({ context, event }) => event.id === context.book.id,
            actions: assign({ pending: ({ context }) => ({ chapter: context.chapter, block: 0 }) }),
          },
        ],
        // A link inside the text to another spine item (the importer rewrote it to a
        // chapter and, when it named a fragment, a block): jump there.
        _link: [
          {
            guard: ({ context, event }) => event.chapter !== context.chapter,
            target: ".fetching",
            actions: assign({ chapter: ({ event }) => event.chapter, pending: ({ event }) => ({ chapter: event.chapter, block: event.block }) }),
          },
          { actions: assign({ pending: ({ event }) => ({ chapter: event.chapter, block: event.block }) }) },
        ],
        // The fact's news for the open book (4.3, fourth rule): a re-import re-fetches
        // the chapter, another device's move opens the new place, and an echo of this
        // reader's own turn only refreshes the metadata.
        "book.changed": [
          {
            guard: "reimported",
            target: ".fetching",
            actions: assign({
              book: ({ event }) => pickBook(event),
              chapter: ({ context, event }) => Math.min(context.chapter, event.chapters.length - 1),
              pending: ({ context, event }) => ({ chapter: Math.min(context.chapter, event.chapters.length - 1), block: 0 }),
            }),
          },
          {
            guard: "movedToOtherChapter",
            target: ".fetching",
            actions: assign({
              book: ({ event }) => pickBook(event),
              chapter: ({ event }) => event.position.chapter,
              pending: ({ event }) => ({ ...event.position }),
            }),
          },
          {
            guard: "movedInChapter",
            actions: assign({ book: ({ event }) => pickBook(event), pending: ({ event }) => ({ ...event.position }) }),
          },
          { guard: "ours", actions: assign({ book: ({ event }) => pickBook(event) }) },
        ],
      },
      states: {
        // Fetch the current chapter's fragment. not-found (a chapter that is gone)
        // shows nothing rather than an error; the server being unreachable is offline,
        // with a retry.
        fetching: {
          invoke: {
            src: "chapter",
            input: ({ context }) => ({ ask: context.ask, id: context.book.id, chapter: context.chapter }),
            onDone: [
              { guard: "hasHtml", target: "ready", actions: assign({ html: ({ event }) => event.output.html }) },
              { guard: "unavailable", target: "offline" },
              { target: "ready", actions: assign({ html: "" }) },
            ],
            onError: "offline",
          },
        },
        ready: {
          initial: "clean",
          states: {
            clean: {
              on: {
                // The view settled on a page and reports its top block; record it and
                // begin the announcement window.
                _settled: {
                  target: "dirty",
                  actions: assign({ sent: ({ event }) => ({ chapter: event.chapter, block: event.block }), pending: null }),
                },
              },
            },
            dirty: {
              on: {
                // Targetless so the window is not restarted: turns within it join the
                // one announcement at its end (4.3, third rule).
                _settled: {
                  actions: assign({ sent: ({ event }) => ({ chapter: event.chapter, block: event.block }), pending: null }),
                },
              },
              after: {
                [PROGRESS_MS]: { target: "clean", actions: "announce" },
              },
            },
          },
        },
        offline: {
          on: { _retry: "fetching" },
        },
      },
    },
  },
});
