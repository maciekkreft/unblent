import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the one door from the product into the workshop (§12).
// It owns no fact; which profile is active belongs to `settings`, reached by one
// query for the starting picture and settings.changed after (4.3, fourth rule).
// No settings on the page, or a reply without a profile (an older settings), means
// there is nothing to switch, so the view fails and renders nothing. The gesture is
// emitted as profile.switched naming the other profile; `settings` decides (and
// refuses it off the product page). The ask arrives through `input`, so the machine
// imports in Node.
const other = (profile) => (profile === "workshop" ? "product" : "workshop");

export const machine = setup({
  actors: {
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "profile-switch",
  meta: {
    description:
      "The one way from the product into the workshop and back. It is deliberately not a " +
      "visible signifier: it appears only on hover or focus (12, Two profiles). Which profile " +
      "is active belongs to `settings`, which refuses a switch on any page but the product.",
    kind: "view", emits: ["profile.switched"], attributes: [], asks: ["settings: read"],
  },
  context: ({ input }) => ({ ask: input.ask, profile: "workshop" }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error) || !event.output.profile, target: "failed" },
          { target: "ready", actions: assign({ profile: ({ event }) => event.output.profile }) },
        ],
        onError: { target: "failed" },
      },
    },
    ready: {
      on: {
        // Leading underscore (7.2): the user's click, never routed. The gesture names
        // the other profile; `settings` decides whether it changes anything.
        _toggle: {
          actions: emit(({ context }) => ({ type: "profile.switched", profile: other(context.profile) })),
        },
      },
    },
    failed: {},
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt the active profile whoever flipped it.
    "settings.changed": {
      actions: assign({ profile: ({ event }) => event.profile }),
    },
  },
});
