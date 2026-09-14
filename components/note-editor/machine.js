import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The view component for editing one note (3.1): owns only its own UI state — the
// draft, which state it is in — and points at `notes`, which owns the fact. On
// start it asks notes: list and reopens the newest note, or takes a note by the
// load command (asks notes: read), follows note.changed after (4.3), and emits
// note.saved when the user pauses. Everything with a side effect — the queries,
// minting an id, focusing the input — arrives through input, so this stays a pure
// definition importable in Node.

// A pause, not a keystroke (4.3, third rule): the draft is emitted after the user
// stops typing, not per character. A duration, not a length that places a box, so
// it is a plain constant rather than a token (7.4).
const DEBOUNCE_MS = 800;

// The note is one text and its title is the first line that says anything, as in
// Notes.app: a convention of this editor, not of the contract, which still carries
// title and body. body is the whole text, so a reader shows body alone.
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : "";
}

const assignTyped = assign({ body: ({ event }) => event.body });

// A first keystroke into an editor holding no note mints its id (a ULID, the
// browser's own, 5) and starts editing it.
const mintAndType = {
  target: "editing.dirty",
  actions: assign({ id: ({ context }) => context.mint(), body: ({ event }) => event.body }),
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
  meta: { kind: "view", emits: ["note.saved"], attributes: ["height"], asks: ["notes: list", "notes: read"] },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    focus: input.focus,
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
    focus: { actions: ({ context }) => context.focus() },
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
    // A load command, or the start, asked notes for the note; the reply decides
    // where we land.
    loading: {
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
          { guard: ({ event }) => event.output.error === "not-found", target: "missing" },
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
            _typed: { target: "dirty", reenter: true, actions: assignTyped }, // restart the pause timer
            _blurred: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
          after: {
            [DEBOUNCE_MS]: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
        },
      },
    },
    // notes has no such note, or could not answer. A load command leaves either.
    missing: {},
    failed: {},
  },
});
