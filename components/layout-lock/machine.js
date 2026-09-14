import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the switch that locks or unlocks the desk layout. It
// owns no fact; whether the desk is locked, and whether this switch is shown,
// belong to `settings`, reached by one query for the starting picture and
// settings.changed after (4.3, fourth rule). No settings on the page (the ask
// replies no-answerer) means no lock, so the switch fails and renders nothing. The
// gesture is emitted as layout.locked; `settings` decides (and refuses it while the
// switch is hidden). The ask arrives through `input`, so the machine imports in Node.
export const machine = setup({
  actors: {
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "layout-lock",
  meta: { kind: "view", emits: ["layout.locked"], attributes: [], asks: ["settings: read"] },
  context: ({ input }) => ({ ask: input.ask, locked: false, hidden: false }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          {
            target: "ready",
            actions: assign({
              locked: ({ event }) => event.output.layoutLocked,
              hidden: ({ event }) => event.output.layoutLockHidden,
            }),
          },
        ],
        onError: { target: "failed" },
      },
    },
    ready: {
      on: {
        // Leading underscore (7.2): the user's click, never routed. The gesture is
        // emitted as-is; `settings` decides whether it changes anything.
        _toggle: {
          actions: emit(({ context }) => ({ type: "layout.locked", locked: !context.locked })),
        },
      },
    },
    failed: {},
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt it whoever caused the change.
    "settings.changed": {
      actions: assign({
        locked: ({ event }) => event.layoutLocked,
        hidden: ({ event }) => event.layoutLockHidden,
      }),
    },
  },
});
