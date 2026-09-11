import { setup, assign, fromPromise } from "xstate";

// A remote-only fact component (3.1): every component's manifest is server truth,
// read from each machine.js, so there is nothing to cache and nothing to emit. It
// answers two queries, `list` (the manifests) and `contracts` (the event, query
// and command vocabulary), and fails honestly with an error reply. Each query has
// its own loader and its own pending queue in its own region, so the two never
// wait on each other; both fetches arrive through `input`, so the machine is a
// pure definition importable in Node.
export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.load()),
    contracts: fromPromise(({ input }) => input.load()),
  },
}).createMachine({
  id: "catalog",
  meta: { kind: "fact", shape: "remote-only", emits: [], owns: "every component's manifest" },
  context: ({ input }) => ({
    list: input.list,
    contracts: input.contracts,
    pendingList: [],
    pendingContracts: [],
  }),
  type: "parallel",
  states: {
    list: {
      initial: "idle",
      states: {
        idle: {
          on: { "list?": { target: "loading", actions: "holdList" } },
        },
        // Queries arriving mid-fetch join it (4.2: every query gets exactly one
        // reply), so a page of many askers costs one round trip.
        loading: {
          on: { "list?": { actions: "holdList" } },
          invoke: {
            src: "list",
            input: ({ context }) => ({ load: context.list }),
            onDone: {
              target: "idle",
              actions: [
                ({ context, event }) => {
                  for (const reply of context.pendingList) reply({ components: event.output.components });
                },
                "releaseList",
              ],
            },
            onError: {
              target: "idle",
              actions: [
                ({ context }) => {
                  for (const reply of context.pendingList) reply({ error: "unavailable" });
                },
                "releaseList",
              ],
            },
          },
        },
      },
    },
    contracts: {
      initial: "idle",
      states: {
        idle: {
          on: { "contracts?": { target: "loading", actions: "holdContracts" } },
        },
        loading: {
          on: { "contracts?": { actions: "holdContracts" } },
          invoke: {
            src: "contracts",
            input: ({ context }) => ({ load: context.contracts }),
            onDone: {
              target: "idle",
              actions: [
                ({ context, event }) => {
                  for (const reply of context.pendingContracts)
                    reply({
                      events: event.output.events,
                      queries: event.output.queries,
                      commands: event.output.commands,
                    });
                },
                "releaseContracts",
              ],
            },
            onError: {
              target: "idle",
              actions: [
                ({ context }) => {
                  for (const reply of context.pendingContracts) reply({ error: "unavailable" });
                },
                "releaseContracts",
              ],
            },
          },
        },
      },
    },
  },
}).provide({
  actions: {
    holdList: assign({ pendingList: ({ context, event }) => [...context.pendingList, event.reply] }),
    releaseList: assign({ pendingList: [] }),
    holdContracts: assign({
      pendingContracts: ({ context, event }) => [...context.pendingContracts, event.reply],
    }),
    releaseContracts: assign({ pendingContracts: [] }),
  },
});
