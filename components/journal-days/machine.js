import { setup, assign, emit, fromPromise } from "xstate";

// The view component that lists the journal's days (6.4), the Days dock of the journal
// app. It owns only UI state — the rows it shows and which one was picked — and points at
// two facts: it asks journal: read and session: read for the starting picture and follows
// journal.changed and session.changed after (4.3, fourth rule). A pick leaves as
// day.selected (4.3, fifth rule). The ask arrives through input, so this stays
// a pure definition importable in Node.

const HOUR = 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD, as the journal dates a day.
const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A local time as HH:MM on the 24-hour clock, as the entry's banner names it.
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// A row's date, "Mon 12 Oct".
export const shortDate = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
};

const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

// The rows, newest first. The day that can still be edited shows a pill instead of its
// paragraph count: "today", or past midnight when it closes. With no day open, the new
// page for today is the first row, so it can be picked back after reading an earlier
// day. A row's id is what day.selected carries: null for the open day or the new page.
export const rows = (days, open, now) => {
  const out = [...days]
    .sort((a, b) => b.day.localeCompare(a.day) || b.id.localeCompare(a.id))
    .map((d) => {
      const isOpen = d.id === open;
      const pill = isOpen ? (d.day === dateOf(now) ? "today" : `open till ${clock(d.editedAt + HOUR)}`) : null;
      return { id: isOpen ? null : d.id, day: d.id, date: shortDate(d.day), first: lines(d.text)[0] ?? "", count: lines(d.text).length, pill };
    });
  if (open === null) out.unshift({ id: null, day: null, date: shortDate(dateOf(now)), first: "", count: 0, pill: "today" });
  return out;
};

export const KEPT_SIGNED_IN = "Kept on your account, on every device.";
export const KEPT_SIGNED_OUT = "Kept in this browser. Signing in keeps it on your account.";

export const kept = (signedIn) => (signedIn ? KEPT_SIGNED_IN : KEPT_SIGNED_OUT);

const isPicture = (r) => Array.isArray(r?.days);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
}).createMachine({
  id: "journal-days",
  meta: {
    description:
      "The Days dock of the journal: one row per day, newest first, with the short date, the " +
      "first line and how many paragraphs it has; the day that can still be edited shows a " +
      "\"today\" or \"open till HH:MM\" pill instead of the count. Picking a row shows that day " +
      "in the entry. A line says where the journal is kept: in this browser when signed out, on " +
      "your account when signed in.",
    kind: "view",
    emits: ["day.selected"],
    attributes: [],
    asks: ["journal: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    days: [],
    open: null,
    signedIn: false,
    // The row last picked, as day.selected carried it; null is the open day or new page.
    current: null,
  }),
  // Each fact's starting picture is asked on its own, so an event that follows one
  // reply is never overwritten by that reply arriving with the other.
  invoke: {
    src: "session",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign(({ event }) => ({ signedIn: typeof event.output?.userId === "string" })) },
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => isPicture(event.output),
            target: "ready",
            actions: assign(({ event }) => ({ days: event.output.days, open: event.output.open })),
          },
          // The journal could not answer: an honest failure rather than an empty list.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      on: {
        _pick: {
          guard: ({ context, event }) => event.id === null || context.days.some((d) => d.id === event.id),
          actions: [assign(({ event }) => ({ current: event.id })), emit(({ event }) => ({ type: "day.selected", id: event.id }))],
        },
      },
    },
    failed: {},
  },
  on: {
    // A picked day that is gone, or that has become the open one, is the open day again.
    "journal.changed": {
      actions: assign(({ context, event }) => ({
        days: event.days,
        open: event.open,
        current: context.current && context.current !== event.open && event.days.some((d) => d.id === context.current) ? context.current : null,
      })),
    },
    "session.changed": { actions: assign(({ event }) => ({ signedIn: typeof event.userId === "string" })) },
  },
});
