import { setup, assign, fromPromise } from "xstate";

// A view component (3.1): one way of looking at the bus traffic `trace` owns. It
// holds only what it is showing and which row is expanded (UI state); the records
// belong to `trace`, reached by one query for the starting picture and the
// `trace.recorded` event for everything after (4, fourth rule). The ask arrives
// through `input`, so the machine imports in Node.

const order = (a, b) =>
  a.at - b.at || (a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : 0) || a.seq - b.seq;

const key = (r) => `${r.tab}:${r.seq}`;

// Fold one record in, deduped by (tab, seq) and kept sorted. A record that arrives
// live during the initial load and again in the query reply lands once.
const merge = (records, record) =>
  records.some((r) => key(r) === key(record)) ? records : [...records, record].sort(order);

// The emitted event is the record with a `type` tag; drop it so stored records
// match the query reply's shape (7.1).
const fromEvent = (event) => {
  const { type, ...record } = event;
  return record;
};

export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("trace", "list", {})),
  },
}).createMachine({
  id: "trace-list",
  meta: { kind: "view", emits: [], asks: ["trace: list"], attributes: [] },
  context: ({ input }) => ({ ask: input.ask, records: [], expanded: null }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        // Fold the reply into whatever arrived live while loading, rather than
        // replace it, so a record that raced the query is not lost.
        onDone: {
          target: "ready",
          actions: assign({
            records: ({ context, event }) => (event.output.records ?? []).reduce(merge, context.records),
          }),
        },
        onError: { target: "ready" },
      },
    },
    ready: {},
  },
  on: {
    "trace.recorded": {
      actions: assign({ records: ({ context, event }) => merge(context.records, fromEvent(event)) }),
    },
    // Leading underscore (7.2): UI state, never routed. `id` is the row's tab:seq.
    _toggle: {
      actions: assign({ expanded: ({ context, event }) => (context.expanded === event.id ? null : event.id) }),
    },
  },
});
