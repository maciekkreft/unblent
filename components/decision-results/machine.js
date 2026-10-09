import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "decision-results",
  meta: {
    description:
      "The Results tab: for every question of a tool that is on, over the cases that have a " +
      "right answer for it and an answer from Jev, how many Jev got right (\"16 of 18 right\"), " +
      "how many it got right for each right answer, a table of what Jev picked against the right " +
      "answer, and the misses. Clicking a miss opens its case. While a run is going the results " +
      "are dimmed under its progress line. With no tool on, no case or nothing judged yet, it " +
      "says what to do first.",
    kind: "view",
    emits: ["case.selected"],
    attributes: [],
    asks: ["projects: read", "cases: read", "rubrics: read", "decisions: read"],
  },
  on: {
    "project.changed": planned,
    "case.changed": planned,
    "rubric.changed": planned,
    "decision.changed": planned,
  },
});
