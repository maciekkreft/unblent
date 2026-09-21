import { setup } from "xstate";

// Planned component (architecture.md 9, step 1): manifest and schemas only, no view yet.
//
// `conversation-list` is a view modelled on `note-list`: with the `subject` attribute it
// lists the chats about the subject, newest first, the open one highlighted. It emits
// `conversation.selected` (picking a row, and "New chat" with a fresh id) and
// `conversation.discarded` (a delete after its undo window). It asks `conversations` for
// the list and the open chat, and `subject: read` for what to filter by, following the
// matching events. Handlers are declaration-only until the view is built (7.3).
export const machine = setup({
  actions: { declared: () => {} },
}).createMachine({
  id: "conversation-list",
  meta: {
    kind: "view",
    attributes: ["subject"],
    emits: ["conversation.selected", "conversation.discarded"],
    asks: ["conversations: list", "conversations: open", "subject: read"],
  },
  initial: "planned",
  states: {
    planned: {
      on: {
        "conversation.changed": { actions: "declared" },
        "conversation.deleted": { actions: "declared" },
        "conversation.opened": { actions: "declared" },
        "subject.changed": { actions: "declared" },
      },
    },
  },
});
