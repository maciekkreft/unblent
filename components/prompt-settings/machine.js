import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor and the view are written. Built like `expert-settings`, with adding and
// deleting as in `evaluator-settings`.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "prompt-settings",
  meta: {
    description:
      "The Prompts tab of the gear's sheet, where the user writes the prompt sets a journal " +
      "prompts sheet asks. New set adds one at the top, open. Each set is folded under its name; " +
      "opened, it shows boxes for its name, its occasion and the book it is based on, then its " +
      "prompts, each with remove and move up and down, New prompt under them, and Delete set. " +
      "Every change is saved as one step Undo and Redo reverse; one stretch of typing in one box " +
      "is one step, and deleting a set shows the short notice whose Undo brings it back. The " +
      "arrow keys, and with Vim keys on j, k, gg and G, step through the sets and their boxes.",
    kind: "view",
    emits: ["prompt-set.saved"],
    asks: ["prompt-sets: list", "settings: read", "session: read"],
    attributes: [],
  },
  on: {
    "prompt-set.changed": planned,
    "prompt-set.deleted": planned,
    "settings.changed": planned,
    "session.changed": planned,
  },
});
