import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the guest's free-use bar on a try page (8). It owns no fact:
// the share left belongs to `llm`, reached by one query for the starting picture and
// llm.changed after (4.3, fourth rule). The ask arrives through `input`, so the
// machine imports in Node. Start over leaves as a gesture, removal.started (4.3, fifth
// rule): notice-stack gives it its Undo window, and each fact that keeps starters starts
// over once it settles (8).

// What the bar shows for one llm picture (7.7): a visitor not yet a guest has all of
// it; a guest its own share; a signed-in account that is not a guest nothing.
export const shareOf = (picture) => {
  if (!picture || typeof picture !== "object" || picture.error) return null;
  if (!picture.signedIn) return 1;
  if (picture.freeUse) return Math.max(0, Math.min(1, picture.freeUse.left));
  return null;
};

// Whether the admin blocked this guest (7.7): then the trial has ended, whatever is left.
export const blockedOf = (picture) => Boolean(picture?.signedIn && picture?.freeUse?.blocked);

// The looks of the bar (try-links screen 2): plenty, 10% or less, used up, and ended
// for a blocked guest, so the bar never offers a share the guest cannot use.
export const levelOf = (share, blocked = false) =>
  share == null ? null : blocked === true ? "ended" : share <= 0 ? "out" : share <= 0.1 ? "low" : "plenty";

// The percentage as people read it: whole numbers, and never 0% while something is
// left, so the bar does not say nothing is left when a little is.
export const percentOf = (share) => (share <= 0 ? 0 : Math.max(1, Math.floor(share * 100)));

// One fixed id, so pressing Start over again restarts its notice rather than stacking a
// second one.
export const TRIAL = "00000000000000000000000RST";

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
      "While a limit for all guests is reached it still shows the guest's own share. " +
      "While the admin has blocked the guest it reads \"ended\" in the danger colour, " +
      "with an empty bar, beside \"This trial has ended.\" under Run. It " +
      "shows nothing for a signed-in account that is not a guest. Beside the bar, Start over " +
      "shows a notice, \"Starting over.\", with Undo; nothing changes until the notice ends, " +
      "and then the visitor's evaluators are replaced with fresh copies of the starters, " +
      "while what was spent stays.",
    kind: "view",
    emits: ["removal.started"],
    attributes: [],
    asks: ["llm: read"],
  },
  context: ({ input }) => ({ ask: input.ask, share: null, blocked: false }),
  invoke: {
    src: "llm",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ share: ({ event }) => shareOf(event.output), blocked: ({ event }) => blockedOf(event.output) }) },
    onError: { actions: [] },
  },
  on: {
    _startOver: { actions: emit({ type: "removal.started", kind: "trial", id: TRIAL, name: "" }) },
    "llm.changed": { actions: assign({ share: ({ event }) => shareOf(event), blocked: ({ event }) => blockedOf(event) }) },
  },
});
