import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the Usage tab of the gear's sheet. It owns no fact: the time
// spent belongs to `usage`, the switch to `settings` and who the account is to
// `session`. Settings and session are each reached by one query for the starting
// picture and their event after (4.3, fourth rule); the summary is asked again each
// time the tab is shown and when You or All accounts is picked, since `usage`
// announces nothing. The switch is emitted as settings.edited with the whole settings,
// and nothing is assigned locally: settings.changed is the only assignment. Its own UI
// state is the range, whose usage and the feature followed. The ask and the clock
// arrive through `input`, so the machine imports in Node.

// The features in the order the tab names them; the ids are the ones `usage` answers
// with (queries/summary.json in usage) and the suffix of each --color-feature-* token.
export const FEATURES = [
  { id: "journal", name: "Journal" },
  { id: "reading", name: "Reading" },
  { id: "highlights", name: "Highlights" },
  { id: "notes", name: "Notes" },
  { id: "chats", name: "Chats" },
  { id: "evaluators", name: "Evaluators" },
  { id: "choice", name: "Choice Points" },
  { id: "values", name: "Values" },
  { id: "other", name: "Other" },
];
const nameOf = (id) => FEATURES.find((f) => f.id === id)?.name ?? id;

// How many days each range covers, today included; All is every day `usage` answers.
export const RANGES = { week: 7, month: 30, all: 182 };
export const DAYS = RANGES.all;

const pad = (n) => String(n).padStart(2, "0");
// The browser's local date, the same day `usage` counts in.
export const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
// Noon keeps a day's date the same across a change of summer time.
const dateOf = (day) => new Date(`${day}T12:00:00`);

// The days of the calendar, oldest first, today last.
export const windowOf = (now, n = DAYS) => {
  const d = new Date(now);
  return Array.from({ length: n }, (_, i) => dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (n - 1 - i)).getTime()));
};

