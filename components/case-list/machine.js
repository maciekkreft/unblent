import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "case-list",
  meta: {
    description:
      "Lists the cases of the current project, in the Cases dock. New case is always the first " +
      "row and opens an empty case. Each row shows the case's first line and its right answers " +
      "for the tools that are on, with a tick or a cross once Jev's answers are in: a tick when " +
      "every right answer matches. Judge all, above the list, judges every case with the tools " +
      "that are on and shows the Results tab, and a line under it says \"Judging 3 of 18…\" " +
      "while it runs; it is greyed out while a run is going or no tool is on, and the line beside " +
      "it says why. A line says cases are kept on this device.",
    kind: "view",
    emits: ["case.selected", "judging.requested", "results.selected"],
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
