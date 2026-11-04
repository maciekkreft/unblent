import { setup, assign, fromPromise, enqueueActions, emit } from "xstate";

// The view component that shows the library and lets a book be added, opened, or
// dropped (8, kind 4). It owns only UI state — the tiles it is showing, the imports
// still in flight, which tile is open, and the last book deleted with Vim's dd — and
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

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the shelf.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the shelf shows of the account (14, signed out): "wait" until session answers, so
// neither the tiles nor the sign-in line flashes; "sign-in" signed out, since the books
// kept in this browser are the account's; "show" otherwise. A try page (8) shows the
// shelf to a visitor who is not yet a guest.
// A tile the user can delete: an imported book on the shelf, never the journal.
const removable = (context, id) => context.books.some((b) => b.id === id && !b.written);

// The Slip-Box (13): the one note at the top of the user's notes, opened from the shelf
// as a note on the stage. Its id is fixed, like the journal's, and valid as a ULID.
export const SLIPBOX = "00000000000000000000000SBX";

// Whether the Slip-Box feature shows (3.1): not until `flags` answers, and not on a page
// without `flags`, since the feature is not released until the admin releases it.
export const slipBoxShown = (hidden) => Array.isArray(hidden) && !hidden.includes("slip-box");

// The Slip-Box's tile: written by the user like the journal, so it has no rename, no
// delete and no chapter count; it is not a book, so it is never in `books`.
const SLIPBOX_TILE = { id: SLIPBOX, title: "Slip-Box", author: null, cover: null, chapterCount: 0, pending: false, addedAt: 0, written: true, slipBox: true };

// The tiles the shelf draws: the books, and while the feature shows the Slip-Box right
// after the journal.
export const tilesOf = (context) => {
  if (!slipBoxShown(context.hidden)) return context.books;
  const at = context.books.filter((b) => b.written).length;
  return [...context.books.slice(0, at), SLIPBOX_TILE, ...context.books.slice(at)];
};

// The tile with the frame: the Slip-Box while its tab is in front of the stage, otherwise
// the open book, so the shelf never points at a book while the Slip-Box is what is shown.
export const framedOf = ({ onStage, selected }) => (onStage ? SLIPBOX : selected);

// `subject` reports the Slip-Box only while the feature shows, so this needs no flag check.
const isSlipBox = (subject) => subject?.kind === "note" && subject.id === SLIPBOX;

export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

