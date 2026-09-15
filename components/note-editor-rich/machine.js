import { setup, assign, fromPromise, enqueueActions, emit } from "xstate";

// A second member of the note-editor role (3.1, 7.3): the same editor concept —
// one text whose first line is the title — with a rich view that renders that
// first line larger. Its actor is note-editor's, verbatim, so the two share one
// contract (7.3) and the composer (3.6) can swap one for the other. Only the view
// differs. Everything with a side effect arrives through input, so this stays a
// pure definition importable in Node.

const THROTTLE_MS = 200;

// The note is one text and its title is the first line that says anything.
export function titleOf(body) {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : "";
}

const assignTyped = assign({ body: ({ event }) => event.body });

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
    unchanged: ({ context }) => context.sent != null && context.sent.body === context.body,
  },
  actions: {
    save: enqueueActions(({ context, enqueue }) => {
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
  id: "note-editor-rich",
  meta: {
    kind: "view",
    role: "note-editor",
    emits: ["note.saved", "note.opened"],
    attributes: ["height", "follows"],
    asks: ["notes: list", "notes: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    focus: input.focus,
    follows: input.follows,
    id: null,
    body: "",
    baseVersion: null,
    sent: null,
  }),
  initial: "starting",
  on: {
    load: {
      target: ".loading",
      actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null }),
    },
    "note.selected": {
      guard: ({ context }) => context.follows,
      target: ".loading",
      actions: assign({ id: ({ event }) => event.id, body: "", baseVersion: null, sent: null }),
    },
    focus: { actions: ({ context }) => context.focus() },
    "note.deleted": {
      guard: ({ context, event }) => event.id === context.id,
      target: ".empty",
      actions: assign({ id: null, body: "", baseVersion: null, sent: null }),
    },
    "note.changed": [
      {
        guard: ({ context, event }) =>
          event.id === context.id && context.sent != null && event.body === context.sent.body,
        actions: assign({ baseVersion: ({ event }) => event.version }),
      },
      {
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
    empty: {
      on: { _typed: mintAndType },
    },
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
            _typed: { actions: assignTyped },
            _blurred: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
          after: {
            [THROTTLE_MS]: [{ guard: "unchanged", target: "clean" }, { target: "clean", actions: "save" }],
          },
        },
      },
    },
    blank: {
      on: { _typed: { target: "editing.dirty", actions: assignTyped } },
    },
    failed: {},
  },
});
