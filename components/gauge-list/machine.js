import { setup } from "xstate";

// Planned (architecture 9, step 1): the list of gauges in the dock, the first child of
// list-then-item. Only the contract is declared so far.
export const machine = setup({}).createMachine({
  id: "gauge-list",
  meta: { kind: "view", emits: ["gauge.selected"], attributes: [], asks: ["gauge: read"] },
  on: { "gauge.changed": { actions: () => {} } },
});
