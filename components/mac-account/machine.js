import { setup } from "xstate";

// Planned (architecture 9, step 1): metadata only, so the contracts can be
// reviewed on the components page before the view is written (plan step 4).
// It asks session: read for the starting picture and follows session.changed
// after (4.3, fourth rule). The handler does nothing until the view is built;
// it has an action because XState lists no event for a handler without one.

export const machine = setup({}).createMachine({
  id: "mac-account",
  meta: {
    description:
      "The Account tab of the gear's sheet in the Mac app, where the Mac is connected to an " +
      "account on app.unblent.com and disconnected from it (3.4). It shows nothing outside the " +
      "Mac app. Not connected, it offers Connect account, which opens the connect page in the " +
      "user's browser, and it then shows Waiting for Safari until the user has signed in there " +
      "and comes back. When the account's sign-in is ready, it asks whether to add this Mac's " +
      "notes, books and journal to the account, with two choices: Add them, or Use only the " +
      "account's, which is the one chosen when nothing else is, and it says that the Mac's own " +
      "copy stays and comes back on Disconnect. Connected, it shows Connected as and the " +
      "account's name, with Disconnect. When the admin has turned sync off for the account, it " +
      "says Sync was turned off for this account, with Disconnect. Disconnect is the undo of " +
      "Connect; if what is not yet sent cannot be sent within a few seconds, nothing changes " +
      "and a notice says so.",
    kind: "view",
    attributes: [],
    emits: ["connect.requested", "connect.confirmed", "disconnect.requested"],
    asks: ["session: read"],
  },
  on: { "session.changed": { actions: () => {} } },
});
