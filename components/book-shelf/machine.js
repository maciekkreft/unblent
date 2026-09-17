import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The view component that shows the library and lets a book be added, opened, or
// dropped (8, kind 4). It owns only UI state — the tiles it is showing, the imports
// still in flight, which tile is open, and the ids counting down to a discard — and
// points at `books`, which owns the fact. It asks books: list for the starting
// picture and follows book.changed / book.deleted after (4.3, fourth rule); it never
// decides what a book is, it learns that from the fact's events.
//
// The file the user picked is turned into an object URL in the view (a machine may
// not touch File or URL, so it stays importable in Node); the machine only carries
// the little that rides book.picked, which `books` fetches once and revokes. A book
// being imported shows as a placeholder tile until book.changed brings its real row
// or book.refused says why it could not be added.

// Newest first: addedAt descending, id as the tiebreak, the same order books uses in
// its list reply, so a tile keeps its place across a re-sort.
const order = (a, b) => b.addedAt - a.addedAt || a.id.localeCompare(b.id);
const sorted = (books) => [...books].sort(order);

// Only the fields a tile shows are kept from a book.changed (which carries the whole
// book, 4.3, third rule); chapterCount is the chapter titles' length, as list gives.
const tile = ({ id, title, author, cover, position, chapters, pending, addedAt }) => ({
  id,
  title,
  author,
  cover,
  position,
  chapterCount: chapters.length,
  pending,
  addedAt,
});

// Fold one changed book into the tiles: replace the tile with its id if present, else
// add it, then re-sort.
const upsert = (books, changed) => sorted([...books.filter((b) => b.id !== changed.id), tile(changed)]);

// A Set with one id removed, as a new Set so assign sees a fresh value (XState keeps
// context immutable; the view re-renders on every snapshot regardless).
const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export const machine = setup({
  actors: {
    // The starting picture (4.3): the library from books, and who is signed in from
    // session, since session.changed only fires on a change and a fresh signed-out
    // load is no change — the empty invite would never appear from the event alone.
    load: fromPromise(async ({ input }) => {
      const [books, session] = await Promise.all([
        input.ask("books", "list", {}),
        input.ask("session", "read", {}),
      ]);
      return { books, session };
    }),
  },
}).createMachine({
  id: "book-shelf",
  meta: {
    kind: "view",
    emits: ["book.picked", "book.selected", "book.discarded"],
    attributes: [],
    asks: ["books: list", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // How long a discarded tile can be brought back (the --duration-undo token, read
    // in the view and passed in so the machine stays importable in Node). The delete
    // is not a fact until the window ends: stop it and nothing was emitted.
    undoMs: input.undoMs,
    books: [],
    // Imports in flight: one placeholder per picked file, keyed by its minted id,
    // removed when book.changed brings the real tile or book.refused says why not.
    importing: [],
    // The book the reader is showing, set on a pick (the shelf has no feedback event
    // to learn it from, so it owns this selection as UI state).
    selected: null,
    // The ids counting down to a discard, each with its own cancelable timer.
    discarding: new Set(),
    // Whether a user is signed in, learned from session.changed; null until the first
    // one arrives. Books can only be added while signed in (5).
    signedIn: null,
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: assign({
            books: ({ event }) => (Array.isArray(event.output.books?.books) ? sorted(event.output.books.books) : []),
            signedIn: ({ context, event }) =>
              event.output.session && "userId" in event.output.session
                ? event.output.session.userId != null
                : context.signedIn,
          }),
        },
        // books or session could not answer (offline, no answerer): an honest empty
        // shelf; the signed-in picture stays whatever session.changed later says.
        onError: { target: "ready", actions: assign({ books: [] }) },
      },
    },
    ready: {},
  },
  on: {
    // Who is signed in now (4.3): signing in re-asks books: list, because the fact
    // only pulls the library then; signing out empties the shelf.
    "session.changed": [
      {
        guard: ({ event }) => event.userId != null,
        target: ".loading",
        actions: assign({ signedIn: true }),
      },
      {
        actions: assign({ signedIn: false, books: [], importing: [] }),
      },
    ],
    // The fact's news (4.3, fourth rule): a changed book replaces or adds its tile and
    // clears any placeholder that was standing for it.
    "book.changed": {
      actions: assign({
        books: ({ context, event }) => upsert(context.books, event),
        importing: ({ context, event }) => context.importing.filter((p) => p.id !== event.id),
      }),
    },
    // The fact confirms a book is gone (this device's discard on elapse, or another's):
    // drop the tile, unselect it if it was open, clear any countdown still standing.
    "book.deleted": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          books: ({ context }) => context.books.filter((b) => b.id !== event.id),
          importing: ({ context }) => context.importing.filter((p) => p.id !== event.id),
          selected: ({ context }) => (context.selected === event.id ? null : context.selected),
          discarding: ({ context }) => without(context.discarding, event.id),
        });
        if (context.discarding.has(event.id)) enqueue.cancel(`undo:${event.id}`);
      }),
    },
    // An import was refused (signed out, unreadable, unavailable): notice-stack shows
    // why; here the placeholder tile just goes.
    "book.refused": {
      actions: assign({ importing: ({ context, event }) => context.importing.filter((p) => p.id !== event.id) }),
    },
    // Files the user chose or dropped (7.2, internal gesture): announce each as a
    // book.picked and stand a placeholder tile until the fact answers.
    _picked: {
      actions: enqueueActions(({ event, enqueue }) => {
        for (const file of event.files) {
          enqueue.emit({ type: "book.picked", id: file.id, name: file.name, size: file.size, url: file.url });
        }
        enqueue.assign({
          importing: ({ context }) => [...event.files.map((f) => ({ id: f.id, name: f.name })), ...context.importing],
        });
      }),
    },
    // The user opened a book (7.2, internal gesture): announce it, and highlight it —
    // the shelf's own selection, immediate feedback with no event to learn it from.
    _select: {
      guard: ({ context, event }) => context.books.some((b) => b.id === event.id) && !context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ selected: event.id });
        enqueue.emit({ type: "book.selected", id: event.id });
      }),
    },
    // The trash on a tile: begin the undo window. Nothing is emitted yet; only its
    // elapse makes the delete a fact.
    _discard: {
      guard: ({ context, event }) => context.books.some((b) => b.id === event.id) && !context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(event.id) });
        enqueue.raise({ type: "_elapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `undo:${event.id}` });
      }),
    },
    // Undo: cancel the window, emit nothing.
    _undo: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.cancel(`undo:${event.id}`);
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
      }),
    },
    // The window ran out (the timer above): now the delete is a fact (book.discarded),
    // which books turns into a tombstone and the book.deleted that removes the tile.
    _elapsed: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
        enqueue.emit({ type: "book.discarded", id: event.id });
      }),
    },
  },
});
