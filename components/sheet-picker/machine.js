import { setup } from "xstate";

// Planned (9): metadata and handler names only, so the contracts can be reviewed before
// the actor and the view are written.
// XState's `events` leaves out a handler that does nothing, and the manifest is read from
// `events` (7.3), so each planned handler holds an action until the actor is written.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "sheet-picker",
  meta: {
    description:
      "The last row of today's journal page, + Add sheet, which opens a list of the sheets in " +
      "place, each with its name, one line of description and a category label. It keeps that " +
      "fixed list itself, so the journal knows no kind of sheet: Your values (ACT), Choice point " +
      "(ACT) and Wheel of Life (Coaching). Your values and Wheel of Life leave the list while " +
      "they are on the day; Choice point stays, because a day can hold several. A sheet whose " +
      "feature is hidden is not listed, and with nothing to list the row is hidden too. An " +
      "earlier day has no row. The list closes with Escape or a second press. The arrow keys, and " +
      "with Vim keys on j, k, gg and G, move in the list, and Enter picks; picking an entry adds " +
      "the sheet and gives it the keyboard.",
    kind: "view",
    emits: [],
    asks: ["values: read", "wheels: list", "flags: read", "settings: read"],
    attributes: [],
  },
  on: {
    "values.changed": planned,
    "wheel.changed": planned,
    "wheel.deleted": planned,
    "flags.changed": planned,
    "settings.changed": planned,
    "day.shown": planned,
  },
});
