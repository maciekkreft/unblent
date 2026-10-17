import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "people-list",
  meta: {
    description:
      "The People part of Administration, shown only to the admin. At the top, tiles " +
      "show what all guests spent of their limit, what each provider's guest key spent, " +
      "and how many guests there are. Below, a table lists every account: you as admin " +
      "first, then guests newest first, each with when they were first and last seen, " +
      "where they are, their browser, system and phone or desk, what they used as a " +
      "small bar and in dollars, and the space their work takes. Each guest row offers " +
      "View as, Reset use, and Block or Unblock. Reset use and Block show an Undo for " +
      "the undo window; View as is reversed by Back to you. The table scrolls sideways " +
      "on a narrow screen.",
    kind: "view",
    emits: ["viewas.requested", "guest.blocked", "use.reset"],
    attributes: [],
    asks: ["session: people", "llm: spending"],
  },
  on: {
    "people.changed": planned,
    "spending.changed": planned,
  },
});
