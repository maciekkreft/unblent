import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor is written. Built after `choice-points`, which keeps the same kind of record.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "wheels",
  meta: {
    description:
      "Owns the Wheels of Life kept with the journal's days. A wheel is eight fixed areas (Health, " +
      "Work, Money, Family, Love, Friends, Growth, Fun), each with an Actual and a Wanted score " +
      "from 1 to 10 or none. Each one names its journal day by date and keeps that day for good. " +
      "`wheels: list` answers one day's wheels, or every day's when no day is given, oldest first; " +
      "the chat does not read it. A new wheel with no score at all is not kept, and a save that " +
      "leaves a kept wheel with no score at all deletes it at once; its tombstone keeps the " +
      "scores it had. Every change is a step Undo and Redo reverse (section 12), and a delete " +
      "asks for the short notice. A step is refused when the wheel was written since by anything " +
      "else, and when its journal day has closed, which it learns from the journal. It works " +
      "signed out, numbering versions itself, and syncs to the account when signed in (section " +
      "5). The last write wins, so two devices never conflict, and a deleted wheel is kept as a " +
      "tombstone, which always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["wheel.changed", "wheel.deleted", "step.recorded", "step.settled"],
    owns: "the Wheels of Life kept with each journal day",
    steps: { "wheel.saved": "step" },
    asks: ["session: read", "journal: read"],
  },
  on: {
    "list?": planned,
    "wheel.saved": planned,
    "step.undone": planned,
    "step.redone": planned,
    "session.changed": planned,
    "journal.changed": planned,
  },
});
