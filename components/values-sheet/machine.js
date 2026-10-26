import { setup, assign, enqueueActions, fromPromise, spawnChild, stopChild } from "xstate";

// The view component that shows the client's values on a journal day (6.4). It owns only
// UI state — the day shown, that day's version as the fact last said it, whether the sheet
// is open, its drafts, which values wait out their undo window, and which other version is
// being looked at — and points at one fact: it asks values: read for the shown day and
// values: versions for the days the values changed, and follows values.changed after (4.3,
// fourth rule). The day comes from day.shown, so the rule for which day the journal shows
// stays in journal-entry. Writing leaves as values.saved, the whole list (4.3, third rule).
// It also asks settings: read for the "Vim keys" preference (12) and follows
// settings.changed. The ask, the id minting, the clock, the throttle and the undo window
// arrive through input, so the machine is importable in Node.

export const FIELDS = ["name", "meaning"];

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the
// journal page first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// A day as the footer says it, "12 October" as the journal dates its pages, with the year
// only when it is not this one.
export function dayName(day, today) {
  const [y, m, d] = day.split("-").map(Number);
  const name = `${d} ${MONTHS[m - 1]}`;
  return today && today.slice(0, 4) === day.slice(0, 4) ? name : `${name} ${y}`;
}

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

// Only today's page writes the values (the values fact ignores any other day): not
// yesterday's in the hour after midnight the journal keeps its text open, so a version
// never changes after its day. A day the journal says cannot be written is read only too.
export const writable = (context) => context.day === dateOf(context.now()) && context.dayWritable !== false;

const blank = (id) => ({ id, name: "", meaning: "" });
const copy = (values) => values.map((v) => ({ id: v.id, name: v.name, meaning: v.meaning }));

export const isEmpty = (v) => !v.name.trim() && !v.meaning.trim();

// What a save sends: every row with a name or a sentence, in the sheet's order. A value
// waiting out its undo window is still kept until the window ends.
export const savedValues = (drafts) => copy(drafts.filter((d) => !isEmpty(d)));

// `finished` names the rows the user has just left, of those saved, so their lines can be
// checked once they are written and not while they are typed.
const save = (enqueue, context, values, finished = []) => {
  if (!writable(context)) return;
  const left = finished.filter((id) => values.some((v) => v.id === id));
  enqueue.emit({ type: "values.saved", day: context.day, values, ...(left.length ? { finished: left } : {}) });
};

// The values the folded card names: the sheet's own while it is open, otherwise the
// version the fact said, without those waiting to be removed.
export function shownValues(context) {
  const list = context.open && writable(context) ? context.drafts : (context.version?.values ?? []);
  return list.filter((v) => !context.removing.includes(v.id) && !isEmpty(v));
}

// The days the values changed before the version the shown day holds, newest first:
// what "Earlier versions" lists.
export function earlierDays(context) {
  const before = context.version?.day ?? context.day;
  return context.days.filter((d) => d < before).sort().reverse();
}

// What the footer says about when the shown version was written.
export function changedLine(context) {
  const day = context.version?.day;
  if (!day) return "";
  const today = dateOf(context.now());
  return day === today ? "Changed today" : `Last changed ${dayName(day, today)}`;
}

// The open sheet follows a version from the fact only while nothing typed waits to be
// saved and no value waits out its undo window, so a change never overwrites what is on
// screen. Rows keep their order; a value the fact no longer has goes, unless it is an
// empty row the user has just added; a value new to the sheet joins at the end.
function merged(drafts, values) {
  const by = new Map(values.map((v) => [v.id, v]));
  const kept = drafts.filter((d) => by.has(d.id) || isEmpty(d)).map((d) => (by.has(d.id) ? { ...by.get(d.id) } : d));
  const ids = new Set(kept.map((d) => d.id));
  return [...kept, ...copy(values.filter((v) => !ids.has(v.id)))];
}

// A version for the shown day, or an earlier one newer than what is held, is the shown
// day's. Which days are worth listing, and whether the values changed since, only the fact
// can say, since a change can make an earlier version read as today's: they are asked
// again (recount).
const follow = enqueueActions(({ context, event, enqueue }) => {
  if (!isDay(event.day) || !Array.isArray(event.values)) return;
  enqueue.stopChild("recount");
  enqueue.spawnChild("recount", { id: "recount", input: { ask: context.ask, day: context.day } });
  const version = context.version;
  if (!version || event.day > context.day) return;
  if (version.day && event.day < version.day) return;
  enqueue.assign({ version: { day: event.day, values: copy(event.values), changedSince: version.changedSince } });
  if (context.open && !context.dirty && !context.removing.length) enqueue.assign({ drafts: merged(context.drafts, event.values) });
});

