import { setup, assign, emit, fromPromise } from "xstate";

// The view component that lists the journal's projects (6.4), the first child of the
// Detectors dock's outer list-then-item. It owns only UI state — the rows it shows and
// which one was opened — and points at one fact: it asks journal: read for the starting
// picture and follows journal.changed after (4.3, fourth rule). A tick, a pick and New
// project leave as gestures (4.3, fifth rule). The ask and mint arrive through input, so
// this stays a pure definition importable in Node.

export const NEW_NAME = "New project";
export const UNTITLED = "Untitled project";

const live = (items) => items.filter((x) => !x.removing);

// The rows under New project: the projects in their stored order, leaving out any whose
// deletion can still be undone.
export const rows = (projects) => live(projects);

// The line under a project's name: how many of its detectors have their own tick. It
// counts the ticks whether or not the project is on, because unticking a project keeps
// them.
export const subtitle = (project, detectors) => {
  const mine = live(detectors).filter((d) => d.project === project.id);
  return `${mine.filter((d) => d.on).length} of ${mine.length} on`;
};

const shownHas = (context, id) => rows(context.projects).some((p) => p.id === id);

const picture = (output) => Array.isArray(output?.projects) && Array.isArray(output?.detectors);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
  },
}).createMachine({
  id: "detector-projects",
  meta: {
    description:
      "The journal's projects, the first level of the Detectors dock. New project is the first " +
      "row and adds a project with its name ready to write. Each row has a tick box that " +
      "switches the project on or off, its name, and how many of its detectors are on; picking a " +
      "row shows its detectors. A line says only ticked projects read the writing. Unticking a " +
      "project keeps each detector's own tick.",
    kind: "view",
    emits: ["detector-project.selected", "detector-project.switched", "detector-project.saved"],
    attributes: [],
    asks: ["journal: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    projects: [],
    detectors: [],
    // The row last opened; UI state, so the list marks what the dock was opened on.
    open: null,
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => picture(event.output),
            target: "ready",
            actions: assign(({ event }) => ({ projects: event.output.projects, detectors: event.output.detectors })),
          },
          // The fact could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        // The gestures (7.2: internal messages from the view).
        _pick: {
          guard: ({ context, event }) => shownHas(context, event.id),
          actions: [assign(({ event }) => ({ open: event.id })), emit(({ event }) => ({ type: "detector-project.selected", id: event.id }))],
        },
        _switch: {
          guard: ({ context, event }) =>
            typeof event.on === "boolean" && rows(context.projects).some((p) => p.id === event.id && p.on !== event.on),
          actions: emit(({ event }) => ({ type: "detector-project.switched", id: event.id, on: event.on })),
        },
        // A new project is made and opened at once, so its name, shown at the top of its
        // detectors, is the next thing to write.
        _new: {
          actions: [
            assign(({ context }) => ({ open: context.mint() })),
            emit(({ context }) => ({ type: "detector-project.saved", id: context.open, name: NEW_NAME })),
            emit(({ context }) => ({ type: "detector-project.selected", id: context.open })),
          ],
        },
      },
    },
    failed: {},
  },
  on: {
    "journal.changed": {
      actions: assign(({ event }) => ({ projects: event.projects, detectors: event.detectors })),
    },
  },
});
