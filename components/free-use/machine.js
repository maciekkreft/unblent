import { setup, assign, fromPromise } from "xstate";

// A view component (3.1): the guest's free-use bar on a try page (8). It owns no fact:
// the share left belongs to `llm`, reached by one query for the starting picture and
// llm.changed after (4.3, fourth rule). The ask arrives through `input`, so the
// machine imports in Node.

// What the bar shows for one llm picture (7.7): a visitor not yet a guest has all of
// it; a guest its own share; a signed-in account that is not a guest nothing.
export const shareOf = (picture) => {
  if (!picture || typeof picture !== "object" || picture.error) return null;
  if (!picture.signedIn) return 1;
  if (picture.freeUse) return Math.max(0, Math.min(1, picture.freeUse.left));
  return null;
};

// The three looks of the bar (try-links screen 2): plenty, 10% or less, used up.
export const levelOf = (share) => (share == null ? null : share <= 0 ? "out" : share <= 0.1 ? "low" : "plenty");

// The percentage as people read it: whole numbers, and never 0% while something is
// left, so the bar does not say nothing is left when a little is.
export const percentOf = (share) => (share <= 0 ? 0 : Math.max(1, Math.floor(share * 100)));

export const machine = setup({
  actors: {
    llm: fromPromise(({ input }) => input.ask("llm", "read", {})),
  },
}).createMachine({
  id: "free-use",
  meta: {
    description:
      "The guest's free-use bar on a try page: \"Free use\", a bar and \"N% left\", the " +
      "share of the guest's own allowance that is left, never an amount. It shows 100% " +
      "until the guest first uses something. At 10% or less it turns to the warning " +
      "colour, and when nothing is left it reads \"used up\" in the danger colour. " +
      "While a limit for all guests is reached it still shows the guest's own share. It " +
      "shows nothing for a signed-in account that is not a guest.",
    kind: "view",
    emits: [],
    attributes: [],
    asks: ["llm: read"],
  },
  context: ({ input }) => ({ ask: input.ask, share: null }),
  invoke: {
    src: "llm",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ share: ({ event }) => shareOf(event.output) }) },
    onError: { actions: [] },
  },
  on: {
    "llm.changed": { actions: assign({ share: ({ event }) => shareOf(event) }) },
  },
});
