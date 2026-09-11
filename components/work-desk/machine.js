import { setup, assign } from "xstate";

// A view component (3.1) that owns only UI state: which of its children is open.
// The children are views placed on the desk by the page; the desk is the root of
// their stem (8). Their names arrive through `input`, read from the DOM by the
// view, so the machine stays a pure definition importable in Node.
export const machine = setup({}).createMachine({
  id: "work-desk",
  meta: { kind: "view", emits: [], attributes: [] },
  context: ({ input }) => ({ views: input.views, open: input.views[0] ?? null }),
  initial: "ready",
  states: {
    ready: {
      on: {
        // Leading underscore (7.2): a user gesture forwarded by the view, an
        // internal message the bus never routes.
        _open: {
          guard: ({ context, event }) => context.views.includes(event.name),
          actions: assign({ open: ({ event }) => event.name }),
        },
      },
    },
  },
});
