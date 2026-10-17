import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the bar shown while the admin views as someone (12). It owns
// only what it shows; whom the browser holds belongs to `session`, read once for the
// starting picture and followed after (4.3, fourth rule). Back to you is the admin's
// gesture, which session carries out. The ask arrives through `input`, so the machine
// imports in Node.

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
}).createMachine({
  id: "viewas-bar",
  meta: {
    description:
      "While the admin views as someone, a bar fixed above everything on every page, on " +
      "the desk and the phone: \"Viewing as Guest 14 · what you change is changed for " +
      "them\" and Back to you, which hands the browser back to the admin. While the browser " +
      "changes back it says so and Back to you waits. It shows nothing otherwise.",
    kind: "view",
    emits: ["viewas.requested"],
    attributes: [],
    asks: ["session: read"],
  },
  context: ({ input }) => ({ ask: input.ask, viewingAs: null, leaving: false }),
  initial: "ready",
  invoke: {
    src: "read",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ viewingAs: ({ event }) => event.output?.viewingAs ?? null }) },
  },
  states: { ready: {} },
  on: {
    "session.changed": {
      actions: assign(({ event }) => ({ viewingAs: event.viewingAs ?? null, leaving: event.leaving === true })),
    },
    // Back to you (12): only while viewing as someone, and once.
    _back: {
      guard: ({ context }) => Boolean(context.viewingAs) && !context.leaving,
      actions: emit({ type: "viewas.requested", user: null }),
    },
  },
});
