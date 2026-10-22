import { setup } from "xstate";

// Planned (9, step 1): metadata only, so the contracts can be reviewed on the
// components and contracts pages before any behaviour is written. The handler keys
// below exist only so the manifest shows what it will consume and answer (7.2).

// XState lists only a transition that does something, so each key needs an action
// for the manifest reader to see it.
const declared = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "generators",
  meta: {
    description:
      "Owns the generators and what they write. A generator is an instruction the model runs " +
      "by itself at a fixed moment, whose short text lands in a fixed place; an evaluator judges " +
      "text, a generator writes it. There are two, with fixed ids: chat-title names a chat once its " +
      "first answer has finished, and journal-summary writes one short paragraph about a past " +
      "journal day, its text and its choice points. Each has a name, on or off, a model and a " +
      "prompt, with defaults when nothing is stored, and belongs to the account, the same on every " +
      "device. Each result is kept per generator and item (a chat's id, a day's date) with the " +
      "SHA-256 of the content it was made from, so an item is made again only when its content " +
      "changes, never because the prompt did. While the page is open and the user is signed in, " +
      "it looks for items that are ready and have no result for their current content, on load, " +
      "when a day closes and when a chat's first answer finishes, and asks `llm: generate` for " +
      "one at a time, newest first; it stops on an error until the next page load or a change to " +
      "a generator, and skips a generator that is off. Run (generation.requested) makes the item " +
      "in front again at once: the chat last opened, or the journal day last shown. Every result " +
      "is announced as generation.changed, and the place that shows it follows that. Replicated " +
      "(5): the last write wins and nothing is deleted; two devices may make the same result once, " +
      "and the later one is kept. Signed out or as a guest nothing runs.",
    kind: "fact",
    shape: "replicated",
    owns: "the generators and the texts they wrote",
    emits: ["generator.changed", "generation.changed"],
    asks: ["session: read", "journal: read", "choice-points: list", "llm: generate"],
  },
  on: {
    "list?": declared,
    "results?": declared,
    "generator.edited": declared,
    "generation.requested": declared,
    "session.changed": declared,
    "conversation.changed": declared,
    "conversation.opened": declared,
    "journal.changed": declared,
    "choice-point.changed": declared,
    "choice-point.deleted": declared,
    "day.shown": declared,
  },
});
