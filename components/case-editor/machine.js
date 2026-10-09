import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "case-editor",
  meta: {
    description:
      "The Case tab: the open case's text, and its right answers, one menu per question of the " +
      "tools that are on, each starting at \"No right answer\". Every edit is saved as the whole " +
      "case a short time into typing and when a field loses focus, and a new case is kept once " +
      "something is written in it. Judge judges this case with the tools that are on; a line " +
      "beside it says which tools, or why it cannot run. Below, one card per tool shows Jev's " +
      "answers: for a pick-one question the pick, how sure Jev is and a bar per option; for yes " +
      "/ no questions a bar each with the chance of yes; and a tick, or a cross with the right " +
      "answer, wherever a right answer is set. Delete case waits out the undo window.",
    kind: "view",
    emits: ["case.saved", "judging.requested", "removal.started"],
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
