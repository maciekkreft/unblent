import { setup, assign, fromPromise } from "xstate";

// A view component (3.1): one way of looking at the slip-box, its shared
// vocabulary. It owns nothing but what it is showing; the contracts belong to
// `catalog`, reached through one query (4.3, fourth rule: query for the starting
// picture). There is no `catalog.changed` to follow, by decision: the vocabulary
// changes on deploy, not in a session. The ask arrives through `input`, so the
// machine imports in Node.
export const machine = setup({
  actors: {
    contracts: fromPromise(({ input }) => input.ask("catalog", "contracts", {})),
  },
}).createMachine({
  id: "contract-list",
  meta: { kind: "view", emits: [], attributes: [], asks: ["catalog: contracts"] },
  context: ({ input }) => ({ ask: input.ask, events: [], queries: [], commands: [], error: null }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "contracts",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Boolean(event.output.error),
            target: "failed",
            actions: assign({ error: ({ event }) => event.output.error }),
          },
          {
            target: "ready",
            actions: assign({
              events: ({ event }) => event.output.events,
              queries: ({ event }) => event.output.queries,
              commands: ({ event }) => event.output.commands,
            }),
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
