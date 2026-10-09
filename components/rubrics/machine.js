import { setup } from "xstate";

// A planned local-only fact component (3.1, 9 step 1): metadata and the handlers its
// contract needs, no behaviour yet. "Tool" already names a chat lookup (7.7), so the
// Judge tool the user sees is a rubric inside the system.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "rubrics",
  meta: {
    description:
      "Owns the Judge tools of every project, kept on this device. A tool is a name, whether it " +
      "is switched on for judging, and a list of questions. A question is either yes / no, with " +
      "optional words for what yes means and what no means, or pick one, with options that each " +
      "have a name and an optional description; a question keeps its options while it is yes / " +
      "no, so switching its kind back loses nothing. A new tool starts switched on. Deleting a " +
      "tool, or removing a question or an option, waits out the undo window and is marked until " +
      "then, so the editor can show it and Judge leaves it out. The tools of a project that no " +
      "longer exists are dropped. A first visit starts with example tools in each example " +
      "project; a later version of the examples only adds what is new and never brings back a " +
      "tool the user deleted.",
    kind: "fact",
    shape: "local-only",
    owns: "the Judge tools of every project and their questions",
    emits: ["rubric.changed"],
  },
  on: {
    "rubric.saved": planned,
    "rubric.switched": planned,
    "removal.started": planned,
    "removal.undone": planned,
    "removal.settled": planned,
    "project.changed": planned,
    "read?": planned,
  },
});
