import { setup } from "xstate";

// A planned replicated fact component (3.1, 9 step 1): metadata and the handlers its
// contract needs, no behaviour yet. One fact owns the days, the journal's own projects
// and detectors, and Jev's answers, so the journal has one sync, one server module and
// one per-user database (5). The "today only" rule lives here, in how day.saved is
// handled, and nowhere else.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "journal",
  meta: {
    description:
      "Owns the journal: one entry per day, the journal's own projects and detectors, and what " +
      "Jev answered. It works offline and syncs to the account when signed in, the same way notes " +
      "do; signed out it is kept in this browser, and signing in moves it to the account. A day's " +
      "date is the local date when its first character was typed and never changes. Only one " +
      "day can be edited: the one whose date is today, or that was edited less than an hour ago, " +
      "so writing past midnight keeps going in the same entry; a save to any other day is " +
      "refused. When no day can be edited, the journal opens an empty page for today. The " +
      "projects and detectors are separate from Judge's: a detector reads the writing only when " +
      "it and its project are both ticked, and unticking a project keeps each detector's own " +
      "tick. A first visit starts with two example projects, \"Cognitive Distortion\" and " +
      "\"Goals and values\". Deleting a project or a detector, or removing a question or an " +
      "option, waits out the undo window. Each finished paragraph of the open day is sent to " +
      "Jev once, in one request carrying every question that is on, one paragraph at a time; a " +
      "paragraph that already has answers with the current wording is never sent again. Every " +
      "answer keeps the wording of the question it answered. Rewording a question re-asks " +
      "today's paragraphs; earlier days keep their answers, marked as an earlier wording, and " +
      "are asked only when the user presses Judge this day. A failed request stops the queue " +
      "and keeps the reason.",
    kind: "fact",
    shape: "replicated",
    owns: "the journal's days, its projects and detectors, and Jev's answers",
    emits: ["journal.changed", "journal.conflicted"],
    asks: ["session: read", "llm: read", "llm: decide"],
  },
  on: {
    "day.saved": planned,
    "day.judging.requested": planned,
    "detector-project.saved": planned,
    "detector-project.switched": planned,
    "detector.saved": planned,
    "detector.switched": planned,
    "removal.started": planned,
    "removal.undone": planned,
    "removal.settled": planned,
    "session.changed": planned,
    "llm.changed": planned,
    "read?": planned,
  },
});
