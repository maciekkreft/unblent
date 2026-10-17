import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "evaluator-starters",
  meta: {
    description:
      "The Evaluators group of Starters in Administration, shown only to the admin: the " +
      "try page's link with Copy link, which copies it ready to paste, and the admin's " +
      "evaluators grouped by book, each with a tick. A new guest of the Evaluators try " +
      "page gets a copy of each ticked evaluator as it is " +
      "then, kept with the guest's Journal. Each later try page adds its own group as a " +
      "view of its own.",
    kind: "view",
    emits: ["starter.ticked"],
    attributes: [],
    asks: ["pages: list", "evaluators: list", "books: list"],
  },
  on: {
    "evaluator.changed": planned,
    "evaluator.deleted": planned,
    "book.changed": planned,
    "book.deleted": planned,
  },
});
