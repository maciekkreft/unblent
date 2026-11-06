import { setup, assign, enqueueActions, fromPromise, spawnChild, stopChild } from "xstate";

// The view component behind the + Add sheet row (6.4). It owns only UI state: whether the list
// is open and which entry the keys are on. What it lists follows from facts it asks and follows
// (4.3, fourth rule): `flags` for the features shown, `values` for whether the shown day shows
// Your values, `wheels` for the day's wheels, and journal-entry's day.shown for the day. The
// asks, the send and the clock arrive through input, so the machine is importable in Node.

// The fixed list, here so the journal knows no kind of sheet. Your values shares the feature of
// choice points, because a feature of its own would hide it from people until it is released.
export const SHEETS = [
  {
    id: "values",
    target: "values-sheet",
    feature: "choice-points",
    name: "Your values",
    category: "ACT",
    what: "Write down what matters to you, and how you live it.",
  },
  {
    id: "choice-point",
    target: "choice-point-cards",
    feature: "choice-points",
    name: "Choice point",
    category: "ACT",
    what: "Look at one hard moment: moving away from what matters, or towards it.",
  },
  {
    id: "wheel",
    target: "wheel-sheet",
    feature: "wheel-of-life",
    name: "Wheel of Life",
    category: "Coaching",
    what: "Rate eight areas of your life, and see where the gap is biggest between what you have and what you want.",
  },
];

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the journal page
// first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

// A sheet is added exactly while the day's own text is written: the journal page says so in
// day.shown, until 2:00 the next night (13, Journal). Before it has said, only today's date.
export const writable = (context) => context.dayWritable ?? context.day === dateOf(context.now());

// Until its fact has said, a sheet that a day holds only once is not offered: one offered and
// then taken away would move what the user is about to press.
const offered = {
  values: (context) => context.placed === false,
  "choice-point": () => true,
  wheel: (context) => context.wheels !== null && !context.wheels.some((w) => w.day === context.day),
};

// What the list holds now; an empty list means no row.
export function listed(context) {
  if (!writable(context) || context.hidden === null) return [];
  return SHEETS.filter((s) => !context.hidden.includes(s.feature) && offered[s.id](context));
}

export const listOpen = (context) => context.open && listed(context).length > 0;

// The entry the keys are on, also when the list just got shorter.
export const cursorOf = (context) => Math.min(context.cursor, Math.max(0, listed(context).length - 1));

// The hidden features from a `flags: read` reply; a page without `flags` (the reply is an error)
// hides nothing, as journal-entry reads it for its nested views.
const hiddenOf = (reply) => (Array.isArray(reply?.hidden) ? reply.hidden : []);

const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

// The list's keys (12, "Vim keys"): the arrows always, and with Vim keys on j, k, gg and G.
// `afterG` is whether a g was pressed just before; "g" alone waits for its second press. Enter
// needs nothing here: an entry is a button.
export function listKey(e, vimKeys, afterG = false) {
  if (!plain(e)) return null;
  const arrow = { ArrowDown: { move: "down" }, ArrowUp: { move: "up" } }[e.key];
  if (arrow || !vimKeys) return arrow ?? null;
  if (e.key === "g") return afterG ? { move: "first" } : { wait: true };
  return { j: { move: "down" }, k: { move: "up" }, G: { move: "last" } }[e.key] ?? null;
}

// The entry a move lands on. A move past either end stays in the list: it holds the keyboard
// until Escape, a pick or a second press.
export function listTarget(move, at, count) {
  const to = { down: at + 1, up: at - 1, first: 0, last: count - 1 }[move];
  return Math.max(0, Math.min(count - 1, to));
}

const askPlaced = spawnChild("placed", { id: "placed", input: ({ context }) => ({ ask: context.ask, day: context.day }) });

