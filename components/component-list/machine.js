import { setup, assign, fromPromise } from "xstate";

// A view component (3.1): one way of looking at the slip-box. It owns nothing
// but the list it is showing; the manifests belong to `catalog`, reached through
// one query (4.3, fourth rule: query for the starting picture). There is no
// `catalog.changed` to follow, by decision: manifests change on deploy, not in
// a session. The ask arrives through `input`, so the machine imports in Node.
export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("catalog", "list", {})),
  },
}).createMachine({
  id: "component-list",
  meta: { kind: "view", emits: [], attributes: [], asks: ["catalog: list"] },
  context: ({ input }) => ({ ask: input.ask, components: [], error: null }),
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
            actions: assign({ components: ({ event }) => event.output.components }),
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
