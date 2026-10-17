import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "guest-limits",
  meta: {
    description:
      "The Limits and Guest keys parts of Administration, shown only to the admin, laid " +
      "out like Settings: a name on the left, its control on the right. Limits are in " +
      "dollars and counted since the start: each guest in total, all guests in total, " +
      "and each provider for all guests, which starts with no own limit. A note says " +
      "the prices used. Guest keys are one per provider, entered like the keys on the " +
      "Settings tab, with Key saved, Replace and Remove; guests spend only on these, " +
      "and a provider without a guest key is not offered to guests. Every change " +
      "applies at once.",
    kind: "view",
    emits: ["limits.edited", "guestkeys.edited"],
    attributes: [],
    asks: ["llm: spending"],
  },
  on: {
    "spending.changed": planned,
  },
});
