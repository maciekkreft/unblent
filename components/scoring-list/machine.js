import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The view component that lists the scorings (6.4), the History tab of the Gauge app's
// left dock. It owns only UI state — the rows it shows, which one is picked, and which
// are counting down to a delete — and points at `scorings`, which owns the fact: it asks
// scorings: list for the starting picture and follows scoring.changed after (4.3, fourth
// rule). The ask and the undo window arrive through input, so this stays a pure
// definition importable in Node.

const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// When a scoring was made, in the device's own time: the clock time today, "Yesterday"
// and the time, else the day and month.
export const when = (at, now) => {
  const d = new Date(at);
  const today = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (day(d) === day(today)) return time;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (day(d) === day(yesterday)) return `Yesterday ${time}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("scorings", "list", {})),
  },
  delays: {
    undo: ({ context }) => context.undoMs,
  },
}).createMachine({
  id: "scoring-list",
  meta: {
    description:
      "The History list of the Gauge app: every post scored on this device, newest first, each " +
      "row with the post's first line, when it was scored, and the band word of each tool. " +
      "Picking a row brings that scoring back to the stage; after a new Score the newest row is " +
      "the picked one. The bin on a row deletes it after the undo window, and Undo keeps it.",
    kind: "view",
    emits: ["scoring.selected", "scoring.discarded"],
    attributes: ["height"],
    asks: ["scorings: list"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    undoMs: input.undoMs ?? 3000,
    scorings: [],
    // The row on the stage. The stage shows the newest scoring at load and after a Score,
    // so the list marks the newest until the user picks another.
    open: null,
    deleting: new Set(),
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output.scorings),
            target: "ready",
            actions: assign(({ event }) => ({
              scorings: event.output.scorings,
              open: event.output.scorings[0]?.id ?? null,
            })),
          },
          // scorings could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        _pick: {
          guard: ({ context, event }) => context.scorings.some((s) => s.id === event.id) && !context.deleting.has(event.id),
          actions: [assign({ open: ({ event }) => event.id }), emit(({ event }) => ({ type: "scoring.selected", id: event.id }))],
        },
        // The bin begins the undo window; only its elapse makes the delete a fact.
        _delete: {
          guard: ({ context, event }) => context.scorings.some((s) => s.id === event.id) && !context.deleting.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.assign({ deleting: ({ context }) => new Set(context.deleting).add(event.id) });
            enqueue.raise({ type: "_elapsed", id: event.id }, { delay: "undo", id: `undo:${event.id}` });
          }),
        },
        _undo: {
          guard: ({ context, event }) => context.deleting.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.cancel(`undo:${event.id}`);
            enqueue.assign({ deleting: ({ context }) => without(context.deleting, event.id) });
          }),
        },
        _elapsed: {
          guard: ({ context, event }) => context.deleting.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.assign({ deleting: ({ context }) => without(context.deleting, event.id) });
            enqueue.emit({ type: "scoring.discarded", id: event.id });
          }),
        },
      },
    },
    failed: {},
  },
  on: {
    // A new scoring at the top is the one the stage now shows, so it becomes the picked row.
    "scoring.changed": {
      actions: assign(({ context, event }) => {
        const first = event.scorings[0]?.id ?? null;
        const isNew = first !== null && !context.scorings.some((s) => s.id === first);
        const ids = new Set(event.scorings.map((s) => s.id));
        return {
          scorings: event.scorings,
          open: isNew ? first : ids.has(context.open) ? context.open : null,
        };
      }),
    },
  },
});
