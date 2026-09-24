// A fixture for the kit's wire harness (checks/tests/wire.test.mjs): a view that
// follows ping's gesture and hands each number to the `sink` its input gives it.
import { assign, createMachine } from "xstate";

export const machine = createMachine({
  id: "pong",
  meta: { kind: "view", emits: [], attributes: [] },
  context: ({ input }) => ({ got: [], sink: input?.sink ?? null }),
  initial: "idle",
  states: {
    idle: {
      on: {
        "ping.sent": {
          actions: [
            assign({ got: ({ context, event }) => [...context.got, event.n] }),
            ({ context, event }) => context.sink?.(event.n),
          ],
        },
      },
    },
  },
});
