import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor and the view are written.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "wheel-sheet",
  meta: {
    description:
      "Shows the Wheels of Life of the journal day on the page, under the day's text. Open, a " +
      "sheet headed Wheel of Life holds an Actual | Wanted choice that decides what a click sets, " +
      "the wheel, and eight rows of ten squares, one row per area. On the wheel the filled part " +
      "is Actual and the dark line is Wanted; in the rows the filled squares are Actual and the " +
      "dark outlined square is Wanted. A small key says so. A new wheel starts with Actual empty " +
      "and Wanted taken from the previous wheel, as it stood, and the key names that wheel's day " +
      "until a Wanted score is changed; the first wheel starts with both empty. Clicking the " +
      "current score clears it. The arrow keys move and set a score, with Shift for Wanted, and " +
      "with Vim keys on so do j, k, gg, G, h and l, with Shift+H and Shift+L for Wanted; a key " +
      "also switches the Actual | Wanted choice to match. Done or Escape folds the sheet into a " +
      "card with a small wheel and, per area, its Actual, its Wanted and the gap between them; " +
      "the gap is empty when the scores match or one is missing. Pressing the card opens it " +
      "again. Delete takes the wheel away with the short notice; a wheel left untouched is not " +
      "kept and shows no notice. An earlier day is read only, with Close. A phone stacks the " +
      "wheel above the rows, with larger targets.",
    kind: "view",
    emits: ["wheel.saved"],
    asks: ["wheels: list", "settings: read"],
    attributes: [],
  },
  on: {
    "wheel.changed": planned,
    "wheel.deleted": planned,
    "settings.changed": planned,
    "day.shown": planned,
  },
});
