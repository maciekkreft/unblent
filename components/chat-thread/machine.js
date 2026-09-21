import { setup } from "xstate";

// Planned component (architecture.md 9, step 1): manifest only, no view yet.
//
// `chat-thread` is a view (3.1): it shows the open conversation and owns only its own
// UI state (the transcript scroll). It asks `conversations` for the open chat and its
// turns and follows the conversation events; it renders the input through a default
// slot (6.3). Handlers are declaration-only until the view is built (9, step 3).
export const machine = setup({
  actions: { declared: () => {} },
}).createMachine({
  id: "chat-thread",
  meta: {
    kind: "view",
    attributes: ["height"],
    emits: [],
    asks: ["conversations: open", "conversations: read"],
  },
  initial: "planned",
  states: {
    planned: {
      on: {
        "conversation.opened": { actions: "declared" },
        "conversation.changed": { actions: "declared" },
        "conversation.deleted": { actions: "declared" },
      },
    },
  },
});
