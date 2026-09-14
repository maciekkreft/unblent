import { setup, assign, fromPromise, enqueueActions, emit } from "xstate";

// The view component that lists the notes and lets one be picked (6.4): it owns only
// UI state — the rows it is showing, which one the editor has open, and a draft id
// the + minted that has no row yet — and points at `notes`, which owns the fact. It
// asks notes: list for the starting picture and follows note.changed / note.deleted
// after (4.3, fourth rule); it never decides which row is open, it learns that from
// note.opened, so the highlighted row is always the note the editor is showing. The
// ask and mint arrive through input, so this stays a pure definition importable in
// Node.

// Newest first: updatedAt descending, id as the tiebreak, the same order notes uses
// in its list reply (notes.replyList), so a row keeps its place across a re-sort.
const order = (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
const sorted = (notes) => [...notes].sort(order);

// Fold one changed note into the rows: replace the row with its id if present, else
// add it, then re-sort. Only the fields a row shows are kept (a note.changed carries
// the whole note, 4.3, third rule).
const upsert = (notes, { id, title, updatedAt }) =>
  sorted([...notes.filter((n) => n.id !== id), { id, title, updatedAt }]);

export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("notes", "list", {})),
  },
}).createMachine({
  id: "note-list",
  meta: { kind: "view", emits: ["note.selected"], attributes: [], asks: ["notes: list"] },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    notes: [],
    // The note the editor is showing, learned from note.opened, never set on a
    // gesture: the list does not decide what is open.
    open: null,
    // An id the + minted that has no row yet: shown as a placeholder row until
    // note.changed brings the real row (or another note is opened).
    draft: null,
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output.notes),
            target: "ready",
            actions: assign({ notes: ({ event }) => sorted(event.output.notes) }),
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
    // real row has arrived, so the placeholder is dropped.
    "note.changed": {
      actions: assign({
        notes: ({ context, event }) => upsert(context.notes, event),
        draft: ({ context, event }) => (context.draft === event.id ? null : context.draft),
      }),
    },
    // Owned by notes, emitted by nobody yet (delete is a later task); consumed so the
    // list is right the day it is.
    "note.deleted": {
      actions: assign({ notes: ({ context, event }) => context.notes.filter((n) => n.id !== event.id) }),
    },
    // The editor announced the note it now shows (6.4). Highlight that row; a
    // different id opened means the + draft was abandoned, so drop it.
    "note.opened": {
      actions: assign({
        open: ({ event }) => event.id,
        draft: ({ context, event }) => (context.draft && context.draft !== event.id ? null : context.draft),
      }),
    },
    // The user picked a row (7.2, internal gesture): announce it, but only for a note
    // that exists or the pending draft, never a stale id.
    _pick: {
      guard: ({ context, event }) =>
        context.notes.some((n) => n.id === event.id) || context.draft === event.id,
      actions: emit(({ event }) => ({ type: "note.selected", id: event.id })),
    },
    // The + : mint an id, hold it as the draft (the placeholder row), and select it,
    // so an editor that follows opens a blank note under that id (6.4). `open` is not
    // set here; it follows the editor's note.opened, the same as any other pick.
    _new: {
      actions: enqueueActions(({ context, enqueue }) => {
        const id = context.mint();
        enqueue.assign({ draft: id });
        enqueue.emit({ type: "note.selected", id });
      }),
    },
  },
});
