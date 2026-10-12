import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "journal-days",
  meta: {
    description:
      "The Days dock of the journal: one row per day, newest first, with the short date, the " +
      "first line and how many paragraphs it has; the day that can still be edited shows a " +
      "\"today\" or \"open till HH:MM\" pill instead of the count. Picking a row shows that day " +
      "in the entry. A line says where the journal is kept: in this browser when signed out, on " +
      "your account when signed in.",
    kind: "view",
    emits: ["day.selected"],
    attributes: [],
    asks: ["journal: read", "session: read"],
  },
  on: {
    "journal.changed": planned,
    "session.changed": planned,
  },
});
