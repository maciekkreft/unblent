import { setup, assign, fromPromise, emit, enqueueActions } from "xstate";

// The view component that lists the notes and lets one be picked (6.4): it owns only
// UI state — the rows it is showing, which one the editor has open, and a draft id
// with no row yet — and points at `notes`, which owns the fact. It asks notes: list
// for the starting picture and follows note.changed / note.deleted after (4.3,
// fourth rule); it never decides which row is open, it learns that from note.opened,
// so the highlighted row is always the note the editor is showing. The ask and mint
// arrive through input, so this stays a pure definition importable in Node.
//
// The next note the user would write is always the first row (the blank page on top
// of the pad, as in Notes.app), so `draft` is always a minted id with no row yet.
// Picking it opens a blank editor under that id; when the user types, note.changed
// brings the real row and a fresh draft is minted above it. The list never creates a
// note — a fact learns of creation from a gesture (4.3, fifth rule) — it only holds
// the name a note will take.

// Newest first: updatedAt descending, id as the tiebreak, the same order notes uses
// in its list reply (notes.replyList), so a row keeps its place across a re-sort.
const order = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
const sorted = (notes) => [...notes].sort(order);

// A note's links (12), always an array: an old cached note, or an event from before
// links existed, reads as none.
const links = (note) => (Array.isArray(note.about) ? note.about : []);

// One row keeps only the fields the list shows, plus the links it filters by.
const row = ({ id, title, subtitle, updatedAt, about }) => ({ id, title, subtitle, updatedAt, about: links({ about }) });

// Fold one changed note into the rows: replace the row with its id if present, else
// add it, then re-sort. Only the fields a row shows (and its links) are kept (a
// note.changed carries the whole note, 4.3, third rule).
const upsert = (notes, changed) => sorted([...notes.filter((n) => n.id !== changed.id), row(changed)]);

// A note is about the subject when one of its links matches the subject's kind and id
// (D4: a follower compares kind + id, it never learns what kinds exist).
const isAbout = (note, subject) =>
  subject != null && links(note).some((l) => l.kind === subject.kind && l.id === subject.id);

// A highlight of the subject: a link to it that carries a place (12). The list hides
// highlight notes — they belong to the highlights editor, not the note list (Decision 2).
const isHighlight = (note, subject) =>
  subject != null && links(note).some((l) => l.kind === subject.kind && l.id === subject.id && l.place);

// The Highlights row (Decision 1, 5, 6), the Highlights note to the user (13): while following, with a subject on the stage, one fixed row standing for every highlight of the subject — null
// unless at least one note is a highlight of it. Its count and latest time come from the
// notes the list already holds (no new query), so it is pure like `shown` and `apart`.
export const highlights = ({ notes, following, subject }) => {
  if (!following || subject == null) return null;
  const hs = notes.filter((n) => isHighlight(n, subject));
  return hs.length ? { count: hs.length, updatedAt: Math.max(...hs.map((n) => n.updatedAt)) } : null;
};

// The rows to show (D6): while following, with a subject on the stage, only the notes
// about it — a note always belongs to what is on the stage, so there is no "all notes"
// choice to fall back to. Only when nothing on the stage is a subject (a null subject,
// or the attribute off) is there nothing to scope by, and every note shows. The draft
// row is the view's, always on top of whichever set this returns.
export const shown = ({ notes, following, subject }) =>
  following && subject != null
    ? notes.filter((n) => isAbout(n, subject) && !isHighlight(n, subject))
    : notes;

// The note the editor has open, when it is not among the shown notes (12): a pinned
// note after the stage moved, or one still open after unpinning. Only while following a
// subject; otherwise the open note is always in the shown set, so there is nothing apart. Its row is the same row as any other; the
// view sets it apart. Computed from context, so no handler decides it: note.opened,
// subject.changed, note.changed and note.deleted keep the inputs current.
export const apart = ({ notes, following, subject, open }) => {
  if (!following || subject == null || open == null) return null;
  const note = notes.find((n) => n.id === open);
  return note && !isAbout(note, subject) && !isHighlight(note, subject) ? note : null;
};

