import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor is written. Built like `choice-points`, which keeps the same kind of record.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "prompt-sets",
  meta: {
    description:
      "Owns the account's prompt sets: the lists of the user's own questions a journal prompts " +
      "sheet asks. A set has a name, an occasion (a short label such as Morning, Evening or Hard " +
      "moment), the book and author it is based on, which may be empty, its prompts in the order " +
      "they are asked, and its place in the list. Ten starter sets based on well-known books come " +
      "with the app, in our own words, crediting the book and never quoting it. They have fixed " +
      "ids and are written to the account the first time its list is empty, as writes that can " +
      "be repeated harmlessly, so two devices never add them twice, and a starter the user " +
      "deleted stays deleted. `prompt-sets: list` answers every set in list order. Every change " +
      "is a step Undo and Redo reverse (section 12): adding, editing or deleting a set, and a " +
      "delete asks for the short notice. A step is refused when the set was written since by " +
      "anything else. It works signed out, numbering versions itself, and syncs to the account " +
      "when signed in (section 5). The last write wins, so two devices never conflict, and a " +
      "deleted set is kept as a tombstone, which always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["prompt-set.changed", "prompt-set.deleted", "step.recorded", "step.settled"],
    owns: "the account's prompt sets",
    steps: { "prompt-set.saved": "step" },
    asks: ["session: read"],
  },
  on: {
    "list?": planned,
    "prompt-set.saved": planned,
    "step.undone": planned,
    "step.redone": planned,
    "session.changed": planned,
  },
});
