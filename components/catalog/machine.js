import { setup, assign, fromPromise } from "xstate";

// A remote-only fact component (3.1): every component's manifest is server truth,
// read from each machine.js, so there is nothing to cache and nothing to emit. It
// answers one query, `list`, and fails honestly with an error reply. The fetch
// arrives through `input`, so the machine is a pure definition importable in Node.
export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.load()),
  },
}).createMachine({
  id: "catalog",
  meta: { kind: "fact", shape: "remote-only", emits: [], owns: "every component's manifest" },
  context: ({ input }) => ({ load: input.load, pending: [] }),
  initial: "idle",
  states: {
    idle: {
      on: {
        "list?": { target: "loading", actions: "hold" },
      },
    },
    // Queries arriving mid-fetch join it (4.2: every query gets exactly one reply),
    // so a page of many askers costs one round trip.
    loading: {
      on: {
        "list?": { actions: "hold" },
      },
      invoke: {
        src: "load",
        input: ({ context }) => ({ load: context.load }),
        onDone: {
          target: "idle",
          actions: [
            ({ context, event }) => {
              for (const reply of context.pending) reply({ components: event.output.components });
            },
            "release",
          ],
        },
        onError: {
          target: "idle",
          actions: [
            ({ context }) => {
              for (const reply of context.pending) reply({ error: "unavailable" });
            },
            "release",
          ],
        },
      },
    },
  },
}).provide({
  actions: {
    hold: assign({ pending: ({ context, event }) => [...context.pending, event.reply] }),
    release: assign({ pending: [] }),
  },
});
