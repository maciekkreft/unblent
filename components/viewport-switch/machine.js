import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the control that lets the user pick the viewport the
// page is previewed in. It owns no fact; the viewport belongs to `viewport` and
// whether this switch is shown to `settings`, each reached by one query for the
// starting picture and its `changed` event for everything after (4.3, fourth
// rule). The ask arrives through `input`, so the machine imports in Node.
export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("viewport", "read", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "viewport-switch",
  meta: {
    description:
      "The control that switches the page preview between the desk and a phone. The choice " +
      "belongs to `viewport`, and whether the switch is shown belongs to `settings`.",
    kind: "view", emits: ["viewport.selected"], attributes: [], asks: ["viewport: read", "settings: read"],
  },
  context: ({ input }) => ({ ask: input.ask, viewport: null, hidden: false }),
  initial: "loadingViewport",
  states: {
    loadingViewport: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          { target: "loadingSettings", actions: assign({ viewport: ({ event }) => event.output.viewport }) },
        ],
        onError: { target: "failed" },
      },
    },
    // Settings is optional: a page without it (the ask replies no-answerer) keeps
    // the switch shown, exactly as before settings existed.
    loadingSettings: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "ready" },
          { target: "ready", actions: assign({ hidden: ({ event }) => event.output.viewportSwitchHidden }) },
        ],
        onError: { target: "ready" },
      },
    },
    ready: {},
    failed: {},
  },
  on: {
    // The facts' news (4.3, fourth rule): adopt them whoever caused the change.
    "viewport.changed": {
      actions: assign({ viewport: ({ event }) => event.viewport }),
    },
    "settings.changed": {
      actions: assign({ hidden: ({ event }) => event.viewportSwitchHidden }),
    },
    // Leading underscore (7.2): the user's click, never routed. The gesture is
    // emitted as-is; `viewport` decides whether it changes anything.
    _select: {
      actions: emit(({ event }) => ({ type: "viewport.selected", viewport: event.viewport })),
    },
  },
});
