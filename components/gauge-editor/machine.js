import { setup } from "xstate";

// Planned (architecture 9, step 1): one gauge's name, question, rule and questions, the
// item under list-then-item's Back bar. Only the contract is declared so far.
export const machine = setup({}).createMachine({
  id: "gauge-editor",
  meta: { kind: "view", emits: ["gauge.saved", "gauge.discarded"], attributes: ["height"], asks: ["gauge: read"] },
  on: { "gauge.selected": { actions: () => {} }, "gauge.changed": { actions: () => {} } },
});
