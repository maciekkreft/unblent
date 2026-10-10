import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "case-journal",
  meta: {
    description:
      "The Journal tab: the open case's text, split into pieces, each judged by Jev on its own " +
      "with every tool that is on. A switch at the top chooses Sentences or Paragraphs and is " +
      "remembered on this device. The text box edits the same case text as the Case tab and is " +
      "saved the same way; with no case open, writing starts a new case. Under the box, one row " +
      "per piece in order, with the piece's text and one line per tool that is on: a pick-one " +
      "question shows the pick and how sure Jev is, a yes / no question the chance of yes in " +
      "the Case tab's colours, a piece waiting for Jev says \"Judging…\", and a piece not " +
      "finished yet is dimmed and not judged. A sentence is finished at . ! ? or … (closing " +
      "quotes or brackets allowed) or a line break; a paragraph at a line break; and every " +
      "non-empty piece when a case is opened or the box loses focus. A piece already judged with " +
      "the same tools is never sent again, so editing one sentence re-judges only that one. One " +
      "line says why nothing is judged (signed out, no Jev key, no tool on), in the Case tab's " +
      "words. There are no ticks or crosses: right answers belong to the whole case.",
    kind: "view",
    emits: ["case.saved", "case.selected", "passages.requested"],
    attributes: [],
    asks: ["projects: read", "cases: read", "rubrics: read", "decisions: read", "llm: read"],
  },
  on: {
    "project.changed": planned,
    "case.changed": planned,
    "rubric.changed": planned,
    "decision.changed": planned,
    "llm.changed": planned,
  },
});
