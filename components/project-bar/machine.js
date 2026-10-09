import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component across the top of Judge (3.1): it owns only UI state and points at
// three facts. It asks projects: read, rubrics: read and cases: read for the starting
// picture and follows their .changed events after (4.3, fourth rule). What the user
// does in the menu leaves as gestures (4.3, fifth rule): project.selected,
// project.saved, and removal.started, whose Undo notice-stack shows. The ask and mint
// arrive through input, so this stays a pure definition importable in Node.

export const NEW_NAME = "New project";
export const UNTITLED = "Untitled project";

const live = (items) => items.filter((x) => !x.removing);

// The projects the menu lists: a project waiting out its undo window is hidden.
export const shown = (projects) => live(projects);

// What a typed name becomes: trimmed, and never empty, so a blank field keeps the name
// it replaces (7.1 sends no empty name).
export const named = (typed, fallback) => (typeof typed === "string" && typed.trim()) || fallback;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The line under a project's name: its tools and cases, leaving out any being removed.
export const summary = (id, rubrics, cases) => {
  const tools = live(rubrics).filter((r) => r.project === id).length;
  const kept = live(cases).filter((c) => c.project === id).length;
  return `${plural(tools, "tool", "tools")} · ${plural(kept, "case", "cases")}`;
};

// Only the last project left cannot be deleted; projects refuses it too.
export const canDelete = (projects) => live(projects).length > 1;

const currentOf = (context) => context.projects.find((p) => p.id === context.current);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) =>
      Promise.all([input.ask("projects", "read", {}), input.ask("rubrics", "read", {}), input.ask("cases", "read", {})]),
    ),
  },
}).createMachine({
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
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    projects: [],
    current: null,
    rubrics: [],
    cases: [],
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output[0]?.projects),
            target: "ready",
            actions: assign(({ event }) => {
              const [p, r, c] = event.output;
              // A tool or case list that cannot be read counts as none, so the bar
              // still works; projects is what it cannot do without.
              return {
                projects: p.projects,
                current: p.current,
                rubrics: Array.isArray(r?.rubrics) ? r.rubrics : [],
                cases: Array.isArray(c?.cases) ? c.cases : [],
              };
            }),
          },
          // projects could not answer: an honest failure rather than an empty bar.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        // The gestures (7.2: internal messages from the view).
        _pick: {
          guard: ({ context, event }) =>
            event.id !== context.current && shown(context.projects).some((p) => p.id === event.id),
          actions: emit(({ event }) => ({ type: "project.selected", id: event.id })),
        },
        _new: {
          actions: emit(({ context }) => ({ type: "project.saved", id: context.mint(), name: NEW_NAME })),
        },
        _rename: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const project = currentOf(context);
            if (!project) return;
            const name = named(event.name, project.name || NEW_NAME);
            if (name !== project.name) enqueue.emit({ type: "project.saved", id: project.id, name });
          }),
        },
        _delete: {
          guard: ({ context }) => canDelete(context.projects) && Boolean(currentOf(context)),
          actions: emit(({ context }) => {
            const project = currentOf(context);
            return { type: "removal.started", kind: "project", id: project.id, name: project.name };
          }),
        },
      },
    },
    failed: {},
  },
  on: {
    "project.changed": {
      actions: assign(({ event }) => ({ projects: event.projects, current: event.current })),
    },
    "rubric.changed": {
      actions: assign(({ event }) => ({ rubrics: event.rubrics })),
    },
    "case.changed": {
      actions: assign(({ event }) => ({ cases: event.cases })),
    },
  },
});
