import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "viewas-bar",
  meta: {
    description:
      "While the admin views as someone, a bar fixed above everything on every page, on " +
      "the desk and the phone: \"Viewing as Guest 14 · what you change is changed for " +
      "them\" and Back to you, which hands the browser back to the admin. It shows " +
      "nothing otherwise.",
    kind: "view",
    emits: ["viewas.requested"],
    attributes: [],
    asks: ["session: read"],
  },
  on: {
    "session.changed": planned,
  },
});
