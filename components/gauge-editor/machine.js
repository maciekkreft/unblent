import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that edits one gauge (6.4): the item list-then-item shows under its
// Back bar when gauge.selected arrives. It owns only UI state — the gauge being edited as
// a draft, which questions and whether the whole gauge are counting down to removal — and
// points at `gauge`, which owns the fact: gauge: read for the starting picture,
// gauge.changed after (4.3, fourth rule). Every edit is emitted as the whole gauge,
// gauge.saved, at a throttle while typing and at once on blur, as note-editor does
// (4.3, third rule). Removing a question and deleting the gauge wait out the undo window
// before they become facts (forgiveness). The ask, the id minting and the two timings
// arrive through input, so the machine is a pure definition importable in Node.

const blankQuestion = (id) => ({ id, text: "", yes: "", no: "" });
const blank = (id, mint) => ({ id, name: "", question: "", rule: "adds", questions: [blankQuestion(mint())] });

// The draft as gauge.saved carries it: the gauge's own fields, never its reading.
const wire = (g) => ({
  id: g.id,
  name: g.name,
  question: g.question,
  rule: g.rule,
  questions: g.questions.map((q) => {
    const out = { id: q.id, text: q.text, yes: q.yes, no: q.no };
    if (typeof q.label === "string") out.label = q.label;
    return out;
  }),
});

// A gauge with nothing written in it is not saved: a New tool opened and left adds no
// row to the list.
export const isEmpty = (g) => !g.name.trim() && !g.question.trim() && g.questions.every((q) => !q.text.trim());

const opened = (context, id) => {
  const found = context.gauges.find((g) => g.id === id);
  return found ? wire(found) : blank(id, context.mint);
};

const save = enqueueActions(({ context, enqueue }) => {
  if (context.draft && !isEmpty(context.draft)) enqueue.emit({ type: "gauge.saved", ...wire(context.draft) });
});

// Leaving a gauge for another (a new gauge.selected) settles what was in flight on the
// one being left: the questions counting down are dropped now and the draft is saved,
// so nothing the user did is lost by moving on. A gauge counting down to its delete is
// left to its own timer, which still makes the delete a fact.
const settle = enqueueActions(({ context, enqueue }) => {
  if (!context.draft || context.deleting) return;
  for (const id of context.removing) enqueue.cancel(`remove:${id}`);
  const draft = { ...context.draft, questions: context.draft.questions.filter((q) => !context.removing.has(q.id)) };
  if (!isEmpty(draft)) enqueue.emit({ type: "gauge.saved", ...wire(draft) });
});

const patchQuestion = (draft, id, patch) => ({
  ...draft,
  questions: draft.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)),
});

const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

// The typing gestures, the same in clean and dirty; only the target differs.
const edits = (target) => ({
  _edit: { target, actions: assign({ draft: ({ context, event }) => ({ ...context.draft, ...event.patch }) }) },
  _editQuestion: {
    target,
    actions: assign({ draft: ({ context, event }) => patchQuestion(context.draft, event.id, event.patch) }),
  },
  _addQuestion: {
    target,
    actions: assign({
      draft: ({ context }) => ({ ...context.draft, questions: [...context.draft.questions, blankQuestion(context.mint())] }),
    }),
  },
});

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("gauge", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "gauge-editor",
  meta: { kind: "view", emits: ["gauge.saved", "gauge.discarded"], attributes: ["height"], asks: ["gauge: read"] },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    undoMs: input.undoMs,
    throttleMs: input.throttleMs ?? 200,
    gauges: [],
    draft: null,
    // A pick that arrived before the starting picture; opened once it lands.
    want: null,
    removing: new Set(),
    deleting: false,
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ context, event }) => Array.isArray(event.output.gauges) && context.want != null,
            target: "editing",
            actions: assign(({ context, event }) => {
              const gauges = event.output.gauges;
              return { gauges, draft: opened({ ...context, gauges }, context.want), want: null };
            }),
          },
          { target: "idle", actions: assign({ gauges: ({ event }) => event.output.gauges ?? [] }) },
        ],
        onError: "idle",
      },
      on: { "gauge.selected": { actions: assign({ want: ({ event }) => event.id }) } },
    },
    idle: {},
    editing: {
      initial: "clean",
      states: {
        clean: {
          on: {
            ...edits("dirty"),
            // Another tab's change reaches the draft only here, while nothing typed in
            // this editor is waiting to be saved, so it never overwrites typing. A gauge
            // counting down to its delete keeps what is on screen.
            "gauge.changed": {
              actions: assign(({ context, event }) => {
                const found = event.gauges.find((g) => g.id === context.draft.id);
                return { gauges: event.gauges, draft: found && !context.deleting ? wire(found) : context.draft };
              }),
            },
          },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        dirty: {
          on: { ...edits(undefined), _blur: { target: "clean", actions: save } },
          after: { throttle: { target: "clean", actions: save } },
        },
      },
      on: {
        _removeQuestion: {
          guard: ({ context, event }) => !context.removing.has(event.id) && context.draft.questions.some((q) => q.id === event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.assign({ removing: ({ context }) => new Set(context.removing).add(event.id) });
            enqueue.raise({ type: "_removeElapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `remove:${event.id}` });
          }),
        },
        _undoRemove: {
          guard: ({ context, event }) => context.removing.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.cancel(`remove:${event.id}`);
            enqueue.assign({ removing: ({ context }) => without(context.removing, event.id) });
          }),
        },
        _removeElapsed: {
          guard: ({ context, event }) => context.removing.has(event.id),
          actions: [
            assign(({ context, event }) => ({
              removing: without(context.removing, event.id),
              draft: { ...context.draft, questions: context.draft.questions.filter((q) => q.id !== event.id) },
            })),
            save,
          ],
        },
        _delete: {
          guard: ({ context }) => !context.deleting,
          actions: enqueueActions(({ context, enqueue }) => {
            enqueue.assign({ deleting: true });
            enqueue.raise({ type: "_deleteElapsed", id: context.draft.id }, { delay: ({ context }) => context.undoMs, id: "delete" });
          }),
        },
        _undoDelete: {
          guard: ({ context }) => context.deleting,
          actions: enqueueActions(({ enqueue }) => {
            enqueue.cancel("delete");
            enqueue.assign({ deleting: false });
          }),
        },
      },
    },
    deleted: {},
  },
  on: {
    "gauge.changed": { actions: assign({ gauges: ({ event }) => event.gauges }) },
    "gauge.selected": {
      target: ".editing",
      actions: [
        settle,
        assign(({ context, event }) => ({ draft: opened(context, event.id), removing: new Set(), deleting: false })),
      ],
    },
    // The delete window ran out: now it is a fact. The editor shows the deleted page only
    // if it is still on that gauge; a pick made meanwhile has moved it on.
    _deleteElapsed: [
      {
        guard: ({ context, event }) => context.draft?.id === event.id,
        target: ".deleted",
        actions: [emit(({ event }) => ({ type: "gauge.discarded", id: event.id })), assign({ deleting: false, draft: null })],
      },
      { actions: emit(({ event }) => ({ type: "gauge.discarded", id: event.id })) },
    ],
  },
});