// A Set with one id removed, as a new Set so assign sees a fresh value (XState keeps
// context immutable; the view re-renders on every snapshot regardless).
const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export const machine = setup({
  actors: {
    // The notes starting picture (4.3): note.changed / note.deleted are held for this
    // ask until its reply lands, so a change that races the start is applied after it.
    load: fromPromise(({ input }) => input.ask("notes", "list", {})),
    // The subject starting picture, asked as its own concern (3.5) so its reply — the
    // picture at read time — never overwrites a subject.changed that arrived first while
    // the notes list was still loading. On a reload the notes pull is slow and the book
    // on the stage comes back on its own after; batching the subject into the notes
    // reply would let that slow reply re-apply the read's stale null over the book.
    // subject.changed is held for this ask until its reply lands (subject: read
    // supersededBy), so it is applied after the starting picture, in order.
    readSubject: fromPromise(({ input }) =>
      input.following ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null })),
  },
}).createMachine({
  id: "note-list",
  meta: {
    kind: "view",
    emits: ["note.selected", "note.discarded", "highlights.selected"],
    // The subject attribute (D5): off is exactly today's behaviour — no subject ask,
    // no filtering, every note shown. On, the list shows only the notes about the
    // subject on the stage, with the Highlights row above them while the subject has
    // a highlight; there is no switch to all notes.
    attributes: ["subject"],
    asks: ["notes: list", "subject: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    // Whether the page set the `subject` attribute (D5); it arrives through input so
    // the machine stays importable in Node.
    following: Boolean(input.following),
    // Whether the Highlights row is the picked one (Decision 7). UI state: set when it is
    // picked, cleared when a note row is picked or the editor announces a note. Not kept
    // across a reload; the small mismatch after one is accepted (the list is not visible
    // while the item is shown, and the next pick corrects it).
    highlightsOpen: false,
    // The subject on the stage, learned from subject: read then subject.changed. Null
    // until the first reply, and whenever nothing on the stage is a subject.
    subject: null,
    // How long a discarded row can be brought back (the --duration-undo token, read
    // in the view and passed in so the machine stays importable in Node). The delete
    // is not a fact until this window ends (delayed delete): stop it and nothing was
    // emitted, so a fact is never "deleted" while a row still offers Undo.
    undoMs: input.undoMs,
    notes: [],
    // The note the editor is showing, learned from note.opened, never set on a
    // gesture: the list does not decide what is open.
    open: null,
    // The ids counting down to a discard, each with its own cancelable timer (below).
    // A row here shows struck through with an Undo where its trash was.
    discarding: new Set(),
    // The next note's id, always present: the first row, blank until the user types
    // and note.changed brings its real row, whereupon a fresh one is minted.
    draft: input.mint(),
  }),
  // The subject read runs for the machine's whole life (3.5), so the notes-load
  // transition (loading → ready) never cancels it: its reply lands on its own and sets
  // the subject, and the notes reply never writes the subject, so a slow notes reply
  // cannot re-apply the read's stale null over a subject.changed that arrived first.
  invoke: {
    src: "readSubject",
    input: ({ context }) => ({ ask: context.ask, following: context.following }),
    onDone: { actions: assign({ subject: ({ event }) => event.output.subject ?? null }) },
    onError: { actions: [] },
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output.notes),
            target: "ready",
            actions: assign({ notes: ({ event }) => sorted(event.output.notes.map(row)) }),
          },
          // notes could not answer (offline, no answerer): an honest empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {},
    failed: {},
  },
  on: {
    // The fact's news (4.3, fourth rule), followed in any state so a change that
    // races the starting query is not lost. A change for the draft's id means the
    // draft became a real note, so a fresh next-note id is minted above it.
    "note.changed": {
      actions: assign({
        notes: ({ context, event }) => upsert(context.notes, event),
        draft: ({ context, event }) => (context.draft === event.id ? context.mint() : context.draft),
      }),
    },
    // The fact confirms a note is gone (this device's own discard on elapse, or
    // another device's, 4.3 fourth rule): drop the row, unhighlight it if it was open,
    // and clear any countdown still standing for it.
    "note.deleted": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({
          notes: ({ context }) => context.notes.filter((n) => n.id !== event.id),
          open: ({ context }) => (context.open === event.id ? null : context.open),
          discarding: ({ context }) => without(context.discarding, event.id),
        });
        if (context.discarding.has(event.id)) enqueue.cancel(`undo:${event.id}`);
      }),
    },
    // The stage moved (4.3): the subject changed, so a different set of notes is about
    // it. Held for us until the starting subject: read reply lands, so it is never lost
    // and never applied before the picture it supersedes. Ignored when not following,
    // where it changes nothing shown.
    "subject.changed": {
      actions: assign({ subject: ({ event }) => event.subject }),
    },
    // The trash on a row, or a swipe past its threshold (5): begin the undo window.
    // Nothing is emitted yet; only its elapse makes the delete a fact.
    _discard: {
      guard: ({ context, event }) => context.notes.some((n) => n.id === event.id) && !context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(event.id) });
        enqueue.raise({ type: "_elapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `undo:${event.id}` });
      }),
    },
    // Undo, or a click anywhere on a counting-down row: cancel the window, emit nothing.
    _undo: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.cancel(`undo:${event.id}`);
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
      }),
    },
    // The window ran out (the timer above): now the delete is a fact (note.discarded),
    // which notes turns into a tombstone and the note.deleted that removes the row.
    _elapsed: {
      guard: ({ context, event }) => context.discarding.has(event.id),
      actions: enqueueActions(({ event, enqueue }) => {
        enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
        enqueue.emit({ type: "note.discarded", id: event.id });
      }),
    },
    // The editor announced the note it now shows (6.4): highlight that row, and the
    // Highlights row is no longer the picked one (Decision 7). The draft is untouched —
    // the next-note row stands whatever else is open, and its id is only a name, so
    // opening it again lands the editor in blank all the same.
    // The empty page is not a note opened, so the Highlights row keeps its mark (12).
    "note.opened": [
      { guard: ({ event }) => event.id === null, actions: assign({ open: null }) },
      { actions: assign({ open: ({ event }) => event.id, highlightsOpen: false }) },
    ],
    // The user picked a row (7.2, internal gesture): announce it, but only for a note
    // that exists or the next-note draft, never a stale id. `open` is not set here;
    // it follows the editor's note.opened, the same for the draft as any other row.
    // Picking a note clears the Highlights row's picked mark (Decision 7).
    _pick: {
      guard: ({ context, event }) =>
        !context.discarding.has(event.id) &&
        (context.notes.some((n) => n.id === event.id) || context.draft === event.id),
      actions: [
        assign({ highlightsOpen: false }),
        emit(({ event }) => ({ type: "note.selected", id: event.id })),
      ],
    },
    // The user picked the Highlights row (7.2, internal gesture; Decision 2, 7): announce
    // the gesture the container consumes to show the highlights document, and mark the row
    // as the picked one. Guarded on the row actually being shown, so a stale pick is inert.
    _pickHighlights: {
      guard: ({ context }) => highlights(context) != null,
      actions: [
        assign({ highlightsOpen: true }),
        emit(({ context }) => ({
          type: "highlights.selected",
          about: { kind: context.subject.kind, id: context.subject.id },
        })),
      ],
    },
  },
});
