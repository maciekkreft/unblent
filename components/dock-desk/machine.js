import { setup, assign, emit, fromPromise } from "xstate";

// A container view component (3.1) that owns only UI state: how its children are
// arranged between four tab groups of one kind, the stage and the docks on the
// left, right and bottom edges. Every child is a tab in exactly one group; an
// edge group shows one tab at a time and can fold to its strip. The layout is a
// fact owned by `dock`, reached by one query for the starting picture and the
// dock.changed event for everything after (4.3, fourth rule). The children are
// views placed on the desk by the page; their names and labels arrive through
// `input`, read from the DOM by the view, so the machine stays importable in Node.

const SIDES = ["left", "right", "bottom"];

const names = (views) => views.map((v) => v.name);

// Every view docked anywhere, across the sides.
const dockedNames = (docks) => SIDES.flatMap((s) => docks[s]?.views ?? []);

// The side a view is docked on, or undefined.
const sideOf = (docks, name) => SIDES.find((s) => docks[s]?.views.includes(name));

// The first view docked nowhere, to land the stage on.
const firstFree = (views, docks) => {
  const docked = dockedNames(docks);
  return names(views).find((n) => !docked.includes(n)) ?? null;
};

// One side in contract shape (7.2): `active` only when it names one of the side's
// own views; absent means the first.
const side = (open, views, active) => (views.includes(active) ? { open, views, active } : { open, views });

// Land a view on a side: the side opens and shows it, so the user sees what they
// just moved (feedback) rather than a strip with the newcomer hidden behind it.
const addTo = (docks, target, name) => ({
  ...docks,
  [target]: side(true, [...(docks[target]?.views ?? []), name], name),
});

// Remove a view from wherever it is docked; a side left empty is dropped (absent =
// empty), and a side whose shown tab left shows its first remaining one.
const removeFrom = (docks, name) => {
  const next = {};
  for (const s of SIDES) {
    const dock = docks[s];
    if (!dock) continue;
    const views = dock.views.filter((n) => n !== name);
    if (views.length) next[s] = side(dock.open, views, dock.active === name ? views[0] : dock.active);
  }
  return next;
};

// Set one side's open flag; a side with nothing docked cannot open.
const setOpen = (docks, s, open) => (docks[s] ? { ...docks, [s]: { ...docks[s], open } } : docks);

const arranged = (stage, docks) => ({ type: "dock.arranged", stage, docks });

// Fit a stored layout to the children actually on the desk: within each side drop
// docked names the page no longer holds, remove a now-empty side, and let a stale
// `active` fall back to the first; land the stage on a real, undocked view (the
// stored one if it still qualifies, else the first candidate).
const reconcile = (layout, views) => {
  const known = names(views);
  const docks = {};
  for (const s of SIDES) {
    const dock = layout.docks?.[s];
    if (!dock) continue;
    const kept = dock.views.filter((n) => known.includes(n));
    if (kept.length) docks[s] = side(dock.open, kept, dock.active);
  }
  const candidates = known.filter((n) => !dockedNames(docks).includes(n));
  const stage = candidates.includes(layout.stage) ? layout.stage : candidates[0] ?? null;
  return { stage, docks };
};

const isStageTab = ({ context, event }) =>
  names(context.views).includes(event.name) && !dockedNames(context.docks).includes(event.name);
const isDocked = ({ context, event }) => dockedNames(context.docks).includes(event.name);

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("dock", "read", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "dock-desk",
  meta: { kind: "view", emits: ["dock.arranged"], attributes: [], asks: ["dock: read", "settings: read"] },
  // dock-desk keys children by name here and in the view; when two views share a
  // name (note-editor#1/#2, the notes-on-desk task) this is the edge to revisit.
  context: ({ input }) => ({ ask: input.ask, views: input.views, stage: null, docks: {}, locked: false }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          {
            target: "loadingSettings",
            actions: assign(({ context, event }) => reconcile(event.output, context.views)),
          },
        ],
        onError: { target: "failed" },
      },
    },
    // Whether the desk is locked belongs to `settings`; a page without it (the ask
    // replies no-answerer) keeps the desk unlocked, exactly as before settings
    // existed.
    loadingSettings: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "ready" },
          { target: "ready", actions: assign({ locked: ({ event }) => event.output.layoutLocked }) },
        ],
        onError: { target: "ready" },
      },
    },
    // The dock fact answered: every gesture emits the whole layout and the desk
    // adopts it back through dock.changed. Nothing is assigned locally here.
    ready: {
      on: {
        // Leading underscore (7.2): user gestures forwarded by the view, never
        // routed by the bus. Each computes the next layout from context and emits
        // dock.arranged; `dock` decides and announces it.
        _open: {
          guard: isStageTab,
          actions: emit(({ context, event }) => arranged(event.name, context.docks)),
        },
        // From the stage to an edge: the stage moves on to the first free view,
        // which may be none. Arranging is barred while the desk is locked (7.5's
        // settings): the decision lives in the actor, so a stray gesture does nothing.
        _dock: {
          guard: ({ context, event }) => !context.locked && isStageTab({ context, event }) && SIDES.includes(event.side),
          actions: emit(({ context, event }) => {
            const docks = addTo(context.docks, event.side, event.name);
            const stage = context.stage === event.name ? firstFree(context.views, docks) : context.stage;
            return arranged(stage, docks);
          }),
        },
        // Back to the stage, and shown there: the returned view is what the user
        // asked to see.
        _undock: {
          guard: ({ context, event }) => !context.locked && isDocked({ context, event }),
          actions: emit(({ context, event }) => arranged(event.name, removeFrom(context.docks, event.name))),
        },
        _move: {
          guard: ({ context, event }) =>
            !context.locked && isDocked({ context, event }) && SIDES.includes(event.side) && sideOf(context.docks, event.name) !== event.side,
          actions: emit(({ context, event }) =>
            arranged(context.stage, addTo(removeFrom(context.docks, event.name), event.side, event.name)),
          ),
        },
        // Show a tab on its side; a folded side unfolds, so a rail label is one
        // step from the view it names.
        _activate: {
          guard: ({ context, event }) => Boolean(context.docks[event.side]?.views.includes(event.name)),
          actions: emit(({ context, event }) =>
            arranged(context.stage, {
              ...context.docks,
              [event.side]: { ...context.docks[event.side], open: true, active: event.name },
            }),
          ),
        },
        _fold: {
          guard: ({ context, event }) => !context.locked && Boolean(context.docks[event.side]),
          actions: emit(({ context, event }) => arranged(context.stage, setOpen(context.docks, event.side, false))),
        },
        _unfold: {
          guard: ({ context, event }) => !context.locked && Boolean(context.docks[event.side]),
          actions: emit(({ context, event }) => arranged(context.stage, setOpen(context.docks, event.side, true))),
        },
      },
    },
    // No dock fact on the page: the desk still works as a plain tab switcher, so
    // _open assigns locally. Docking gestures are not offered by the view.
    failed: {
      on: {
        _open: {
          guard: isStageTab,
          actions: assign({ stage: ({ event }) => event.name }),
        },
      },
    },
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt it whoever caused the change. The
    // only place the layout is assigned once ready.
    "dock.changed": {
      actions: assign(({ context, event }) => reconcile(event, context.views)),
    },
    // The lock is a settings fact: adopt it, so a stray gesture past a hidden
    // control still does nothing (the guards read context.locked).
    "settings.changed": {
      actions: assign({ locked: ({ event }) => event.layoutLocked }),
    },
  },
});
