import { setup } from "xstate";

// Planned (architecture 9, step 1): metadata only, so the contracts can be reviewed on
// the components page before the actor, store and server module are written. It asks
// session: read for the starting picture and follows session.changed after (4.3,
// fourth rule). The handlers do nothing until the fact is built; each has an action
// because XState lists no event for a handler without one.

export const machine = setup({}).createMachine({
  id: "values",
  meta: {
    description:
      "Owns the client's values: one list per account, each value a short name and an " +
      "optional sentence saying what it means. Every version is kept by day: a day's version " +
      "is the list as it stood at the end of that day, and only today's is written, so an " +
      "edit made today replaces today's version and an earlier day's never changes; a save " +
      "naming any other day is ignored, also yesterday's in the hour after midnight while " +
      "its journal text is still open. A removed value is gone from today's version only; " +
      "earlier days keep theirs, so their marks stay as they were checked. " +
      "`values: read` answers the version in force on a day, the latest one on or before it, " +
      "or the current one when no day is given, and says whether the values changed after " +
      "it; the chat may use it as a lookup, Reading your values. `values: versions` answers " +
      "the days on which the values changed, oldest first. It works signed out, numbering " +
      "versions itself, and syncs to the account when signed in (section 5); signing in " +
      "uploads every version. The last write wins, so two devices never conflict. " +
      "`evaluators` builds the evaluator Your values from a day's version, one question per " +
      "value, and every value counts toward its one mark; with no values it has no " +
      "questions, so a Towards line gets no values mark at all rather than a grey one.",
    kind: "fact",
    shape: "replicated",
    emits: ["values.changed"],
    owns: "the client's values and their versions by day",
    asks: ["session: read"],
  },
  on: {
    "session.changed": { actions: () => {} },
    "values.saved": { actions: () => {} },
    "read?": { actions: () => {} },
    "versions?": { actions: () => {} },
  },
});
