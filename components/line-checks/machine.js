import { setup } from "xstate";

// The fact component that owns the hashtag checks (3.1): what Jev answered about the lines a
// hashtag line names in a note or a journal day. Planned (9, step 1): only its metadata and
// its contracts exist, so the handlers below are empty and the manifest reads correctly.
// It will be replicated (5) the way `choice-point-checks` is, with its own copy of that
// fact's key, queue and answers, because components never import each other (11.2).

// XState lists a handler in machine.events only when the transition does something, so
// each planned handler holds an action that does nothing (7.3: the manifest is read there).
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "line-checks",
  meta: {
    description:
      "Owns what Jev, or Kev in Ollama on a Mac, answered about the lines a hashtag line " +
      "names in a note or a journal day. A hashtag line is a line that holds one or more " +
      "#name words, with or without other text, such as \"Things on my mind tonight " +
      "#in-my-control\". Each name is matched to one of the account's evaluators by the " +
      "evaluator's name made short the way a chapter link names a chapter: lowercase a to z " +
      "and digits, accented letters written plainly, every other run of characters one " +
      "hyphen. A name that matches no evaluator checks nothing. The hashtag line itself is " +
      "not checked. It checks the lines after it in the same paragraph or list, up to the next " +
      "gap between paragraphs (a blank line); a line without a letter or digit is skipped. A " +
      "line is checked once the user has finished it, as the editor's save says (the cursor " +
      "left the line, Enter, the box losing focus, or a paste); the line being typed is not " +
      "checked. A past journal day never asks: it shows only the answers already kept. The " +
      "read query answers from the kept answers only and never asks, so opening, reloading " +
      "or showing a past day costs nothing. Each answer is kept per question, under a key " +
      "made of the evaluator's id, that question as it stands, and the line's text, and never " +
      "changes once written, so editing a line hides its old mark until the new text is " +
      "answered and another device reuses the answers, as in choice-point-checks. The marks " +
      "announced for a line are one per question: for a pick-one question the chosen " +
      "option's icon and name; for a yes / no question the question's short name, only when " +
      "the answer is yes, and nothing on no. Without a key or a decider nothing is asked. A " +
      "failure, such as signed out, no key or rate limited, is announced with the lines so " +
      "the editor can say why. It works signed out and syncs to the account when signed in " +
      "(section 5). Checking is not a step: the edit that made the line is the note's or the " +
      "day's step.",
    kind: "fact",
    shape: "replicated",
    owns: "Jev's answers about the lines named by hashtags in notes and journal days",
    steps: {
      "note.saved": "follows",
      "day.saved": "follows",
    },
    emits: ["text.checked"],
    asks: ["llm: decide", "llm: read", "evaluators: list", "session: read"],
  },
  on: {
    "note.saved": planned,
    "day.saved": planned,
    "evaluator.changed": planned,
    "evaluator.deleted": planned,
    "llm.changed": planned,
    "session.changed": planned,
    "journal.changed": planned,
    "read?": planned,
  },
});
