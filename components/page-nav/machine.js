import { setup, assign, fromPromise } from "xstate";

// A view component (3.1): one way of looking at the slip-box, the links between
// its pages. It owns only the list it is showing and which page is current; the
// pages belong to `pages`, reached through one query (4.3, fourth rule: query
// for the starting picture). There is no `pages.changed` to follow, by decision:
// the set of pages changes on deploy, not in a session. `current` and the ask
// arrive through `input`, so the machine never touches `window` and imports in Node.
export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("pages", "list", {})),
  },
}).createMachine({
  id: "page-nav",
  meta: { kind: "view", emits: [], attributes: [], asks: ["pages: list"] },
  context: ({ input }) => ({ ask: input.ask, current: input.current, pages: [], error: null }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Boolean(event.output.error),
            target: "failed",
            actions: assign({ error: ({ event }) => event.output.error }),
          },
          {
            target: "ready",
            actions: assign({ pages: ({ event }) => event.output.pages }),
          },
        ],
        onError: {
          target: "failed",
          actions: assign({ error: "unavailable" }),
        },
      },
    },
    ready: {},
    failed: {},
  },
});
