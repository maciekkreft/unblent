import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor is written. Built like `choice-points`, with the check asked as `matrices`
// asks its suggestion.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "prompt-sheets",
  meta: {
    description:
      "Owns the journal prompts sheets kept with the journal's days, any number per day. A sheet " +
      "names the prompt set it was started from and keeps that set's name and the book it is " +
      "based on, and holds one answer per prompt with the prompt's text stored beside it, so an " +
      "earlier day still reads as it was answered after the set changes or is deleted. Each sheet " +
      "names its journal day by date and keeps that day for good. A sheet with no answer text is " +
      "not kept, and a save that empties every answer of a kept one deletes it at once. When the " +
      "user finishes a stretch of typing on an answer, the fact asks the built-in Answers the " +
      "prompt evaluator, through `llm: decide`, whether each answer not judged yet responds to " +
      "what its prompt asks, once for each prompt and answer, and stores the result as fits: " +
      "true, false, or none when it could not tell; \"I don't know\" counts as an answer. Writing " +
      "fits is not a step. `prompt-sheets: list` answers one day's or one set's sheets, or the 20 " +
      "newest, newest first, with how many match in all, and `prompt-sheets: open` answers one " +
      "sheet by its id; the chat may use them as lookups, Reading journal prompts and Reading a " +
      "journal prompts sheet. Every change the user makes is a step Undo and Redo reverse " +
      "(section 12): one stretch of typing in one sheet, until a save says it finished, and a " +
      "removal from the day, which asks for the short notice. A step is refused when the sheet " +
      "was written since by anything else, and when its journal day has closed, which it learns " +
      "from the journal. It works signed out, numbering versions itself, and syncs to the " +
      "account when signed in (section 5). The last write wins, so two devices never conflict, " +
      "and a deleted sheet is kept as a tombstone, which always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["prompt-sheet.changed", "prompt-sheet.deleted", "step.recorded", "step.settled"],
    owns: "the journal prompts sheets kept with each journal day",
    steps: { "prompt-sheet.saved": "step" },
    asks: ["session: read", "journal: read", "evaluators: list", "llm: decide"],
  },
  on: {
    "list?": planned,
    "open?": planned,
    "prompt-sheet.saved": planned,
    "step.undone": planned,
    "step.redone": planned,
    "session.changed": planned,
    "journal.changed": planned,
    "evaluator.changed": planned,
    "evaluator.deleted": planned,
  },
});
