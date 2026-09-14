import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the switch in the nav bar that signs in and out. It owns
// no fact; who is signed in, and whether a passkey may still be registered, belong
// to `session`, reached by one query for the starting picture and session.changed
// after (4.3, fourth rule). No session on the page (the ask replies no-answerer)
// means the switch fails and renders nothing, the way layout-switch does. The
// user's click is emitted as signin.requested or signout.requested; `session`
// decides. The ask arrives through `input`, so the machine imports in Node.
export const machine = setup({
  actors: {
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
}).createMachine({
  id: "session-switch",
  meta: {
    kind: "view",
    emits: ["signin.requested", "signout.requested"],
    attributes: [],
    asks: ["session: read"],
  },
  context: ({ input }) => ({ ask: input.ask, userId: null, registrationOpen: false }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          {
            target: "ready",
            actions: assign({
              userId: ({ event }) => event.output.userId,
              registrationOpen: ({ event }) => event.output.registrationOpen,
            }),
          },
        ],
        onError: { target: "failed" },
      },
    },
    ready: {
      on: {
        // Leading underscore (7.2): the user's click, never routed. The gesture is
        // emitted as-is; `session` decides whether it changes anything.
        _toggle: {
          actions: emit(({ context }) => ({
            type: context.userId ? "signout.requested" : "signin.requested",
          })),
        },
      },
    },
    failed: {},
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt it whoever caused the change. The
    // label also depends on registrationOpen, which the event carries when known,
    // so a full install relabels from "Create account" without a fresh query.
    "session.changed": {
      actions: assign({
        userId: ({ event }) => event.userId,
        registrationOpen: ({ context, event }) =>
          "registrationOpen" in event ? event.registrationOpen : context.registrationOpen,
      }),
    },
    // Consumed so the trace shows delivery; no state change yet (12: no surface for
    // a refused gesture). The no-op action is what makes XState register the handler,
    // so the bus subscribes it.
    "session.refused": { actions: () => {} },
  },
});
