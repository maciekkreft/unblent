import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "rubric-editor",
  meta: {
    description:
      "Edits one tool, the item list-then-item shows under its Back bar: its name and its " +
      "questions. Each question chooses its kind, Yes / no or Pick one. A yes / no question has " +
      "optional words for what yes means and what no means; a pick-one question has options, " +
      "each a name and an optional description, starting with two empty ones. Every edit is " +
      "saved as the whole tool a short time into typing and when a field loses focus, and a tool " +
      "with nothing written in it is never saved. Removing a question or an option, and deleting " +
      "the tool, wait out the undo window, with Undo in a notice.",
    kind: "view",
    emits: ["rubric.saved", "removal.started"],
    attributes: [],
    asks: ["projects: read", "rubrics: read"],
  },
  on: {
    "rubric.selected": planned,
    "project.changed": planned,
    "rubric.changed": planned,
  },
});
