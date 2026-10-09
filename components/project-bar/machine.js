import { setup } from "xstate";

// A planned view component (3.1, 9 step 1): metadata and the handlers its contract
// needs, no behaviour yet. Each handler key names an event it will follow (7.2).

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "project-bar",
  meta: {
    description:
      "The bar across the top of Judge: it names the current project, and its button opens a " +
      "menu listing every project with how many tools and cases it has, the current one ticked. " +
      "Picking a project makes it current. The menu also makes a new project, which becomes " +
      "current and opens its name for writing; renames the current project; and deletes it, " +
      "with Undo in a notice for a few seconds. Delete is greyed out while only one project is " +
      "left, with a hover text saying why. A line says projects are kept on this device.",
    kind: "view",
    emits: ["project.selected", "project.saved", "removal.started"],
    attributes: [],
    asks: ["projects: read", "rubrics: read", "cases: read"],
  },
  on: {
    "project.changed": planned,
    "rubric.changed": planned,
    "case.changed": planned,
  },
});
