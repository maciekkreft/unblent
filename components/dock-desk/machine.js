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

// Swap a docked view with its neighbour `step` places along its side (6.4); the
// docks come back unchanged when there is no such neighbour. `open` and `active`
// stay, so the moved tab is still the one shown.
const shift = (docks, name, step) => {
  const s = sideOf(docks, name);
  const views = [...(docks[s]?.views ?? [])];
  const from = views.indexOf(name);
  const to = from + step;
  if (from < 0 || to < 0 || to >= views.length) return docks;
  [views[from], views[to]] = [views[to], views[from]];
  return { ...docks, [s]: { ...docks[s], views } };
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

// A desk the user has never arranged: nothing staged, nothing docked.
const isEmpty = (layout) => !layout.stage && SIDES.every((s) => !layout.docks?.[s]);

// The starting picture a page declares (6.4): each view with a valid `side` lands
// there, in child order; the rest stay stage tabs; the stage takes the first
// undocked view. A side is open, except left and right on a desk too narrow to
// hold a dock beside the stage: there an open side is a drawer over the stage and
// its header, so it starts folded. `active` is left absent, so each side shows its
// first tab.
const seed = (views, narrow) => {
  const docks = {};
  for (const v of views)
    if (SIDES.includes(v.side))
      docks[v.side] = side(!(narrow && v.side !== "bottom"), [...(docks[v.side]?.views ?? []), v.name]);
  return { stage: firstFree(views, docks), docks };
};

// Adopt the fact's layout, or the page's declared default when it has none.
const adopt = (layout, views, narrow) => (isEmpty(layout) ? seed(views, narrow) : reconcile(layout, views));

// The layout with every view that declared `shows-on` this event (6.4) brought
// forward where it sits: a docked view shown on its side, unfolded, as _activate
// does; a stage tab staged.
const shown = (context, type) => {
  let { stage, docks } = context;
  for (const v of context.views) {
    if (v.showsOn !== type) continue;
    const s = sideOf(docks, v.name);
    if (s) docks = { ...docks, [s]: { ...docks[s], open: true, active: v.name } };
    else stage = v.name;
  }
  return { stage, docks };
};

// Already in view: nothing to announce, so `dock` stores nothing.
const showsMore = ({ context, event }) => {
  const next = shown(context, event.type);
  if (next.stage !== context.stage) return true;
  return SIDES.some((s) => {
    const was = context.docks[s];
    const now = next.docks[s];
    return now && (!was.open || (was.active ?? was.views[0]) !== now.active);
  });
};

// A selection gesture a child follows with `shows-on` (6.4). Showing a tab is daily
// use, like _activate, so it is not gated on arranging.
const show = {
  guard: showsMore,
  actions: emit(({ context, event }) => {
    const next = shown(context, event.type);
    return arranged(next.stage, next.docks);
  }),
};

const isStageTab = ({ context, event }) =>
  names(context.views).includes(event.name) && !dockedNames(context.docks).includes(event.name);
const isDocked = ({ context, event }) => dockedNames(context.docks).includes(event.name);

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("dock", "read", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // The subject starting picture, asked as its own concern (3.5) so its reply never
    // overwrites a subject.changed that arrived first while the layout was still
    // loading. Off with no `marks-subject` attribute: no ask, no mark. subject.changed
    // is held for this ask until its reply lands (subject: read supersededBy).
    readSubject: fromPromise(({ input }) =>
      input.marking ? input.ask("subject", "read", {}) : Promise.resolve({ subject: null })),
  },
}).createMachine({
  id: "dock-desk",
  meta: {
    kind: "view",
    emits: ["dock.arranged"],
    attributes: ["reorders", "marks-subject"],
    asks: ["dock: read", "settings: read", "subject: read"],
  },
  // dock-desk keys children by name here and in the view; when two views share a
  // name (note-editor#1/#2, the notes-on-desk task) this is the edge to revisit.
  // `narrow` is a function, like `ask`, so the width is read when the seed is
  // chosen (the viewport fact has framed the body by then), not at connect.
  context: ({ input }) => ({
    ask: input.ask,
    views: input.views,
    narrow: input.narrow ?? (() => false),
    stage: null,
    docks: {},
    arranging: true,
    // Whether the page set `marks-subject` (12): mark the tab of the view that shows
    // the subject. Off by default; arrives through input so the machine stays
    // importable in Node.
    marking: Boolean(input.marking),
    // The subject, learned from subject: read then subject.changed, as
    // { kind, id, title, view } or null. The view marks the tab whose name is `view`.
    subject: null,
  }),
  // The subject read runs for the machine's whole life (3.5), so the layout-load
  // transitions never cancel it: its reply lands on its own, and no layout reply ever
  // writes the subject, so a slow layout reply cannot re-apply a stale null over a
  // subject.changed that arrived first. A page without `subject` (no-answerer) leaves
  // it null and shows no mark, exactly as a page without `settings` stays arrangeable.
  invoke: {
    src: "readSubject",
    input: ({ context }) => ({ ask: context.ask, marking: context.marking }),
    onDone: { actions: assign({ subject: ({ event }) => event.output.subject ?? null }) },
    onError: { actions: [] },
  },
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
            actions: assign(({ context, event }) => adopt(event.output, context.views, context.narrow())),
          },
        ],
        onError: { target: "failed" },
      },
    },
    // Whether the desk is being arranged belongs to `settings`; a page without it
    // (the ask replies no-answerer) keeps the desk arrangeable, exactly as before
    // settings existed.
    loadingSettings: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "ready" },
          { target: "ready", actions: assign({ arranging: ({ event }) => event.output.arranging }) },
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
        // which may be none. Only offered while arranging (7.5's settings): the
        // decision lives in the actor, so a stray gesture does nothing.
        _dock: {
          guard: ({ context, event }) => context.arranging && isStageTab({ context, event }) && SIDES.includes(event.side),
          actions: emit(({ context, event }) => {
            const docks = addTo(context.docks, event.side, event.name);
            const stage = context.stage === event.name ? firstFree(context.views, docks) : context.stage;
            return arranged(stage, docks);
          }),
        },
        // Back to the stage, and shown there: the returned view is what the user
        // asked to see.
        _undock: {
          guard: ({ context, event }) => context.arranging && isDocked({ context, event }),
          actions: emit(({ context, event }) => arranged(event.name, removeFrom(context.docks, event.name))),
        },
        _move: {
          guard: ({ context, event }) =>
            context.arranging && isDocked({ context, event }) && SIDES.includes(event.side) && sideOf(context.docks, event.name) !== event.side,
          actions: emit(({ context, event }) =>
            arranged(context.stage, addTo(removeFrom(context.docks, event.name), event.side, event.name)),
          ),
        },
        // One place earlier or later on its own side (6.4). A step off either end
        // leaves the docks as they are, so nothing is announced.
        _shift: {
          guard: ({ context, event }) =>
            context.arranging &&
            [-1, 1].includes(event.step) &&
            shift(context.docks, event.name, event.step) !== context.docks,
          actions: emit(({ context, event }) => arranged(context.stage, shift(context.docks, event.name, event.step))),
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
        // Folding is daily use, not a layout change: it is always allowed, whether
        // or not the desk is being arranged.
        _fold: {
          guard: ({ context, event }) => Boolean(context.docks[event.side]),
          actions: emit(({ context, event }) => arranged(context.stage, setOpen(context.docks, event.side, false))),
        },
        _unfold: {
          guard: ({ context, event }) => Boolean(context.docks[event.side]),
          actions: emit(({ context, event }) => arranged(context.stage, setOpen(context.docks, event.side, true))),
        },
        // A child follows a selection gesture (6.4): bring its tab forward.
        "book.selected": show,
        "note.selected": show,
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
        // A child follows a selection gesture (6.4); with no dock fact the desk is a
        // plain tab switcher, so a followed stage tab is staged locally.
        "book.selected": { actions: assign({ stage: ({ context, event }) => shown(context, event.type).stage }) },
        "note.selected": { actions: assign({ stage: ({ context, event }) => shown(context, event.type).stage }) },
      },
    },
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt it whoever caused the change. The
    // only place the layout is assigned once ready.
    "dock.changed": {
      actions: assign(({ context, event }) => adopt(event, context.views, context.narrow())),
    },
    // Arranging is a settings fact: adopt it, so a stray gesture past a hidden
    // control still does nothing (the guards read context.arranging).
    "settings.changed": {
      actions: assign({ arranging: ({ event }) => event.arranging }),
    },
    // The subject changed (4.3): mark a different tab, or none. Held for us until the
    // starting subject: read reply lands, so it is never lost and never applied before
    // the picture it supersedes.
    "subject.changed": {
      actions: assign({ subject: ({ event }) => event.subject }),
    },
  },
});
