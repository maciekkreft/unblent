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
      "first, and an action that opens something on the stage, such as a book from a chat, " +
      "counts for what it opens; a pause of more than two minutes is not counted. Totals are kept per device, " +
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
    // Which feature the time after each action a view announces belongs to (7.3); the
    // counts check fails on an action left out. An action that opens something on the
    // stage counts for what it opens, since the time after it is spent there.
    features: ["journal", "reading", "highlights", "notes", "chats", "evaluators", "choice", "values", "other"],
    counts: {
      "day.saved": "journal",
      "day.shown": "journal",
      "day.selected": "journal",
      "book.picked": "reading",
      "book.selected": "reading",
      "book.progressed": "reading",
      "book.renamed": "reading",
      "book.discarded": "reading",
      "book.switched": "reading",
      "book.closed": { "book-reader": "reading", "journal-entry": "journal" },
      "chapter.selected": "reading",
      "tabs.shown": "reading",
      "passage.selected": "highlights",
      "highlights.edited": "highlights",
      "text.copied": "highlights",
      "link.copied": "highlights",
      "note.saved": { "book-reader": "highlights", "note-editor": "notes", "notice-stack": "notes" },
      "note.discarded": { "book-reader": "highlights", "note-list": "notes" },
      "note.opened": "notes",
      "note.selected": "notes",
      "note.moved": "notes",
      "note.staged": "notes",
      "note.closed": "notes",
      "turn.submitted": "chats",
      "turn.steered": "chats",
      "conversation.selected": "chats",
      "conversation.renamed": "chats",
      "conversation.moved": "chats",
      "conversation.discarded": "chats",
      "conversation.relinked": "chats",
      "conversation.staged": "chats",
      "conversation.closed": "chats",
      "lookup.followed": "chats",
      "evaluator.saved": "evaluators",
      "evaluator.opened": "evaluators",
      "evaluator.selected": "evaluators",
      "evaluator.switched": "evaluators",
      "evaluator.moved": "evaluators",
      "evaluator.discarded": "evaluators",
      "marks.edited": "evaluators",
      "starter.ticked": "evaluators",
      "choice-point.saved": "choice",
      "values.saved": "values",
      "values.placed": "values",
      "settings.edited": "other",
      "llm.edited": "other",
      "tools.edited": "other",
      "checks.edited": "other",
      "value-checks.edited": "other",
      "updates.edited": "other",
      "generator.edited": "other",
      "generation.requested": "other",
      "flag.switched": "other",
      "tab.picked": "other",
      "tab.moved": "other",
      "tab.closed": "other",
      "dock.arranged": "other",
      "layout.switched": "other",
      "viewport.selected": "other",
      "profile.switched": "other",
      "step.requested": "other",
      "redline.saved": "other",
      "trial.restarted": "other",
      "signin.requested": "other",
      "signout.requested": "other",
      "connect.requested": "other",
      "connect.confirmed": "other",
      "disconnect.requested": "other",
      "viewas.requested": "other",
      "guest.blocked": "other",
      "guestkeys.edited": "other",
      "limits.edited": "other",
      "removal.settled": "other",
      "sync.allowed": "other",
      "use.reset": "other",
    },
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