const saveWaiting = enqueueActions(({ context, enqueue }) => {
  if (!context.dirty) return;
  save(enqueue, context, savedValues(context.drafts));
  enqueue.assign({ dirty: false });
});

// Leaving rows typed in since they were last left: the save names them as finished, even
// when the throttle already saved their text (the values fact ignores a save that changes
// nothing). Leaving any other row only saves what waits.
const leaveRows = (rows) =>
  enqueueActions(({ context, event, enqueue }) => {
    const left = rows({ context, event }).filter((id) => context.edited.includes(id));
    if (!left.length) {
      if (context.dirty) {
        save(enqueue, context, savedValues(context.drafts));
        enqueue.assign({ dirty: false });
      }
      return;
    }
    save(enqueue, context, savedValues(context.drafts), left);
    enqueue.assign({ dirty: false, edited: context.edited.filter((id) => !left.includes(id)) });
  });
const leaveAll = leaveRows(({ context }) => context.edited);

const timerOf = (id) => `gone:${id}`;

// Leaving the day ends every undo window at once: the values waiting are removed and
// saved, so a removal the user asked for is never left half done.
const finishRemovals = enqueueActions(({ context, enqueue }) => {
  if (!context.removing.length) return;
  for (const id of context.removing) enqueue.cancel(timerOf(id));
  if (writable(context)) {
    const list = context.open ? context.drafts : (context.version?.values ?? []);
    save(enqueue, context, savedValues(list.filter((v) => !context.removing.includes(v.id))));
  }
  enqueue.assign({ removing: [], dirty: false });
});

const opened = ({ context }) => context.open;
const held = (context, id) => context.drafts.some((d) => d.id === id);

const typable = ({ context, event }) =>
  context.open && writable(context) && held(context, event.id) && FIELDS.includes(event.field) && typeof event.value === "string";

// A box holds one line: a line break typed or pasted becomes a space.
const edit = assign(({ context, event }) => ({
  drafts: context.drafts.map((d) => (d.id === event.id ? { ...d, [event.field]: event.value.replace(/\s*\n+\s*/g, " ") } : d)),
  dirty: true,
  edited: context.edited.includes(event.id) ? context.edited : [...context.edited, event.id],
}));

