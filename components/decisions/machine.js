import { setup } from "xstate";

// A planned local-only fact component (3.1, 9 step 1): metadata and the handlers its
// contract needs, no behaviour yet. The run lives in this fact rather than a view, as
// the chat's tool loop lives in conversations (6.3), so closing a panel stops nothing.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "decisions",
  meta: {
    description:
      "Owns what Jev answered, kept on this device: the latest answers for each case and tool, " +
      "and the latest run of Judge or Judge all with how far it got. Judge and Judge all arrive " +
      "with the cases and the switched-on tools as they were when the button was pressed, and " +
      "this fact asks Jev about one case at a time, in order, because only one request may be " +
      "open at a time. A run stops at the first error and keeps the reason, so the user sees " +
      "why. Answers are dropped once the case's text or a question they answer changes, " +
      "because they no longer say anything about what is written, and with the case or tool " +
      "they belong to once it is gone. For a yes / no question an answer is how likely yes is; " +
      "for a pick-one question it is the option Jev picked, how likely each option is, and how " +
      "sure Jev is.",
    kind: "fact",
    shape: "local-only",
    owns: "Jev's latest answers for each case and tool, and the latest run",
    emits: ["decision.changed"],
    asks: ["llm: decide"],
  },
  on: {
    "judging.requested": planned,
    "case.changed": planned,
    "rubric.changed": planned,
    "read?": planned,
  },
});
