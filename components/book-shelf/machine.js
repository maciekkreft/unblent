import { setup, assign, fromPromise, enqueueActions, emit } from "xstate";

// The view component that shows the library and lets a book be added, opened, or
// dropped (8, kind 4). It owns only UI state — the tiles it is showing, the imports
// still in flight, which tile is open, and the ids counting down to a discard — and
// points at `books`, which owns the fact. It asks books: list for the starting
// picture and follows book.changed / book.deleted after (4.3, fourth rule); it never
// decides what a book is, it learns that from the fact's events. It asks session: read
// and follows session.changed for whether anyone is signed in.
//
// The file the user picked is turned into an object URL in the view (a machine may
// not touch File or URL, so it stays importable in Node); the machine only carries
// the little that rides book.picked, which `books` fetches once and revokes. A book
// being imported shows as a placeholder tile until book.changed brings its real row
// or book.refused says why it could not be added.

// The journal first, then newest first: addedAt descending, id as the tiebreak, the
// same order books uses in its list reply, so a tile keeps its place across a re-sort.
const order = (a, b) => Number(Boolean(b.written)) - Number(Boolean(a.written)) || b.addedAt - a.addedAt || a.id.localeCompare(b.id);
const sorted = (books) => [...books].sort(order);

// Only the fields a tile shows are kept from a book.changed (which carries the whole
// book, 4.3, third rule); chapterCount is the chapter titles' length, as list gives.
const tile = ({ id, title, author, cover, position, chapters, pending, addedAt, written }) => ({
  id,
  title,
  author,
  cover,
  position,
  chapterCount: chapters.length,
  pending,
  addedAt,
  // The journal: owned by `journal`, not the library, so it cannot be renamed or
  // removed here.
  written: written === true,
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

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the shelf.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the shelf shows of the account (14, signed out): "wait" until session answers, so
// neither the tiles nor the sign-in line flashes; "sign-in" signed out, since the books
// kept in this browser are the account's; "show" otherwise. A try page (8) shows the
// shelf to a visitor who is not yet a guest.
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

export const machine = setup({
  actors: {
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // The starting picture (4.3): the library from books, and who is signed in from
    // session, since session.changed only fires on a change and a fresh signed-out
    // load is no change — the empty invite would never appear from the event alone.
    load: fromPromise(async ({ input }) => {
      const [books, session, open] = await Promise.all([
        input.ask("books", "list", {}),
        input.ask("session", "read", {}),
        input.ask("books", "open", {}),
      ]);
      return { books, session, open };
    }),
  },
}).createMachine({
  id: "book-shelf",
  meta: {
    description:
      "Shows the library as tiles, the journal first and then newest first, and lets the user " +
      "add a book from an epub file, open one, or remove one. A book being added shows as a " +
      "placeholder tile until the book arrives or the import is refused with a reason. Removing " +
      "a book waits out the undo window before it becomes a deletion, so it can be taken back in " +
      "one step. The journal, the book the user writes, reads \"Written by you\" under its title, " +
      "shows no chapter count, and has no rename or delete, so it is always on the shelf. " +
      "The arrow keys move through the tiles as a grid: left and right to the next tile, up " +
      "and down to the tile above or below, and with Vim keys on h, j, k and l do the same. " +
      "Signed out it shows only \"Sign in to see your books.\": no tiles, not even the " +
      "journal's, and no Add a book. The books stay kept in this browser and come back, with " +
      "the open one highlighted, when the user signs in, without a reload. A removal still " +
      "in its undo window when the user signs out is taken back. On a try page a visitor not " +
      "yet signed in still sees the shelf.",
    kind: "view",
    emits: ["book.picked", "book.selected", "book.discarded", "book.renamed"],
    attributes: ["renames"],
    asks: ["books: list", "session: read", "books: open", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // How long a discarded tile can be brought back (the --duration-undo token, read
    // in the view and passed in so the machine stays importable in Node). The delete
    // is not a fact until the window ends: stop it and nothing was emitted.
    undoMs: input.undoMs,
    books: [],
    // Imports in flight: one placeholder per picked file, keyed by its minted id,
    // removed when book.changed brings the real tile or book.refused says why not.
    importing: [],
    // The book the reader is showing, learned from book.opened (which the fact emits on
    // this device's pick and on another device's, pulled): the shelf highlights it but
    // does not own it, so a reload restores the highlight (4.3, fourth rule).
    selected: null,
    // The ids counting down to a discard, each with its own cancelable timer.
    discarding: new Set(),
    // Whether a user is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
  }),
  // Beside the states, so the preference arrives whatever the view is doing.
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    onError: { actions: [] },
  },
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
            signedIn: ({ event }) => signedIn(event.output.session),
            selected: ({ context, event }) =>
              event.output.open && "id" in event.output.open ? event.output.open.id : context.selected,
          }),
        },
        // books or session could not answer (offline, no answerer): an honest empty
        // shelf, and no answer counts as signed in.
        onError: { target: "ready", actions: assign({ books: [], signedIn: ({ context }) => context.signedIn ?? true }) },
      },
    },
    ready: {},
  },
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // Who is signed in now (4.3): signing in re-asks books: list, because the fact
    // pulls the library then. Signing out hides the tiles and keeps them; a removal
    // the user can no longer see is taken back, so nothing goes without its Undo.
    "session.changed": [
      {
        guard: ({ event }) => event.userId != null,
        target: ".loading",
        actions: assign({ signedIn: true }),
      },
      {
        actions: enqueueActions(({ context, enqueue }) => {
          for (const id of context.discarding) enqueue.cancel(`undo:${id}`);
          enqueue.assign({ signedIn: false, importing: [], discarding: new Set() });
        }),
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
    // The fact says which book is open now (4.3, fourth rule): highlight it. This is
    // how the highlight survives a reload and follows another device's open; the shelf
    // no longer sets it on the gesture, it waits for the fact to confirm.
    "book.opened": {
      actions: assign({ selected: ({ event }) => event.id }),
    },
    // The user opened a book (7.2, internal gesture): announce it. The highlight comes
    // back as book.opened from the fact, so there is one source of what is open.
    _select: {
      guard: ({ context, event }) => context.books.some((b) => b.id === event.id) && !context.discarding.has(event.id),
      actions: emit(({ event }) => ({ type: "book.selected", id: event.id })),
    },
    // The user edited a title in place (D11, 7.2 internal gesture): announce the
    // trimmed text as book.renamed, which books turns into a user title (last write
    // wins) and the book.changed that redraws the tile. Unchanged text emits nothing,
    // so a blur that changed nothing is silent; an empty string is a real change (it
    // restores the file's title), so it is announced.
    _rename: {
      guard: ({ context, event }) => {
        const tile = context.books.find((b) => b.id === event.id);
        return Boolean(tile) && !tile.written && event.title.trim() !== tile.title;
      },
      actions: emit(({ event }) => ({ type: "book.renamed", id: event.id, title: event.title.trim() })),
    },
    // The trash on a tile: begin the undo window. Nothing is emitted yet; only its
    // elapse makes the delete a fact.
    _discard: {
      guard: ({ context, event }) =>
        context.books.some((b) => b.id === event.id && !b.written) && !context.discarding.has(event.id),
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
