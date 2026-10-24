import { setup } from "xstate";

// Planned (architecture 9, step 1): metadata only, so the contracts can be reviewed on
// the components page before the view is written. It asks values and settings for the
// starting picture and follows values.changed and settings.changed after (4.3, fourth
// rule). The handlers do nothing until the view is built; each has an action because
// XState lists no event for a handler without one.

export const machine = setup({}).createMachine({
  id: "values-sheet",
  meta: {
    description:
      "Shows the client's values on every journal day, under the day's text and above the " +
      "choice points, as a folded card that lists the values' names; pressing it opens the " +
      "sheet. Open, each value is a row of its name and an optional sentence saying what it " +
      "means, with a New value row after them; with no values yet the card shows a muted " +
      "Write your values row. The boxes take Vim's keys when Vim keys is on. A day shows the " +
      "values as they stood on that day. They are written on today's page only, as the " +
      "journal page says from day.shown; from midnight yesterday's sheet is read only, even " +
      "in the hour its text stays open. On an earlier day the sheet is read only, " +
      "with Close instead of Done, and says Changed since, with a way to see today's, when the " +
      "values changed after that day. Removing a value has an Undo window; once it ends the " +
      "value is gone from today's version, and earlier days keep theirs. The footer says " +
      "Changed today when today's version was written today, and how many earlier versions " +
      "there are. What is written is saved a short time into typing and at once when a box " +
      "loses focus.",
    kind: "view",
    emits: ["values.saved"],
    asks: ["values: read", "values: versions", "settings: read"],
    attributes: [],
  },
  on: {
    "day.shown": { actions: () => {} },
    "values.changed": { actions: () => {} },
    "settings.changed": { actions: () => {} },
  },
});
