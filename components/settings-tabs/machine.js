import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "settings-tabs",
  meta: {
    description:
      "The sheet the gear opens. It shows its children as tabs, named by each child's " +
      "label; children with the same label share one tab and stand one after another in " +
      "it, Settings first. A child marked `admin` is shown only to the admin, and is " +
      "hidden while the admin views as someone. While only one tab is left there is no " +
      "tab bar, so everyone but the admin sees Settings exactly as before. It asks " +
      "`session` who the account is and follows it after.",
    kind: "view",
    emits: [],
    attributes: [],
    asks: ["session: read"],
  },
  on: {
    "session.changed": planned,
  },
});
