import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor and the view are written. Built like `choice-point-cards`.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "prompt-sheet",
  meta: {
    description:
      "Shows the journal prompts sheets of the journal day on the page, under the day's text; a " +
      "day with none shows nothing and takes no room. The add command, from Journal prompts " +
      "under + Add sheet, opens a new sheet on a day that can be written, showing the user's " +
      "prompt sets to pick from, each with its occasion and the book it is based on, and Manage " +
      "sets, which opens the Prompts tab. Picking a set shows each of its prompts with an answer " +
      "box under it. What is written is saved a short time into typing and at once when a box " +
      "loses focus. An answer the check judged not to respond to its prompt shows the question " +
      "icon at the end of its box, with the hint \"This may answer something other than the " +
      "question\" and the prompt repeated under it; an answer that fits shows nothing. Done, or " +
      "Escape, folds the sheet into a read-only card with the set's name and every answered " +
      "prompt; pressing the card opens it again. Remove from this day takes the sheet away with " +
      "the short notice whose Undo brings it back. A sheet is written exactly while the day's own " +
      "text is; an earlier day's sheet is read only, with Close in place of Done, and says so " +
      "when its set has changed since. The arrow keys, and with Vim keys on j, k, gg and G, step " +
      "through the cards, the sets and the answer boxes, as in the choice points; the boxes take " +
      "Vim's keys when Vim keys is on.",
    kind: "view",
    emits: ["prompt-sheet.saved"],
    asks: ["prompt-sheets: list", "prompt-sets: list", "settings: read"],
    sends: ["sheet-picker: focus"],
    attributes: [],
  },
  on: {
    add: planned,
    "prompt-sheet.changed": planned,
    "prompt-sheet.deleted": planned,
    "prompt-set.changed": planned,
    "prompt-set.deleted": planned,
    "settings.changed": planned,
    "day.shown": planned,
  },
});