export const machine = setup({
  actors: {
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Which features are hidden (3.1); flags.changed is held until the reply lands.
    flags: fromPromise(({ input }) => input.ask("flags", "read", {})),
    // What is in front of the stage; subject.changed is held until the reply lands.
    subject: fromPromise(({ input }) => input.ask("subject", "read", {})),
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
      "a book deletes it at once and shows the short notice with Undo; Undo and Redo take back " +
      "adding, renaming and deleting a book (section 12). The journal, the book the user writes, reads \"Written by you\" under its title, " +
      "shows no chapter count, and has no rename or delete, so it is always on the shelf. " +
      "The arrow keys move through the tiles as a grid: left and right to the next tile, up " +
      "and down to the tile above or below, and with Vim keys on h, j, k and l do the same, " +
      "gg and G go to the first and last tile, dd deletes the tile at once, with the same " +
      "notice, and the keyboard moves to the next tile (the journal ignores it); the shelf " +
      "keeps the last book it deleted in memory, and p or P brings it back at its place on " +
      "the shelf, which keeps its own order, one step that Undo deletes again. p and P do " +
      "nothing once that book is back by another way (an Undo, another device) or after " +
      "signing out. u is the global Undo. o or O opens the file picker to add a book, and cc renames the tile where titles " +
      "can be changed. Renaming, " +
      "by the pencil on a cover or cc, turns the title and the author into two fields, the " +
      "title ready to type in and Tab moving to the author; Enter or leaving both saves, " +
      "Escape cancels, and an empty field brings back what the book's file says. " +
      "Signed out it shows only \"Sign in to see your books.\": no tiles, not even the " +
      "journal's, and no Add a book. The books stay kept in this browser and come back, with " +
      "the open one highlighted, when the user signs in, without a reload. On a try page a visitor not " +
      "yet signed in still sees the shelf. While the Slip-Box feature is shown, the second tile, " +
      "right after the journal, is the Slip-Box: a card with a stack of cards above its name, " +
      "which reads \"Written by you\" like the journal's. Opening it, by a click or Enter, shows " +
      "the Slip-Box note on the stage as a tab of its own; it is not a book, so it has no rename " +
      "or delete, and dd ignores it. The frame marks the Slip-Box while its tab is in front of " +
      "the stage, and otherwise the open book, also while another note or a chat is in front. While the feature " +
      "is hidden, and on a page that cannot say, there is no Slip-Box tile.",
    kind: "view",
    emits: ["book.picked", "book.selected", "book.discarded", "book.renamed", "book.restored", "note.staged"],
    attributes: ["renames"],
    asks: ["books: list", "session: read", "books: open", "settings: read", "flags: read", "subject: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    books: [],
    // Imports in flight: one placeholder per picked file, keyed by its minted id,
    // removed when book.changed brings the real tile or book.refused says why not.
    importing: [],
    // The book the reader is showing, learned from book.opened (which the fact emits on
    // this device's pick and on another device's, pulled): the shelf highlights it but
    // does not own it, so a reload restores the highlight (4.3, fourth rule).
    selected: null,
    // The last book deleted with Vim's dd (12), which p or P brings back; null when none.
    // Like Vim's register it is UI state, kept in memory only.
    deleted: null,
    // Whether a user is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
    // The features `flags` reports hidden (3.1); null until it answers.
    hidden: null,
    // Whether the Slip-Box's tab is in front of the stage, from `subject`; false on a page
    // without it.
    onStage: false,
  }),
  // Beside the states, so the preference and the features arrive whatever the view is doing.
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "flags",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ hidden: ({ event }) => (Array.isArray(event.output?.hidden) ? event.output.hidden : null) }) },
      onError: { actions: [] },
    },
    {
      src: "subject",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ onStage: ({ event }) => isSlipBox(event.output?.subject) }) },
      onError: { actions: [] },
    },
  ],
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
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    "subject.changed": { actions: assign({ onStage: ({ event }) => isSlipBox(event.subject) }) },
    // Who is signed in now (4.3): signing in re-asks books: list, because the fact
    // pulls the library then. Signing out hides the tiles and keeps them, and forgets
    // the book dd deleted, which p could no longer bring back to this account.
    "session.changed": [
      {
        guard: ({ event }) => event.userId != null,
        target: ".loading",
        actions: assign({ signedIn: true }),
      },
      { actions: assign({ signedIn: false, importing: [], deleted: null }) },
    ],
    // The fact's news (4.3, fourth rule): a changed book replaces or adds its tile and
    // clears any placeholder that was standing for it. The book dd deleted coming back (p,
    // an Undo, another device) is no longer one p can bring back.
    "book.changed": {
      actions: assign({
        books: ({ context, event }) => upsert(context.books, event),
        importing: ({ context, event }) => context.importing.filter((p) => p.id !== event.id),
        deleted: ({ context, event }) => (context.deleted === event.id ? null : context.deleted),
      }),
    },
    // The fact confirms a book is gone (this device's delete, another's, or an Undo):
    // drop the tile and unselect it if it was open.
    "book.deleted": {
      actions: assign({
        books: ({ context, event }) => context.books.filter((b) => b.id !== event.id),
        importing: ({ context, event }) => context.importing.filter((p) => p.id !== event.id),
        selected: ({ context, event }) => (context.selected === event.id ? null : context.selected),
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
    _select: [
      {
        guard: ({ context, event }) => context.books.some((b) => b.id === event.id),
        actions: emit(({ event }) => ({ type: "book.selected", id: event.id })),
      },
      // The Slip-Box is a note: the stage gives it a tab of its own (4.3, fifth rule).
      {
        guard: ({ context, event }) => event.id === SLIPBOX && slipBoxShown(context.hidden),
        actions: emit({ type: "note.staged", id: SLIPBOX }),
      },
    ],
    // The user edited a title and author in place (D11, 7.2 internal gesture): announce
    // the trimmed texts as book.renamed, which books turns into a user title and author
    // (last write wins) and the book.changed that redraws the tile. Unchanged text emits
    // nothing, so a blur that changed nothing is silent; an empty string is a real change
    // (it restores the file's title or author), so it is announced.
    _rename: {
      guard: ({ context, event }) => {
        const tile = context.books.find((b) => b.id === event.id);
        return (
          Boolean(tile) &&
          !tile.written &&
          (event.title.trim() !== tile.title || event.author.trim() !== (tile.author ?? ""))
        );
      },
      actions: emit(({ event }) => ({
        type: "book.renamed",
        id: event.id,
        title: event.title.trim(),
        author: event.author.trim(),
      })),
    },
    // The trash on a tile: the book is deleted at once, one step with the short notice
    // and its Undo (12, Undo).
    _discard: {
      guard: ({ context, event }) => removable(context, event.id),
      actions: emit(({ event }) => ({ type: "book.discarded", id: event.id })),
    },
    // Vim's dd on a tile (12): the same delete, and the shelf remembers the book so p or P
    // can bring it back. A second dd replaces it, as Vim's register holds one.
    _dd: {
      guard: ({ context, event }) => removable(context, event.id),
      actions: [assign({ deleted: ({ event }) => event.id }), emit(({ event }) => ({ type: "book.discarded", id: event.id }))],
    },
    // p or P: the deleted book comes back; `books` restores it as one step, at its place
    // on the shelf, which keeps its own order.
    _paste: {
      guard: ({ context }) => showing(context) === "show" && context.deleted != null,
      actions: enqueueActions(({ context, enqueue }) => {
        enqueue.assign({ deleted: null });
        enqueue.emit({ type: "book.restored", id: context.deleted });
      }),
    },
  },
});
