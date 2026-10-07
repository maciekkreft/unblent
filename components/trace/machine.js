import { setup, assign, emit, fromCallback } from "xstate";

// A local-only fact component (3.1): it owns the bus traffic of this session. The
// bus taps every routing decision (3.3); this keeps those records in memory since
// the page loaded, bridges the other tabs of the origin over a BroadcastChannel so
// an inspector tab sees an acting tab's traffic (section 12: tabs, not devices),
// and prints one line per record so the console is a transcript (section 10).
// Everything with a side effect — the tap, the channel, the console — arrives
// through `input`, so the machine is a pure definition importable in Node.

const CAP = 1000; // records kept; the oldest is dropped past this

// Chronological, then by tab and seq, so records from several tabs interleave in a
// stable order (the record fields of 7.1).
const order = (a, b) =>
  a.at - b.at || (a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : 0) || a.seq - b.seq;

const key = (r) => `${r.tab}:${r.seq}`;

// Add one record, keep the list sorted, and cap it by dropping the oldest.
const insert = (records, record) => {
  const next = [...records, record].sort(order);
  return next.length > CAP ? next.slice(next.length - CAP) : next;
};

// The console line (section 10): grep-able, one per record. A recipient the
// event's target state ignores is marked `~`; a reason follows anything but a
// plain delivery.
const line = (r) => {
  const to = r.to.map((t) => (r.ignored.includes(t) ? `~${t}` : t)).join(", ");
  const reason = r.reason ? `: ${r.reason}` : "";
  // Each recipient's resulting state after delivery (section 10), when the record
  // carries one (a reply record does not).
  const states = r.states && Object.keys(r.states).length
    ? ` [${Object.entries(r.states).map(([id, state]) => `${id}=${state}`).join(" ")}]`
    : "";
  return `trace #${r.seq} ${r.tab.slice(-4)} ${r.kind} ${r.name} ${r.from} → ${to} ${r.outcome}${reason}${states}`;
};

export const machine = setup({
  actors: {
    // The bus tap (3.3): every routing decision this tab makes.
    taps: fromCallback(({ input, sendBack }) =>
      input.tap((record) => sendBack({ type: "_recorded", record })),
    ),
    // The other tabs of this origin, over the channel. Each message shape becomes
    // its own internal event (7.2: a leading underscore is never routed by the bus).
    bridge: fromCallback(({ input, sendBack }) =>
      input.subscribe((message) => {
        if (message.type === "record") sendBack({ type: "_received", record: message.record });
        else if (message.type === "hello") sendBack({ type: "_hello" });
        else if (message.type === "buffer") sendBack({ type: "_buffer", records: message.records });
      }),
    ),
  },
}).createMachine({
  id: "trace",
  meta: {
    description:
      "Owns the record of everything the bus routed since the page loaded: each event and " +
      "query, who received it, and anything held, ignored, dropped or refused. It shares the " +
      "records with the other tabs of this browser, but not with other devices, and prints one " +
      "line per record to the console, so the console reads as a complete transcript. A field " +
      "marked secret never reaches it.",
    kind: "fact", shape: "local-only", emits: ["trace.recorded"], owns: "the bus traffic of this session",
  },
  context: ({ input }) => ({
    tab: input.tab,
    records: [],
    tap: input.tap,
    subscribe: input.subscribe,
    publish: input.publish,
    share: input.share,
    print: input.print,
  }),
  invoke: [
    { src: "taps", input: ({ context }) => ({ tap: context.tap }) },
    { src: "bridge", input: ({ context }) => ({ subscribe: context.subscribe }) },
  ],
  on: {
    // A record the bus tapped in this tab. Its own traffic is skipped so it never
    // records itself (which would recurse through the emit below) and so the
    // inspector's own list queries do not clutter the transcript. The tab id is
    // stamped here, the one field the bus cannot know (7.1).
    _recorded: {
      guard: ({ event }) => event.record.from !== "trace" && !event.record.to.includes("trace"),
      actions: [
        assign({ records: ({ context, event }) => insert(context.records, { ...event.record, tab: context.tab }) }),
        emit(({ context, event }) => ({ type: "trace.recorded", ...event.record, tab: context.tab })),
        ({ context, event }) => context.publish({ ...event.record, tab: context.tab }),
        ({ context, event }) => context.print(line({ ...event.record, tab: context.tab })),
      ],
    },
    // A record from another tab. Deduped by (tab, seq); never republished, or two
    // tabs would echo forever.
    _received: {
      guard: ({ context, event }) => !context.records.some((r) => key(r) === key(event.record)),
      actions: [
        assign({ records: ({ context, event }) => insert(context.records, event.record) }),
        emit(({ event }) => ({ type: "trace.recorded", ...event.record })),
        ({ context, event }) => context.print(line(event.record)),
      ],
    },
    // A buffer of another tab's records (its answer to our hello): fold each in
    // through _received, so the dedupe and sort happen once, in one place.
    _buffer: {
      actions: ({ event, self }) => {
        for (const record of event.records) self.send({ type: "_received", record });
      },
    },
    // A new tab announced itself: share our own records so it starts with our
    // history. Only our own, so the answer stays small and never re-shares foreign
    // records.
    _hello: {
      actions: ({ context }) => context.share(context.records.filter((r) => r.tab === context.tab)),
    },
    // The starting picture for a view (4, fourth rule): everything kept so far.
    "list?": {
      actions: ({ context, event }) => event.reply({ records: context.records }),
    },
  },
});
