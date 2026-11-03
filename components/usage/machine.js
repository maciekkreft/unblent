import { setup } from "xstate";

// A replicated fact component (3.1, 5), planned (9, step 1): its decisions, store,
// browser entry and server module come once its contracts are agreed.
export const machine = setup({}).createMachine({
  id: "usage",
  meta: {
    description:
      "Owns how long this account spends in each feature, by day: Journal, Reading, " +
      "Highlights, Notes, Chats, Evaluators, Choice Points, Values and Other. It counts only " +
      "on a device where the person turned on Share usage statistics in Settings, and only " +
      "while someone is signed in. It learns what the person did from the trace of this tab: " +
      "each action a view announced, by its name and the view that announced it, never what " +
      "was written or read. The time between two actions is counted for the feature of the " +
      "first; a pause of more than two minutes is not counted. Totals are kept per device, " +
      "day and feature in the browser and sent to the account when there is something new, " +
      "also later when the device was offline; the last write wins (5). Summary answers the " +
      "last 182 days for this account, or, for the admin only, added up across all accounts, " +
      "as totals with no breakdown per account (12). Offline it answers with this device's " +
      "own totals.",
    kind: "fact",
    shape: "replicated",
    owns: "how long the account spends in each feature, per device and day",
    emits: [],
    asks: ["session: read", "settings: read"],
    steps: {},
  },
  // The handlers name what the fact will consume and answer (7.2), so the components and
  // contracts pages show its contract while it is planned.
  on: {
    "trace.recorded": { actions: () => {} },
    "settings.changed": { actions: () => {} },
    "session.changed": { actions: () => {} },
    "summary?": { actions: () => {} },
  },
});
