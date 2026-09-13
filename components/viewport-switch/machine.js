import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the control that lets the user pick the viewport the
// page is previewed in. It owns no fact; the viewport belongs to `viewport`,
// reached by one query for the starting picture and the `viewport.changed` event
// for everything after (4.3, fourth rule). The ask arrives through `input`, so the
// machine imports in Node.
export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("viewport", "read", {})),
  },
}).createMachine({
  id: "viewport-switch",
  meta: { kind: "view", emits: ["viewport.selected"], attributes: [], asks: ["viewport: read"] },
  context: ({ input }) => ({ ask: input.ask, viewport: null }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          { target: "ready", actions: assign({ viewport: ({ event }) => event.output.viewport }) },
        ],
        onError: { target: "failed" },
      },
    },
    ready: {},
    failed: {},
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt it whoever caused the change.
    "viewport.changed": {
      actions: assign({ viewport: ({ event }) => event.viewport }),
    },
    // Leading underscore (7.2): the user's click, never routed. The gesture is
    // emitted as-is; `viewport` decides whether it changes anything.
    _select: {
      actions: emit(({ event }) => ({ type: "viewport.selected", viewport: event.viewport })),
    },
  },
});
