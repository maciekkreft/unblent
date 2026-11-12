import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor and the view are written.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "matrix-sheet",
  meta: {
    description:
      "Shows the Eisenhower Matrix of the journal day on the page, under the day's text. Open, " +
      "a sheet headed Eisenhower Matrix holds an Add a task line, where pasting several lines " +
      "adds one task per line, then To sort and the four places Do, Schedule, Delegate and " +
      "Drop side by side, stacked Do first on a narrow screen. Each task has a tick box, its " +
      "words, a Suggested or Not sure tag while the user has not placed it, and a place button " +
      "that opens the four places under the task. Adding the sheet on a new day copies the " +
      "newest earlier matrix without its ticked tasks, in one step Undo removes, with a line " +
      "naming the day it came from; the first matrix starts empty. Done or Escape folds the " +
      "sheet into a card: Do today, then how many tasks each other place holds. Deleting the " +
      "last task takes the matrix away with the short notice. An earlier day is read only.",
    kind: "view",
    emits: ["matrix.saved"],
    asks: ["matrices: list", "settings: read"],
    sends: ["sheet-picker: focus"],
    attributes: [],
  },
  on: {
    add: planned,
    "matrix.changed": planned,
    "matrix.deleted": planned,
    "settings.changed": planned,
    "day.shown": planned,
  },
});
