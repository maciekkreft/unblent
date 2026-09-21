import { setup } from "xstate";

// Planned component (architecture.md 9, step 1): only the manifest and the schemas
// exist yet, so the contracts and components pages can show `llm` and its neighbours
// can be reviewed against it before any code is written. The actor, the browser entry
// and the server module arrive in later sessions.
//
// `llm` owns access to the language model (3.1): remote-only, because a completion can
// only come from the server, which also holds the account's model settings and API key
// (3.1, 7.7). It answers `read` (the account's picture, never the key) and `complete`
// (start one answer; the answer itself arrives as `completion.progressed` events, 6.3),
// and it follows `session.changed`, `llm.edited` (the user's settings gestures) and
// `turn.steered` (a stop). The handlers are declaration-only until the actor is built;
// each does nothing but make the manifest name the query or event (7.3).
export const machine = setup({
  actions: { declared: () => {} },
}).createMachine({
  id: "llm",
  meta: {
    kind: "fact",
    shape: "remote-only",
    owns: "access to the language model",
    emits: ["llm.changed", "completion.progressed"],
    asks: ["session: read"],
  },
  initial: "planned",
  states: {
    planned: {
      on: {
        "read?": { actions: "declared" },
        "complete?": { actions: "declared" },
        "session.changed": { actions: "declared" },
        "llm.edited": { actions: "declared" },
        "turn.steered": { actions: "declared" },
      },
    },
  },
});
