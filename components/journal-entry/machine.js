import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "journal-entry",
  meta: {
    description:
      "The journal's page: the day picked in the Days list, or the day that can still be " +
      "edited, or an empty page for today. Each paragraph has Jev's answers in a margin beside " +
      "it, or under it on a phone, grouped under each project's name when more than one project " +
      "is on. A pick-one question shows the pick and \"sure n%\", or \"unsure\" below 40%; a yes / " +
      "no question shows the chance of yes in Judge's colours. A paragraph waiting for Jev says " +
      "\"Judging…\", and the paragraph being written says \"Not finished yet\": a paragraph is " +
      "finished at a line break, and every paragraph is finished when the box loses focus or the " +
      "entry closes. An answer to a question whose wording has changed since is tagged " +
      "\"earlier wording\", and hovering shows the old wording. The status line says the entry " +
      "is open until midnight or an hour after the last edit, and past midnight a banner says " +
      "when it closes. Earlier days are read only, with Judge this day when something is not " +
      "answered with the current wording. One line says why Jev is not reading, in Judge's " +
      "words. The text is saved a short time into typing and when the box loses focus.",
    kind: "view",
    emits: ["day.saved", "day.judging.requested"],
    attributes: [],
    asks: ["journal: read"],
  },
  on: {
    "journal.changed": planned,
    "day.selected": planned,
  },
});
