import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
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
  on: {
    "llm.changed": planned,
  },
});
