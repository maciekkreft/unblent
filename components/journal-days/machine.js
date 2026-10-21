import { setup, assign, emit, fromPromise } from "xstate";

// The view component that lists the journal's days (6.4), the Days dock of the journal
// app. It owns only UI state — the rows it shows and which one was picked — and points at
// three facts: it asks journal: read, session: read and choice-points: list for the
// starting picture and follows their events after (4.3, fourth rule). A pick leaves as
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

// What a row needs of a choice point: its day, to count it there, and its version, so
// an event older than what is held is ignored (4.3, fourth rule).
const held = (c) => ({ day: c.day, version: c.version, removing: c.removing === true });

// How many choice points each day has, by date. One waiting out its undo window is not
// counted: to the user it is already gone, and an undo counts it again.
export const counts = (choicePoints) => {
  const out = {};
  for (const c of Object.values(choicePoints)) if (!c.removing) out[c.day] = (out[c.day] ?? 0) + 1;
  return out;
};

export const choiceLabel = (n) => (n === 1 ? "1 choice point" : `${n} choice points`);

// The rows, newest first. The day that can still be edited shows a pill instead of its
// paragraph count: "today", or past midnight when it closes. With no day open, the new
// page for today is the first row, so it can be picked back after reading an earlier
// day. A row's id is what day.selected carries: null for the open day or the new page.
export const rows = (days, open, now, perDay = {}) => {
  const out = [...days]
    .sort((a, b) => b.day.localeCompare(a.day) || b.id.localeCompare(a.id))
    .map((d) => {
      const isOpen = d.id === open;
      const pill = isOpen ? (d.day === dateOf(now) ? "today" : `open till ${clock(d.editedAt + HOUR)}`) : null;
      return { id: isOpen ? null : d.id, day: d.id, date: shortDate(d.day), first: lines(d.text)[0] ?? "", count: lines(d.text).length, pill, choices: perDay[d.day] ?? 0 };
    });
  if (open === null) out.unshift({ id: null, day: null, date: shortDate(dateOf(now)), first: "", count: 0, pill: "today", choices: perDay[dateOf(now)] ?? 0 });
  return out;
};

export const KEPT_SIGNED_IN = "Kept on your account, on every device.";
export const KEPT_SIGNED_OUT = "Kept in this browser. Signing in keeps it on your account.";

export const kept = (signedIn) => (signedIn ? KEPT_SIGNED_IN : KEPT_SIGNED_OUT);

const isPicture = (r) => Array.isArray(r?.days);

// A session reply without a userId (no-answerer on a page or in a test without `session`)
// counts as signed in, so a page that cannot tell never hides the days.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// What the list shows of the account (14, signed out): "wait" until session answers, so
// neither the days nor the sign-in line flash; "sign-in" signed out, since the days kept
// in this browser are the account's; "show" otherwise. A try page (8) shows the days to a
// visitor who is not yet a guest.
export const showing = ({ tryPage, signedIn }) => (tryPage ? "show" : signedIn === null ? "wait" : signedIn ? "show" : "sign-in");

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    choicePoints: fromPromise(({ input }) => input.ask("choice-points", "list", {})),
  },
}).createMachine({
  id: "journal-days",
  meta: {
    description:
      "The Days dock of the journal: one row per day, newest first, with the short date, the " +
      "first line and how many paragraphs it has; the day that can still be edited shows a " +
      "\"today\" or \"open till HH:MM\" pill instead of the count. Picking a row shows that day " +
      "in the entry. A line says where the journal is kept: on your account when signed in, in " +
      "this browser when signed out on a try page. A day with choice points says how many after its count or " +
      "pill, \"· 1 choice point\" or \"· 3 choice points\"; one being deleted is not counted " +
      "while its Undo is offered, and counts again after an undo. When the choice points cannot " +
      "be read, the rows show no counts and work as before. Signed out it shows no rows, only " +
      "\"Sign in to write in your journal.\", as the journal page does; the days stay kept in " +
      "this browser and come back when the user signs in, without a reload. On a try page a " +
      "visitor not yet signed in still sees the days.",
    kind: "view",
    emits: ["day.selected"],
    attributes: [],
    asks: ["journal: read", "session: read", "choice-points: list"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    days: [],
    open: null,
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
    // Whether the page is a try page (8), from the view, so this stays importable in Node.
    tryPage: Boolean(input.tryPage),
    // Every choice point by id, as held(): only the counts are shown.
    choicePoints: {},
    // The row last picked, as day.selected carried it; null is the open day or new page.
    current: null,
  }),
  // Each fact's starting picture is asked on its own, so an event that follows one
  // reply is never overwritten by that reply arriving with the other.
  invoke: [
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
    // An error reply (no choice-points on the page) leaves the rows without counts.
    {
      src: "choicePoints",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ event }) => Array.isArray(event.output?.choicePoints),
        actions: assign(({ event }) => ({ choicePoints: Object.fromEntries(event.output.choicePoints.map((c) => [c.id, held(c)])) })),
      },
      onError: {},
    },
  ],
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
    // A choice point never changes its day, so a changed one only moves a count up or down.
    "choice-point.changed": {
      guard: ({ context, event }) => !(context.choicePoints[event.choicePoint.id]?.version > event.choicePoint.version),
      actions: assign(({ context, event }) => ({ choicePoints: { ...context.choicePoints, [event.choicePoint.id]: held(event.choicePoint) } })),
    },
    "choice-point.deleted": {
      actions: assign(({ context, event }) => {
        const { [event.id]: _gone, ...rest } = context.choicePoints;
        return { choicePoints: rest };
      }),
    },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null }) },
  },
});