export const machine = setup({
  actors: {
    // The shown day's version and the days the values changed; the day rides along so a
    // reply for a day left meanwhile is dropped.
    load: fromPromise(async ({ input }) => {
      const [read, versions] = await Promise.all([
        input.ask("values", "read", { day: input.day }),
        input.ask("values", "versions", {}),
      ]);
      return { read, versions };
    }),
    // After a change: the days worth listing and whether the shown day's values changed
    // since, for the day asked about.
    recount: fromPromise(async ({ input }) => {
      const [read, versions] = await Promise.all([
        input.ask("values", "read", { day: input.day }),
        input.ask("values", "versions", {}),
      ]);
      return { day: input.day, read, versions };
    }),
    // On a page without a settings fact the ask replies no-answerer and Vim stays off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Another version looked at in place: the current one, or an earlier day's.
    lookup: fromPromise(({ input }) =>
      input
        .ask("values", "read", input.asked ? { day: input.asked } : {})
        .then((reply) => ({ day: input.day, kind: input.kind, reply })),
    ),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "values-sheet",
  meta: {
    description:
      "Shows the client's values on every journal day, under the day's text and above the " +
      "choice points, in a section headed \"Your values\": a folded card that lists the values' " +
      "names on one line; pressing it opens the sheet. Open, each value is a row of its name " +
      "and an optional example of living it, with a New value row after them; with " +
      "no values yet today's page shows a muted Write your values row, and an earlier day " +
      "with none shows nothing. The boxes take Vim's keys when Vim keys is on, where p pastes " +
      "text or a link copied in the reader with Vim keys, its paragraphs joined into the " +
      "box's one line; Enter or Tab " +
      "moves on to the next box. A day shows the values as they stood on that day. They are " +
      "written on today's page only, as the journal page says from day.shown; from midnight " +
      "yesterday's sheet is read only, even in the hour its text stays open. On an earlier " +
      "day the sheet is read only, with Close instead of Done, and says Changed since · see " +
      "today's when the values changed after that day, which shows the current values in " +
      "place, read only, with Back. Done, or Escape, folds the sheet; with Vim keys on, the " +
      "first Escape in a box leaves insert mode. Removing a value strikes it through with " +
      "Undo and a draining bar for the undo window; once it ends the value is gone from " +
      "today's version, and earlier days keep theirs. The window goes on while the sheet is " +
      "folded, and moving to another day ends it at once. A row whose name and sentence are " +
      "both empty is not saved. The footer says Changed today when today's version was " +
      "written today, or when the shown version was written, and Earlier versions with how " +
      "many there are, which lists their days; picking one shows that version, read only. " +
      "Which days are listed, and whether Changed since is offered, is the values fact's to " +
      "say, and is asked again after every change. " +
      "What is written is saved a short time into typing and at once when a box loses focus " +
      "or the sheet folds; a save made as the user leaves a row they typed in (Enter or Tab " +
      "on to the next row, the box losing focus, or Done) names that row as finished, so its " +
      "lines are checked then and not while they are typed. When the page hands it the keyboard, it lands on the folded card " +
      "or the Write your values row, or, open, on the first box, or on a button when the " +
      "sheet is only read.",
    kind: "view",
    emits: ["values.saved"],
    asks: ["values: read", "values: versions", "settings: read"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Puts text copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    mint: input.mint,
    now: input.now,
    throttleMs: input.throttleMs ?? 400,
    undoMs: input.undoMs ?? 3000,
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
    // The shown day's version as the fact last said it: { day, values, changedSince },
    // null until the reply lands.
    version: null,
    // The days a version was written, oldest first.
    days: [],
    // Changes that arrived before the starting picture, applied after it.
    early: [],
    open: false,
    drafts: [],
    dirty: false,
    // The ids of the rows typed in since the user last left them (values.saved's finished).
    edited: [],
    // The ids of the values waiting out their undo window.
    removing: [],
    // The list of earlier versions is shown, or another version is looked at:
    // { kind: "current" | "earlier", day, values }.
    browsing: false,
    viewing: null,
    vimKeys: false,
  }),
  // Beside the states, so the preference arrives whatever the sheet is doing; a
  // settings.changed that races it is held until the reply lands (4.2).
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    onError: { actions: [] },
  },
  initial: "loading",
  on: {
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, as copied; the box makes it one line (edit).
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // Moving to another day settles the sheet and asks for the new day's version. The
    // same day saying it can no longer be written saves what was typed while it could.
    "day.shown": [
      {
        guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
        target: ".loading",
        actions: [
          leaveAll,
          finishRemovals,
          stopChild("lookup"),
          stopChild("recount"),
          assign(({ event }) => ({
            day: event.day,
            dayWritable: typeof event.writable === "boolean" ? event.writable : null,
            version: null,
            early: [],
            open: false,
            drafts: [],
            dirty: false,
            edited: [],
            browsing: false,
            viewing: null,
          })),
        ],
      },
      {
        guard: ({ event }) => isDay(event.day),
        actions: [saveWaiting, assign({ dayWritable: ({ event }) => (typeof event.writable === "boolean" ? event.writable : null) })],
      },
    ],
    "xstate.done.actor.recount": {
      guard: ({ context, event }) => event.output?.day === context.day && context.version != null,
      actions: assign(({ context, event }) => {
        const { read, versions } = event.output;
        return {
          days: Array.isArray(versions?.days) ? [...versions.days].sort() : context.days,
          version: typeof read?.changedSince === "boolean" ? { ...context.version, changedSince: read.changedSince } : context.version,
        };
      }),
    },
    "xstate.done.actor.lookup": {
      guard: ({ context, event }) => event.output?.day === context.day && Array.isArray(event.output.reply?.values),
      actions: assign({
        viewing: ({ event }) => ({ kind: event.output.kind, day: event.output.reply.day, values: copy(event.output.reply.values) }),
        browsing: false,
      }),
    },
  },
  states: {
    // A change the fact makes meanwhile is held for these asks and arrives once their
    // replies have landed (4.2); one let through between the two replies waits in `early`.
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, day: context.day }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.read?.values),
            target: "ready",
            actions: [
              assign(({ event }) => {
                const { read, versions } = event.output;
                return {
                  version: { day: read.day, values: copy(read.values), changedSince: read.changedSince === true },
                  days: Array.isArray(versions?.days) ? [...versions.days].sort() : [],
                };
              }),
              enqueueActions(({ context, enqueue }) => {
                for (const e of context.early) enqueue.raise(e);
                enqueue.assign({ early: [] });
              }),
            ],
          },
          // The fact could not answer: an honest failure rather than no values.
          { target: "failed" },
        ],
        onError: "failed",
      },
      on: {
        "values.changed": { actions: assign({ early: ({ context, event }) => [...context.early, event] }) },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "values.changed": { actions: follow },
        // Opening shows the shown day's version; today with none yet opens on one empty row.
        _open: {
          guard: ({ context }) => !context.open,
          actions: assign(({ context }) => {
            const values = copy(context.version?.values ?? []);
            return { open: true, drafts: values.length || !writable(context) ? values : [blank(context.mint())], browsing: false, viewing: null };
          }),
        },
        _add: {
          guard: ({ context }) => context.open && writable(context),
          actions: assign(({ context }) => ({ drafts: [...context.drafts, blank(context.mint())] })),
        },
        // A box lost focus: its row is left unless the keyboard went to the other box of
        // the same row (`to` names the row it went to, null for anywhere else).
        _blur: { guard: opened, actions: leaveRows(({ event }) => (event.id && event.to !== event.id ? [event.id] : [])) },
        // Done folds the sheet, saving what was typed; a value waiting out its undo window
        // keeps waiting, so Undo is still there when the sheet opens again.
        _done: {
          guard: opened,
          actions: [
            leaveAll,
            assign({ open: false, drafts: [], edited: [], browsing: false, viewing: null }),
            stopChild("lookup"),
          ],
        },
        // An empty row holds nothing to lose, so it goes at once; a value waits out the
        // undo window.
        _remove: {
          guard: ({ context, event }) => context.open && writable(context) && held(context, event.id) && !context.removing.includes(event.id),
          actions: enqueueActions(({ context, event, enqueue }) => {
            const draft = context.drafts.find((d) => d.id === event.id);
            if (isEmpty(draft)) {
              enqueue.assign({ drafts: context.drafts.filter((d) => d.id !== event.id) });
              return;
            }
            enqueue.assign({ removing: [...context.removing, event.id] });
            enqueue.raise({ type: "_gone", id: event.id }, { delay: context.undoMs, id: timerOf(event.id) });
          }),
        },
        _undo: {
          guard: ({ context, event }) => context.removing.includes(event.id),
          actions: enqueueActions(({ context, event, enqueue }) => {
            enqueue.cancel(timerOf(event.id));
            enqueue.assign({ removing: context.removing.filter((id) => id !== event.id) });
          }),
        },
        // The undo window ran out: the value goes from today's version, folded or not.
        _gone: {
          guard: ({ context, event }) => context.removing.includes(event.id),
          actions: enqueueActions(({ context, event, enqueue }) => {
            const removing = context.removing.filter((id) => id !== event.id);
            const drafts = context.drafts.filter((d) => d.id !== event.id);
            const values = (context.open ? drafts : (context.version?.values ?? [])).filter((v) => v.id !== event.id);
            enqueue.assign({ removing, drafts, dirty: false });
            if (context.version) enqueue.assign({ version: { ...context.version, values: savedValues(values) } });
            save(enqueue, context, savedValues(values));
          }),
        },
        _browse: { guard: opened, actions: assign({ browsing: true, viewing: null }) },
        _see: {
          guard: opened,
          actions: [
            stopChild("lookup"),
            spawnChild("lookup", {
              id: "lookup",
              input: ({ context, event }) => ({
                ask: context.ask,
                day: context.day,
                kind: isDay(event.day) ? "earlier" : "current",
                asked: isDay(event.day) ? event.day : null,
              }),
            }),
          ],
        },
        _back: { actions: [stopChild("lookup"), assign({ browsing: false, viewing: null })] },
      },
      states: {
        idle: {
          on: { _edit: { guard: typable, target: "typing", actions: edit } },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        typing: {
          on: { _edit: { guard: typable, actions: edit } },
          after: { throttle: { target: "idle", actions: saveWaiting } },
        },
      },
    },
    failed: {},
  },
});
