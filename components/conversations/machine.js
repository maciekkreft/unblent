import { setup } from "xstate";

// Planned component (architecture.md 9, step 1): manifest and schemas only, so the
// slip-box shows `conversations` and its views before any code is written.
//
// `conversations` owns the chats (3.1): replicated like `notes`, but merged by turn id
// rather than versioned, because a turn is immutable once finished (5). It answers
// `list`, `read`, `open` (which chat is open, per device) and `tools` (the tool
// preferences of the loop, 7.7); it emits `conversation.changed`, `conversation.deleted`,
// `conversation.opened` and `tools.changed`. It is where the tool loop lives (7.7), so
// it asks `llm: complete` and, from the views and its neighbours, learns what the user
// did: `turn.submitted`, `turn.steered`, the selection gestures, `tools.edited`, and the
// model's `completion.progressed`; it follows `subject.changed` to open the right chat
// and `session.changed` to sync. The `*: tool` ask and the tool round arrive in a later
// session (7.7). Handlers are declaration-only until the actor is built (7.3).
export const machine = setup({
  actions: { declared: () => {} },
}).createMachine({
  id: "conversations",
  meta: {
    kind: "fact",
    shape: "replicated",
    owns: "the chats",
    emits: ["conversation.changed", "conversation.deleted", "conversation.opened", "tools.changed"],
    asks: ["session: read", "subject: read", "llm: complete", "catalog: contracts"],
  },
  initial: "planned",
  states: {
    planned: {
      on: {
        "list?": { actions: "declared" },
        "read?": { actions: "declared" },
        "open?": { actions: "declared" },
        "tools?": { actions: "declared" },
        "turn.submitted": { actions: "declared" },
        "turn.steered": { actions: "declared" },
        "completion.progressed": { actions: "declared" },
        "conversation.selected": { actions: "declared" },
        "conversation.discarded": { actions: "declared" },
        "tools.edited": { actions: "declared" },
        "subject.changed": { actions: "declared" },
        "session.changed": { actions: "declared" },
      },
    },
  },
});
