import { setup } from "xstate";

// Planned component (architecture.md 9, step 1): manifest and schemas only, no view yet.
//
// `chat-input` is the question box: a view owning only the draft. It emits
// `turn.submitted` when the user sends (carrying `about` and `start` when the chat is
// new) and `turn.steered` (a stop) while an answer arrives. It asks `conversations` for
// the open chat, `subject: read` for what to link a new chat to, and `llm: read` to know
// whether it must disable itself (signed out, or no key). It follows the matching events.
// Handlers are declaration-only until the view is built (9, step 3).
export const machine = setup({
  actions: { declared: () => {} },
}).createMachine({
  id: "chat-input",
  meta: {
    kind: "view",
    attributes: [],
    emits: ["turn.submitted", "turn.steered"],
    asks: ["conversations: open", "conversations: read", "subject: read", "llm: read"],
  },
  initial: "planned",
  states: {
    planned: {
      on: {
        "conversation.opened": { actions: "declared" },
        "conversation.changed": { actions: "declared" },
        "conversation.deleted": { actions: "declared" },
        "subject.changed": { actions: "declared" },
        "llm.changed": { actions: "declared" },
      },
    },
  },
});
