import { setup, assign, fromPromise, enqueueActions, emit } from "xstate";

// The view component for editing one note (3.1): owns only its own UI state — the
// draft, which state it is in — and points at `notes`, which owns the fact. On
// start it asks notes: list and reopens the newest note, or takes a note by the
// load command or, when it carries `follows`, by note.selected from the list (both
// ask notes: read); it follows note.changed after (4.3), and emits note.saved at a
// short throttle while the user types, and on blur. It announces the note it is showing with note.opened whenever
// its id changes, so a list can highlight that row (6.4). Everything with a side
// effect — the queries, minting an id, focusing the input — arrives through input,
// so this stays a pure definition importable in Node.

// Short enough that a view following note.changed stays live while the user types,
// long enough that it is not a save per keystroke (4.3, third rule): a coalescing
// throttle, not a debounce. A duration, not a length that places a box, so it is a
// plain constant rather than a token (7.4).
const THROTTLE_MS = 200;

// The note is one text and its title is the first line that says anything, as in
// Notes.app: a convention of this editor, not of the contract, which still carries
// title and body. body is the whole text, so a reader shows body alone.
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : "";
}

const assignTyped = assign({ body: ({ event }) => event.body });

// A first keystroke into an editor holding no note mints its id (a ULID, the
// browser's own, 5) and starts editing it. The id changed, so the note it now shows
// is announced (note.opened), the same as a load or a reopen does on entering
// `loading`.
const mintAndType = {
  target: "editing.dirty",
  actions: enqueueActions(({ context, event, enqueue }) => {
    const id = context.mint();
    enqueue.assign({ id, body: event.body });
    enqueue.emit({ type: "note.opened", id });
  }),
};

export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("notes", "list", {})),
    read: fromPromise(({ input }) => input.ask("notes", "read", { id: input.id })),
  },
  guards: {
    // The text is what notes already holds (what we last sent, loaded, or adopted),
    // so a pause here is not a change: no note.saved, no new version. The title is
    // derived from the text, so equal text is equal title.
    unchanged: ({ context }) => context.sent != null && context.sent.body === context.body,
  },
  actions: {
    save: enqueueActions(({ context, enqueue }) => {
      // What was sent, so the echo of this save (a note.changed carrying it back)
      // is told apart from a real change from elsewhere, and a later pause that
      // ends on the same text saves nothing.
      enqueue.assign({ sent: { body: context.body } });
      enqueue.emit({
        type: "note.saved",
        id: context.id,
        title: titleOf(context.body),
        body: context.body,
        baseVersion: context.baseVersion,
      });
    }),
  },
}).createMachine({
  id: "note-editor",
  meta: {
    kind: "view",
    emits: ["note.saved", "note.opened"],
    attributes: ["height", "follows"],
    asks: ["notes: list", "notes: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    focus: input.focus,
    // Present: this editor loads whatever the list selects (6.4). Absent: it ignores
    // note.selected, so a future page with several editors leaves it off and a
    // container tells one editor to load by command instead.
    follows: input.follows,
    id: null,
    body: "",
    baseVersion: null,
    sent: null,
  }),
  initial: "starting",
  on: {
    // A command addressing this instance (4.4). Nobody sends load yet (it arrives
    // with split-view); the machine handles it so the contract exists.
    load: {
      target: ".loading",
      actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null }),
    },
    // The list's gesture (4.3, fifth rule), taken only when this editor follows the
    // selection. Same landing as load: ask notes for the note, and announce it
    // (note.opened, on entering `loading`). An unfollowing editor leaves it to the
    // bus to record as ignored.
    "note.selected": {
      guard: ({ context }) => context.follows,
      target: ".loading",
      actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null }),
    },
    focus: { actions: ({ context }) => context.focus() },
    // The fact's news that the open note is gone (4.3, fourth rule): fall back to the
    // empty page, where a keystroke starts a fresh note. A deletion of another note is
    // left to the bus to record as ignored.
    "note.deleted": {
      guard: ({ context, event }) => event.id === context.id,
      target: ".empty",
      actions: assign({ id: null, body: "", baseVersion: null, sent: null }),
    },
    // The fact's news (4.3, fourth rule). Guarded so a change for another id is left
    // to the bus to record as ignored.
    "note.changed": [
      {
        // The echo of this editor's own save: only bump baseVersion, and stay in
        // the current state so a keystroke made since is not lost.
        guard: ({ context, event }) =>
          event.id === context.id && context.sent != null && event.body === context.sent.body,
        actions: assign({ baseVersion: ({ event }) => event.version }),
      },
      {
        // A newer change from elsewhere: adopt it (the user's decision, 12), even
        // over a dirty draft. A first note.changed (baseVersion null) counts.
        guard: ({ context, event }) =>
          event.id === context.id && (context.baseVersion === null || event.version > context.baseVersion),
        target: ".editing.clean",
        actions: assign({
          body: ({ event }) => event.body,
          baseVersion: ({ event }) => event.version,
          sent: ({ event }) => ({ body: event.body }),
        }),
      },
    ],
  },
  states: {
    // The starting picture (4.3, fourth rule): the newest note there is, so a
    // reload continues where the user left off. A keystroke meanwhile is the user's
    // answer instead, and leaving the state drops the query's reply.
    starting: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => event.output.notes?.length > 0,
            target: "loading",
            actions: assign({ id: ({ event }) => event.output.notes[0].id }),
          },
          { target: "empty" },
        ],
        onError: "empty",
      },
      on: { _typed: mintAndType },
    },
    // No note yet: typing starts one.
    empty: {
      on: { _typed: mintAndType },
    },
    // A load command, a follow of the list's selection, or the start asked notes for
    // the note; the reply decides where we land. Entering here the id has just
    // changed, so the note now shown is announced once (note.opened), covering all
    // three ways in.
    loading: {
      entry: emit(({ context }) => ({ type: "note.opened", id: context.id })),
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.id }),
        onDone: [
          {
            guard: ({ event }) => "note" in event.output,
            target: "editing.clean",
            actions: assign({
              body: ({ event }) => event.output.note.body,
              baseVersion: ({ event }) => event.output.note.version,
              sent: ({ event }) => ({ body: event.output.note.body }),
            }),
          },
          { guard: ({ event }) => event.output.error === "not-found", target: "blank" },
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    editing: {
      initial: "clean",
      states: {
        clean: {
          on: { _typed: { target: "dirty", actions: assignTyped } },
        },
        dirty: {
          on: {
            // Targetless so the `after` window is not restarted: keystrokes made
            // within it join the one save at its end rather than pushing it back,
            // which is what makes this a throttle, not a debounce (4.3, third rule).
            _typed: { actions: assignTyped },
            _blurred: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
          after: {
            [THROTTLE_MS]: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
        },
      },
    },
    // notes holds no note with this id: the id is a name for a note not yet written
    // — a fresh one the list minted with its +, or a stale one — and typing here
    // creates it. A null base under an id notes does not hold upserts as version 1
    // (notes.applySave), so nothing here differs from an editor that just minted.
    blank: {
      on: { _typed: { target: "editing.dirty", actions: assignTyped } },
    },
    failed: {},
  },
});
