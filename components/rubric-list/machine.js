import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "rubric-list",
  meta: {
    description:
      "Lists the tools of the current project and lets the user pick one to edit; it is the list " +
      "of a list-then-item pair in the Tools dock. New tool is always the first row and opens an " +
      "empty editor; the tool appears in the list once something is written in it. Each row has " +
      "a tick box that switches the tool on or off for judging, its name, greyed when off, and " +
      "how many questions it has. A line says only ticked tools are used when judging.",
    kind: "view",
    emits: ["rubric.selected", "rubric.switched"],
    attributes: [],
    asks: ["projects: read", "rubrics: read"],
  },
  on: {
    "project.changed": planned,
    "rubric.changed": planned,
  },
});
