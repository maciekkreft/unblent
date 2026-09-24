// A fixture for the kit's wire harness (checks/tests/wire.test.mjs): a view that
// announces a gesture. Not a component; it lives under checks/tests, never served.
import { createMachine, emit } from "xstate";

export const machine = createMachine({
  id: "ping",
  meta: { kind: "view", emits: ["ping.sent"], attributes: [] },
  initial: "idle",
  states: {
    idle: {
      on: {
        go: { actions: emit(({ event }) => ({ type: "ping.sent", n: event.n })) },
      },
    },
  },
});
