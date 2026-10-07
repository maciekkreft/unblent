import { setup, assign, fromPromise } from "xstate";

// A view component (3.1): one way of looking at the bus traffic `trace` owns. It
// holds only what it is showing and which rows are expanded (UI state); the records
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

// A burst reads as one line. A typing run interleaves note.saved and note.changed,
// so folding only adjacent duplicates would fold nothing; instead records with the
// same signature no further apart than the gap are one run, listed where the first
// fell. Pure, so it is tested in Node and the view stays decision-free (3.2).
export const RUN_GAP_MS = 1000;
const signature = (r) => [r.tab, r.kind, r.name, r.from, r.to.join(","), r.outcome].join("|");
export function runs(records) {
  const out = [];
  const open = new Map();
  for (const r of records) {
    const k = signature(r);
    const run = open.get(k);
    if (run && r.at - run.at(-1).at <= RUN_GAP_MS) run.push(r);
    else {
      const fresh = [r];
      open.set(k, fresh);
      out.push(fresh);
    }
  }
  return out;
}

export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("trace", "list", {})),
  },
}).createMachine({
  id: "trace-list",
  meta: {
    description:
      "Shows the bus traffic `trace` keeps, as it arrives, with each row able to open to the " +
      "whole record. Records with the same sender and name that arrive close together, such as " +
      "a run of typing, are folded into one row.",
    kind: "view", emits: [], asks: ["trace: list"], attributes: [],
  },
  context: ({ input }) => ({ ask: input.ask, records: [], expanded: new Set() }),
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
    // Any number of rows can be open at once; a new Set each time, so the change
    // is seen (a mutated Set keeps its reference and would not update the view).
    _toggle: {
      actions: assign({
        expanded: ({ context, event }) => {
          const next = new Set(context.expanded);
          next.has(event.id) ? next.delete(event.id) : next.add(event.id);
          return next;
        },
      }),
    },
    // What has been shown is UI state (3.1); the records stay with `trace`, so a
    // reload shows them again. Nothing is announced: no fact changed.
    _clear: { actions: assign({ records: [], expanded: new Set() }) },
  },
});
