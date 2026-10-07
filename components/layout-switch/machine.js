import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the switch that turns arranging the desk layout on and
// off. It owns no fact; whether the desk is being arranged, and whether this switch
// is shown, belong to `settings`, reached by one query for the starting picture and
// settings.changed after (4.3, fourth rule). No settings on the page (the ask
// replies no-answerer) means no arranging, so the switch fails and renders nothing.
// The gesture is emitted as layout.switched; `settings` decides (and refuses it
// while the switch is hidden). The ask arrives through `input`, so the machine
// imports in Node.
export const machine = setup({
  actors: {
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "layout-switch",
  meta: {
    description:
      "The switch that turns arranging the desk layout on and off. Whether arranging is on, and " +
      "whether the switch is shown at all, belong to `settings`; with no settings on the page " +
      "the switch shows nothing.",
    kind: "view", emits: ["layout.switched"], attributes: [], asks: ["settings: read"],
  },
  context: ({ input }) => ({ ask: input.ask, arranging: true, hidden: false }),
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
              arranging: ({ event }) => event.output.arranging,
              hidden: ({ event }) => event.output.layoutSwitchHidden,
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
          actions: emit(({ context }) => ({ type: "layout.switched", arranging: !context.arranging })),
        },
      },
    },
    failed: {},
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt it whoever caused the change.
    "settings.changed": {
      actions: assign({
        arranging: ({ event }) => event.arranging,
        hidden: ({ event }) => event.layoutSwitchHidden,
      }),
    },
  },
});
