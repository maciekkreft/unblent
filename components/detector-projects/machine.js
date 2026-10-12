import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "detector-projects",
  meta: {
    description:
      "The journal's projects, the first level of the Detectors dock. New project is the first " +
      "row and adds a project with its name ready to write. Each row has a tick box that " +
      "switches the project on or off, its name, and how many of its detectors are on; picking a " +
      "row shows its detectors. A line says only ticked projects read the writing. Unticking a " +
      "project keeps each detector's own tick.",
    kind: "view",
    emits: ["detector-project.selected", "detector-project.switched", "detector-project.saved"],
    attributes: [],
    asks: ["journal: read"],
  },
  on: {
    "journal.changed": planned,
  },
});
