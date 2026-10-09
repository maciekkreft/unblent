import { setup, assign, emit, fromPromise } from "xstate";

// The view component that lists the Judge tools (6.4), the first child of
// list-then-item in the Tools dock. It owns only UI state — the rows it shows, which one
// was opened, and a draft id for New tool — and points at two facts: it asks
// projects: read and rubrics: read for the starting picture and follows their .changed
// events after (4.3, fourth rule). A tick and a pick leave as gestures (4.3, fifth
// rule). The ask and mint arrive through input, so this stays a pure definition
// importable in Node.
//
// New tool is always the first row and always names a minted id no tool has yet, as
// note-list's New note does: picking it opens an empty editor under that id; once the
// editor saves, rubric.changed brings the real row and a fresh draft is minted.

const live = (items) => items.filter((x) => !x.removing);

// The rows under New tool: the current project's tools in their stored order, leaving
// out any whose deletion can still be undone.
export const rows = (rubrics, project) => live(rubrics).filter((r) => r.project === project);

// The line under a tool's name: its questions, leaving out any being removed, and
// "· off" when Judge does not use it.
export const subtitle = (rubric) => {
  const n = live(rubric.questions).length;
  return `${n} question${n === 1 ? "" : "s"}${rubric.on ? "" : " · off"}`;
};

const remint = (context, rubrics) => (rubrics.some((r) => r.id === context.draft) ? context.mint() : context.draft);

const shownHas = (context, id) => rows(context.rubrics, context.current).some((r) => r.id === id);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => Promise.all([input.ask("projects", "read", {}), input.ask("rubrics", "read", {})])),
  },
}).createMachine({
  id: "rubric-list",
  meta: {
    description:
      "Lists the tools of the current project and lets the user pick one to edit; it is the list " +
      "of a list-then-item pair in the Tools dock. New tool is always the first row and opens an " +
      "empty editor; the tool appears in the list once something is written in it. Each row has " +
      "a tick box that switches the tool on or off for judging, its name, greyed when off, and " +
      "how many questions it has. A line says only ticked tools are used when judging.",
    kind: "view",
    emits: ["rubric.selected", "rubric.switched"],
    attributes: [],
    asks: ["projects: read", "rubrics: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    current: null,
    rubrics: [],
    // The row last opened; UI state, so the list marks what the editor was opened on.
    open: null,
    draft: input.mint(),
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => typeof event.output[0]?.current === "string" && Array.isArray(event.output[1]?.rubrics),
            target: "ready",
            actions: assign(({ context, event }) => {
              const [p, r] = event.output;
              return { current: p.current, rubrics: r.rubrics, draft: remint(context, r.rubrics) };
            }),
          },
          // A fact could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        // The gestures (7.2: internal messages from the view). A pick names a shown
        // tool or the draft; a tick names a shown tool and changes it.
        _pick: {
          guard: ({ context, event }) => event.id === context.draft || shownHas(context, event.id),
          actions: [assign(({ event }) => ({ open: event.id })), emit(({ event }) => ({ type: "rubric.selected", id: event.id }))],
        },
        _switch: {
          guard: ({ context, event }) =>
            typeof event.on === "boolean" &&
            context.rubrics.some((r) => r.id === event.id && r.project === context.current && !r.removing && r.on !== event.on),
          actions: emit(({ event }) => ({ type: "rubric.switched", id: event.id, on: event.on })),
        },
      },
    },
    failed: {},
  },
  on: {
    "project.changed": {
      actions: assign(({ event }) => ({ current: event.current })),
    },
    "rubric.changed": {
      actions: assign(({ context, event }) => ({ rubrics: event.rubrics, draft: remint(context, event.rubrics) })),
    },
  },
});
