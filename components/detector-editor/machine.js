import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "detector-editor",
  meta: {
    description:
      "Edits one of the journal's detectors, the third level of the Detectors dock: its name and " +
      "its questions, the same way Judge's detector editor does. Each question is Yes / no, with " +
      "optional words for what yes and no mean, or Pick one, with options that each have a name " +
      "and an optional description. Every edit is saved as the whole detector a short time into " +
      "typing and when a field loses focus, and a new detector with nothing written in it is " +
      "never saved. Rewording a question re-reads today's entry; earlier days keep their " +
      "answers. Removing a question or an option, and deleting the detector, wait out the undo " +
      "window, with Undo in a notice.",
    kind: "view",
    emits: ["detector.saved", "removal.started"],
    attributes: [],
    asks: ["journal: read"],
  },
  on: {
    "journal.changed": planned,
    "detector.selected": planned,
  },
});
