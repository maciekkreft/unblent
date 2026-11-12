import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor is written. Built after `wheels`, which keeps the same kind of record.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "matrices",
  meta: {
    description:
      "Owns the Eisenhower Matrices kept with the journal's days, one per day. A matrix is a " +
      "list of tasks, each with its words, a tick, and the place the user put it: Do (urgent " +
      "and important), Schedule (important only), Delegate (urgent only) or Drop (neither), or " +
      "no place yet. The order of the tasks is their order inside each place. A task the user " +
      "has not placed is asked about once: the fact asks the built-in Eisenhower evaluator's two " +
      "questions, Urgent? and Important?, through `llm: decide`, and writes the suggested place " +
      "and whether it is sure; a task without a place shows at its suggestion, and with neither " +
      "in To sort. A place the user chose is final. Writing a suggestion is not a step, and " +
      "changing an unplaced task's words clears it so the task is asked again; an error leaves " +
      "the task in To sort until the next load. A matrix copied to a new day names the day it " +
      "came from. `matrices: list` answers one day's matrix, or the 20 newest when no day is " +
      "given. A matrix with no task is not kept, and a save that leaves none deletes it at once " +
      "with the short notice. Every change the user makes is a step Undo and Redo reverse " +
      "(section 12); a step is refused when the user's own fields were written since by anything " +
      "else, and when its journal day has closed, which it learns from the journal. It works " +
      "signed out, numbering versions itself, and syncs to the account when signed in (section " +
      "5). The last write wins, so two devices never conflict, and a deleted matrix is kept as a " +
      "tombstone, which always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["matrix.changed", "matrix.deleted", "step.recorded", "step.settled"],
    owns: "the Eisenhower Matrices kept with each journal day",
    steps: { "matrix.saved": "step" },
    asks: ["session: read", "journal: read", "evaluators: list", "llm: decide"],
  },
  on: {
    "list?": planned,
    "matrix.saved": planned,
    "step.undone": planned,
    "step.redone": planned,
    "session.changed": planned,
    "journal.changed": planned,
    "evaluator.changed": planned,
    "evaluator.deleted": planned,
  },
});
