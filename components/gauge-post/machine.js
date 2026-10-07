import { setup } from "xstate";

// Planned (architecture 9, step 1): the stage of the Gauge app, the post, the Score
// button and one card per gauge. Only the contract is declared so far.
export const machine = setup({}).createMachine({
  id: "gauge-post",
  meta: {
    kind: "view",
    emits: ["gauge.read"],
    attributes: ["height"],
    asks: ["gauge: read", "llm: read", "llm: decide"],
  },
  on: { "gauge.changed": { actions: () => {} }, "llm.changed": { actions: () => {} } },
});
