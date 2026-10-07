import { setup, assign, emit, fromPromise } from "xstate";

// The view component that lists the gauges and lets one be picked (6.4), the first child
// of list-then-item in the Tools dock. It owns only UI state — the rows it shows, which
// one was picked, and a draft id for New tool — and points at `gauge`, which owns the
// fact: it asks gauge: read for the starting picture and follows gauge.changed after
// (4.3, fourth rule). The ask and mint arrive through input, so this stays a pure
// definition importable in Node.
//
// New tool is always the first row and always names a minted id no gauge has yet, as
// note-list's New note does: picking it opens an empty editor under that id; once the
// editor saves, gauge.changed brings the real row and a fresh draft is minted.

// The second line of a row: how many questions and how they are combined.
export const subtitle = (gauge) => {
  const n = gauge.questions.length;
  return `${n} question${n === 1 ? "" : "s"} · ${gauge.rule === "holds" ? "every must hold" : "each adds"}`;
};

const remint = (context, gauges) => (gauges.some((g) => g.id === context.draft) ? context.mint() : context.draft);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("gauge", "read", {})),
  },
}).createMachine({
  id: "gauge-list",
  meta: {
    description:
      "Lists the gauges and lets the user pick one to edit; it is the list of a list-then-item " +
      "pair in the Tools dock. New tool is always the first row and opens an empty editor; the " +
      "gauge appears in the list once something is written in it. Each row shows how many " +
      "questions the gauge has and how they are combined.",
    kind: "view", emits: ["gauge.selected"], attributes: [], asks: ["gauge: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    gauges: [],
    // The row last picked; UI state, so the list marks what the editor was opened on.
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
            guard: ({ event }) => Array.isArray(event.output.gauges),
            target: "ready",
            actions: assign(({ context, event }) => ({
              gauges: event.output.gauges,
              draft: remint(context, event.output.gauges),
            })),
          },
          // gauge could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        // A pick (7.2, internal gesture): only a gauge that exists, or the draft.
        _pick: {
          guard: ({ context, event }) => event.id === context.draft || context.gauges.some((g) => g.id === event.id),
          actions: [assign({ open: ({ event }) => event.id }), emit(({ event }) => ({ type: "gauge.selected", id: event.id }))],
        },
      },
    },
    failed: {},
  },
  on: {
    "gauge.changed": {
      actions: assign(({ context, event }) => ({ gauges: event.gauges, draft: remint(context, event.gauges) })),
    },
  },
});