// Whole minutes, as people read a duration: "25 min", "1 h 20 min", "2 h".
export const formatMs = (ms) => {
  const m = Math.round((ms ?? 0) / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
};

export const dayName = (day) => dateOf(day).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const monthName = (day) => dateOf(day).toLocaleDateString("en-GB", { month: "long" });
const monthShort = (day) => dateOf(day).toLocaleDateString("en-GB", { month: "short" });

// The calendar's five shades: nothing, then four steps up to the busiest day.
export const levelOf = (ms, max) => (!(ms > 0) || !(max > 0) ? 0 : Math.min(4, 1 + Math.floor((ms / max) * 4)));

// The admin on the website, not viewing as someone: the one who may see all accounts
// added up (12). Not on a Mac, where the account is the Mac's own or the relay's.
export const mayAllOf = (session) =>
  Boolean(session && !session.error && session.userId != null && session.admin === true && !session.viewingAs && !session.connect);

// A Mac that is not connected keeps its counts on its own server (3.4).
export const onMacOf = (session) => Boolean(session && !session.error && session.connect && session.connect !== "on");

// Whose usage is shown: All accounts only while the account may see it.
export const whoOf = (context) => (context.who === "all" && mayAllOf(context.session) ? "all" : "you");

const sameAccount = (a, b) => (a?.userId ?? null) === (b?.userId ?? null);

// The settings as settings.edited carries them: the fields its schema names, so the
// active profile that settings.changed adds is left out.
const adopt = (event) => ({
  nav: (event.nav ?? []).map((r) => ({ path: r.path, hidden: r.hidden })),
  viewportSwitchHidden: event.viewportSwitchHidden === true,
  layoutSwitchHidden: event.layoutSwitchHidden === true,
  arranging: event.arranging === true,
  vimKeys: event.vimKeys === true,
  keepOpen: event.keepOpen === true,
  usageCounting: event.usageCounting === true,
  editors: { ...(event.editors ?? {}) },
});

const sessionOf = (event) => {
  const { type: _type, ...picture } = event ?? {};
  return picture;
};

// Everything the tab draws for one range, from the summary `usage` answered. `focus`
// is the feature followed, or null for all of them.
export function pictureOf(summary, range, now, focus = null) {
  const calendar = windowOf(now);
  const span = RANGES[range] ?? RANGES.week;
  const inRange = new Set(calendar.slice(DAYS - span));
  const perDay = new Map(calendar.map((day) => [day, Object.fromEntries(FEATURES.map((f) => [f.id, 0]))]));
  for (const row of summary?.days ?? []) {
    const day = perDay.get(row.day);
    if (day && row.feature in day) day[row.feature] += row.ms;
  }
  const sums = Object.fromEntries(FEATURES.map((f) => [f.id, 0]));
  for (const [day, by] of perDay) if (inRange.has(day)) for (const f of FEATURES) sums[f.id] += by[f.id];
  const totals = FEATURES.map((f) => ({ ...f, ms: sums[f.id] }))
    .filter((f) => f.ms > 0)
    .sort((a, b) => b.ms - a.ms);
  const total = totals.reduce((s, f) => s + f.ms, 0);

  const ofDay = (by) => (focus ? by[focus] ?? 0 : FEATURES.reduce((s, f) => s + by[f.id], 0));
  const max = Math.max(0, ...[...perDay.values()].map(ofDay));
  const cells = calendar.map((day, i) => {
    const ms = ofDay(perDay.get(day));
    return { day, ms, level: levelOf(ms, max), out: !inRange.has(day), today: i === DAYS - 1 };
  });

  // The flowing chart: one point per feature per day, or per week for All, each dated
  // by its last day; every feature in every point, in FEATURES order, so the chart's
  // colours keep their place.
  const step = range === "all" ? 7 : 1;
  const days = calendar.slice(DAYS - span);
  const river = [];
  for (let s = 0; s < days.length; s += step) {
    const bucket = days.slice(s, s + step);
    for (const f of FEATURES) {
      const ms = bucket.reduce((sum, day) => sum + perDay.get(day)[f.id], 0);
      river.push([bucket.at(-1), Math.round(ms / 60000), f.name]);
    }
  }

  return {
    total,
    totals,
    cells,
    river,
    step,
    span,
    active: cells.filter((c) => !c.out && c.ms > 0).length,
    first: { long: monthName(calendar[0]), short: monthShort(calendar[0]) },
    any: (summary?.days ?? []).some((r) => r.ms > 0),
  };
}

// The line under the total, in three parts so the view can set the feature in bold:
// "This week you spent this long in Unblent, most of it in **Journal** (41%)."
export function lineOf(picture, range, who, accounts) {
  const when = { week: "This week", month: "In the last 30 days", all: `Since ${picture.first.long}` }[range] ?? "This week";
  const whom = who === "all" ? (accounts === 1 ? "1 account spent" : `all ${accounts} accounts spent`) : "you spent";
  const top = picture.totals[0];
  if (!top) return { lead: `${when} nothing was counted.`, top: "", tail: "" };
  return {
    lead: `${when} ${whom} this long in Unblent, most of it in `,
    top: top.name,
    tail: ` (${Math.round((top.ms / picture.total) * 100)}%).`,
  };
}

// The hover text of one day of the calendar.
export const cellTip = (cell, focus) =>
  `${dayName(cell.day)} · ${cell.ms > 0 ? formatMs(cell.ms) : "nothing"}${focus ? ` in ${nameOf(focus)}` : ""}`;

export const machine = setup({
  actors: {
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    summary: fromPromise(({ input }) => input.ask("usage", "summary", { who: input.who })),
  },
  guards: {
    ready: ({ context }) => context.settings !== null,
    mayAll: ({ context }) => mayAllOf(context.session),
    // A new account, or All accounts no longer allowed, needs the summary again.
    sessionMoves: ({ context, event }) =>
      context.asked &&
      (!sameAccount(context.session, event) || whoOf(context) !== whoOf({ ...context, session: sessionOf(event) })),
    // Turning the switch on shows what is there already.
    turnsOn: ({ context, event }) => context.asked && context.settings?.usageCounting !== true && event.usageCounting === true,
    whoMoves: ({ context, event }) => context.asked && whoOf(context) !== whoOf({ ...context, who: event.who }),
  },
  actions: {
    adoptSession: assign({ session: ({ event }) => sessionOf(event) }),
    adoptSettings: assign({ settings: ({ event }) => adopt(event) }),
  },
}).createMachine({
  id: "usage-tab",
  meta: {
    description:
      "The Usage tab of the gear's sheet, shown to everyone while the Usage feature is " +
      "shown. At the top is the switch Share usage statistics from this device, off until " +
      "the person turns it on, with what it sends (which features are used and for how " +
      "long, never what is written or read) and that it may stay off for good; on a Mac " +
      "that is not connected it adds that the counts stay on the Mac. The switch is one " +
      "device setting, so Undo turns it back. While it is off the tab shows an empty " +
      "placeholder and says so. While it is on: Week, Month or All; for the admin on the " +
      "website, not while viewing as someone, also You or All accounts on the admin tint; " +
      "the total time and which feature took most of it; tiles sized by the time in each " +
      "feature, with a row of buttons naming them; a flowing chart of minutes per day " +
      "(per week for All); and a calendar of the last 182 days, the range in full colour, " +
      "each day shaded by its time, with the day and its time on hover. Clicking a tile, " +
      "a band or a button follows that feature in all three pictures and greys the others; " +
      "clicking it again, or Escape, shows all again. The arrow keys, and h and l with " +
      "Vim keys on, move between the buttons of a row. The summary is asked when the tab " +
      "is shown and when You or All accounts is picked; it does not change while open.",
    kind: "view",
    emits: ["settings.edited"],
    attributes: [],
    asks: ["usage: summary", "settings: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    now: input.now ?? Date.now,
    settings: null,
    session: null,
    who: "you",
    range: "week",
    focus: null,
    summary: null,
    // Whether the summary was asked once: until the tab is first shown nothing is asked.
    asked: false,
  }),
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ settings: ({ event }) => (event.output && !event.output.error ? adopt(event.output) : null) }) },
      onError: { actions: [] },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ session: ({ event }) => sessionOf(event.output) }) },
      onError: { actions: [] },
    },
  ],
  initial: "idle",
  states: {
    idle: {},
    asking: {
      entry: assign({ asked: true }),
      invoke: {
        src: "summary",
        input: ({ context }) => ({ ask: context.ask, who: whoOf(context) }),
        onDone: { target: "idle", actions: assign({ summary: ({ event }) => event.output ?? { error: "unavailable" } }) },
        onError: { target: "idle", actions: assign({ summary: { error: "unavailable" } }) },
      },
    },
  },
  on: {
    "settings.changed": [
      { guard: "turnsOn", target: ".asking", actions: "adoptSettings" },
      { actions: "adoptSettings" },
    ],
    "session.changed": [
      { guard: "sessionMoves", target: ".asking", actions: "adoptSession" },
      { actions: "adoptSession" },
    ],
    _show: { target: ".asking" },
    _who: [
      { guard: "whoMoves", target: ".asking", actions: assign({ who: ({ event }) => event.who }) },
      { guard: "mayAll", actions: assign({ who: ({ event }) => event.who }) },
    ],
    _range: { guard: ({ event }) => event.range in RANGES, actions: assign({ range: ({ event }) => event.range }) },
    _focus: { actions: assign({ focus: ({ context, event }) => (context.focus === event.feature ? null : event.feature) }) },
    _clear: { actions: assign({ focus: null }) },
    _toggle: {
      guard: "ready",
      actions: emit(({ context }) => ({ type: "settings.edited", ...context.settings, usageCounting: !context.settings.usageCounting })),
    },
  },
});
