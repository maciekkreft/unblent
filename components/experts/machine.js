import { setup } from "xstate";

// A replicated fact component (3.1), planned (9, step 1): only its metadata and its
// contracts, so the components and contracts pages show it before it is built. The
// handlers below are named so the manifest reads what it answers and consumes; they
// do nothing yet.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "experts",
  meta: {
    description:
      "Owns the book experts: for each book, a prompt the user writes for an expert on it and " +
      "whether that expert is on. An expert that is on shows on the shelf above a new chat, " +
      "and the prompt of the one picked joins that chat's start. `experts: list` answers " +
      "every expert written and expert.changed announces each change. A change made in the " +
      "Book experts tab (expert.edited) carries only the fields changed and is a step Undo " +
      "and Redo reverse (section 12): typing on in one prompt stays one step until the box is " +
      "left or anything else changes, and each On switch is a step of its own. An expert " +
      "whose book is gone is kept but never shown, because the views list only the books " +
      "`books: list` answers. Replicated (5): it works signed out and syncs to the account " +
      "when signed in, so the experts are the same on every device; the last write wins and " +
      "nothing is deleted.",
    kind: "fact",
    shape: "replicated",
    owns: "the book experts",
    steps: { "expert.edited": "step" },
    emits: ["expert.changed", "step.recorded", "step.settled"],
  },
  on: {
    "list?": planned,
    "expert.edited": planned,
    "session.changed": planned,
    "step.undone": planned,
    "step.redone": planned,
    "step.dropped": planned,
  },
});
