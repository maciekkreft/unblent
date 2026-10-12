import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "detector-list",
  meta: {
    description:
      "The detectors of the journal project picked in the Detectors dock, the second level. At " +
      "the top the project can be renamed or deleted; deleting waits out the undo window, with " +
      "Undo in a notice. New detector is the first row and opens an empty editor; the detector " +
      "appears in the list once something is written in it. Each row has a tick box that " +
      "switches the detector on or off, its name, greyed when off, and how many questions it " +
      "has. A line says a detector reads the writing only when it and its project are both " +
      "ticked.",
    kind: "view",
    emits: ["detector.selected", "detector.switched", "detector-project.saved", "removal.started"],
    attributes: [],
    asks: ["journal: read"],
  },
  on: {
    "journal.changed": planned,
    "detector-project.selected": planned,
  },
});
