import { setup } from "xstate";

// A planned local-only fact component (3.1, 9 step 1): metadata and the handlers its
// contract needs, no behaviour yet.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "cases",
  meta: {
    description:
      "Owns the Judge cases of every project, kept on this device. A case is a text to judge and " +
      "its right answers, one per question at most: yes or no for a yes / no question, or one of " +
      "the options for a pick-one question. A question with no right answer is judged but not " +
      "counted. Each project remembers which case is open, which may be a new case not yet " +
      "written; a new case is kept once something is written in it. A deleted case waits out " +
      "the undo window, and while it waits the next case is open. The cases of a project that " +
      "no longer exists are dropped. A first visit starts with example cases and their right " +
      "answers in each example project.",
    kind: "fact",
    shape: "local-only",
    owns: "the Judge cases, their right answers and the open case of each project",
    emits: ["case.changed"],
  },
  on: {
    "case.saved": planned,
    "case.selected": planned,
    "removal.started": planned,
    "removal.undone": planned,
    "removal.settled": planned,
    "project.changed": planned,
    "read?": planned,
  },
});
