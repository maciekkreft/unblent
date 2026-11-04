import { setup } from "xstate";

// A view component (3.1), planned (9, step 1): only its metadata and its contracts, so
// the components and contracts pages show it before it is built. The handlers below
// are named so the manifest reads what it consumes; they do nothing yet.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "expert-settings",
  meta: {
    description:
      "The Book experts tab of the gear's sheet, after Generators, shown while Book experts " +
      "is shown. One heading per book of the library, the Journal left out, with a caret " +
      "that folds it; which books are folded is kept in this browser, and a book without a " +
      "prompt starts folded. Under the heading, an On check box and the prompt box. On is " +
      "greyed, with a tooltip saying to write a prompt first, until the prompt holds text. " +
      "The prompt is saved as the user types and when the box is left. Each stretch of " +
      "typing and each On is one step Undo reverses.",
    kind: "view",
    emits: ["expert.edited"],
    attributes: [],
    asks: ["experts: list", "books: list", "settings: read", "session: read"],
  },
  on: {
    "expert.changed": planned,
    "book.changed": planned,
    "book.deleted": planned,
    "settings.changed": planned,
    "session.changed": planned,
  },
});
