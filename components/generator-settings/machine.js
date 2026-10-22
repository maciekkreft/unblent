import { setup } from "xstate";

// Planned (9, step 1): metadata only, so the contracts can be reviewed on the
// components and contracts pages before any behaviour is written. The handler keys
// below exist only so the manifest shows what it will consume (7.2).

// XState lists only a transition that does something, so each key needs an action
// for the manifest reader to see it.
const declared = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "generator-settings",
  meta: {
    description:
      "The Generators tab of the gear's sheet, after Settings. It shows the two generators one " +
      "under the other, Chat title and Journal summary, each with an On tick box, its name, Model " +
      "(the models the account's Anthropic key offers, Haiku 5.5 at first) and Ask the model, the " +
      "prompt, in an editor box that follows the Vim keys preference. Every change is saved to the " +
      "account at once (generator.edited). Run on the open chat, or Run on the picked journal " +
      "entry, asks for that one text again now with the current prompt (generation.requested); the " +
      "sheet takes the stage, so the chat list and the journal's contents stay in sight and the new " +
      "text is seen landing. Signed out, on a try page or as a guest nothing runs, and the tab says " +
      "to sign in. It asks `generators: list`, `llm: read` for the models, `session: read` for who " +
      "the account is and `settings: read` for Vim keys, and follows each after.",
    kind: "view",
    attributes: [],
    emits: ["generator.edited", "generation.requested"],
    asks: ["generators: list", "llm: read", "session: read", "settings: read"],
  },
  on: {
    "generator.changed": declared,
    "llm.changed": declared,
    "session.changed": declared,
    "settings.changed": declared,
  },
});
