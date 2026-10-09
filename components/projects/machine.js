import { setup } from "xstate";

// A planned local-only fact component (3.1, 9 step 1): metadata and the handlers its
// contract needs, no behaviour yet. Each handler key names what it will consume or
// answer (7.2), so the manifest and the contracts can be reviewed before the actor
// is written.

// XState drops a handler with nothing in it, and the manifest is read from the handlers
// (7.3), so each planned handler holds an action that does nothing.
const planned = { actions: () => {} };

export const machine = setup({}).createMachine({
  id: "projects",
  meta: {
    description:
      "Owns the Judge projects, kept on this device: each project has a name and its own tools, " +
      "cases and results, and one project is the current one. There is always at least one " +
      "project, so deleting the last one is refused. A deleted project waits out the undo window " +
      "before it is gone, and still exists until then, so Undo brings it back with everything in " +
      "it; while it waits, its neighbour in the list becomes the current project. A new project " +
      "becomes the current one. A first visit starts with two example projects, \"Goals and " +
      "values\" and \"Replies\".",
    kind: "fact",
    shape: "local-only",
    owns: "the projects and which one is current",
    emits: ["project.changed"],
  },
  on: {
    "project.saved": planned,
    "project.selected": planned,
    "removal.started": planned,
    "removal.undone": planned,
    "removal.settled": planned,
    "read?": planned,
  },
});