export const machine = setup({
  actors: {
    // On a page without a settings fact the ask replies no-answerer and Vim stays off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    flags: fromPromise(({ input }) => input.ask("flags", "read", {})),
    wheels: fromPromise(({ input }) => input.ask("wheels", "list", {})),
    // The day rides along so a reply for a day left meanwhile is dropped.
    placed: fromPromise(({ input }) => input.ask("values", "read", { day: input.day }).then((reply) => ({ day: input.day, reply }))),
  },
}).createMachine({
  id: "sheet-picker",
  meta: {
    description:
      "The last row of today's journal page, + Add sheet, which opens a list of the sheets in " +
      "place, each with its name, one line of description and a category label. It keeps that " +
      "fixed list itself, so the journal knows no kind of sheet: Your values (ACT), Choice point " +
      "(ACT) and Wheel of Life (Coaching). Your values and Wheel of Life leave the list while " +
      "they are on the day; Choice point stays, because a day can hold several. A sheet whose " +
      "feature is hidden is not listed, and with nothing to list the row is hidden and takes no " +
      "room. An earlier day, or a day that can no longer be written, has no row. Pressing the row " +
      "opens the list with the keyboard on its first entry; the list closes with Escape or a " +
      "second press, and the keyboard goes back on the row, and it closes when Tab or a press takes " +
      "the keyboard elsewhere. The arrow keys, and with Vim keys on " +
      "j, k, gg and G, move in the list and stop at its ends; Enter or a press picks an entry, " +
      "which closes the list, adds the sheet and gives it the keyboard. With the list closed, j " +
      "and k are left to the journal page, which hands the keyboard to the row from what stands " +
      "above it and moves it back up from the row. A sheet that went while it held the keyboard " +
      "after a key, such as a choice point deleted or a wheel left untouched, puts the keyboard " +
      "on this row; on a day without the row it goes to the day's text.",
    kind: "view",
    emits: [],
    asks: ["values: read", "wheels: list", "flags: read", "settings: read"],
    sends: ["values-sheet: add", "choice-point-cards: add", "wheel-sheet: add"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    send: input.send,
    now: input.now,
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
    // The features hidden, whether the shown day shows Your values, and every wheel as
    // { id, day }: each null until its fact has answered.
    hidden: null,
    placed: null,
    wheels: null,
    vimKeys: false,
    open: false,
    cursor: 0,
    // Counts each focus command, so the view knows to give the row the keyboard: a command has
    // no reply, and the row may only be drawn a moment later.
    landing: 0,
  }),
  // A change a fact makes meanwhile is held for its ask until the reply lands (4.2).
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "flags",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ hidden: ({ event }) => hiddenOf(event.output) }) },
      onError: { actions: assign({ hidden: [] }) },
    },
    {
      src: "wheels",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ event }) => Array.isArray(event.output?.wheels),
        actions: assign({ wheels: ({ event }) => event.output.wheels.map(({ id, day }) => ({ id, day })) }),
      },
      onError: { actions: [] },
    },
  ],
  entry: askPlaced,
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    "xstate.done.actor.placed": {
      guard: ({ context, event }) => event.output?.day === context.day && typeof event.output.reply?.placed === "boolean",
      actions: assign({ placed: ({ event }) => event.output.reply.placed }),
    },
    "values.changed": {
      guard: ({ context, event }) => event.day === context.day && typeof event.placed === "boolean",
      actions: assign({ placed: ({ event }) => event.placed }),
    },
    // Undo brings a deleted wheel back under its own id, so this also lists it as on the day.
    "wheel.changed": {
      guard: ({ context }) => context.wheels !== null,
      actions: assign({ wheels: ({ context, event }) => [...context.wheels.filter((w) => w.id !== event.wheel.id), { id: event.wheel.id, day: event.wheel.day }] }),
    },
    "wheel.deleted": {
      guard: ({ context }) => context.wheels !== null,
      actions: assign({ wheels: ({ context, event }) => context.wheels.filter((w) => w.id !== event.id) }),
    },
    "day.shown": [
      {
        guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
        actions: [
          stopChild("placed"),
          assign({
            day: ({ event }) => event.day,
            dayWritable: ({ event }) => (typeof event.writable === "boolean" ? event.writable : null),
            placed: null,
            open: false,
            cursor: 0,
          }),
          askPlaced,
        ],
      },
      {
        guard: ({ event }) => isDay(event.day),
        actions: assign(({ context, event }) => {
          const dayWritable = typeof event.writable === "boolean" ? event.writable : null;
          return { dayWritable, open: context.open && dayWritable !== false };
        }),
      },
    ],
    focus: { actions: assign({ landing: ({ context }) => context.landing + 1 }) },
    _toggle: {
      guard: ({ context }) => listed(context).length > 0,
      actions: assign({ open: ({ context }) => !context.open, cursor: 0 }),
    },
    _close: { actions: assign({ open: false }) },
    _cursor: {
      guard: ({ event }) => Number.isInteger(event.to) && event.to >= 0,
      actions: assign({ cursor: ({ event }) => event.to }),
    },
    // One view instructing another (4.3): a command, and the sheet then takes the keyboard.
    _pick: {
      guard: ({ context, event }) => listed(context).some((s) => s.id === event.id),
      actions: enqueueActions(({ context, event, enqueue }) => {
        const { target } = SHEETS.find((s) => s.id === event.id);
        enqueue(() => context.send(target, "add", {}));
        enqueue.assign({ open: false, cursor: 0 });
      }),
    },
  },
});
