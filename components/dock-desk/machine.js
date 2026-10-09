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
// does; a stage tab staged. On a narrow desk an open left or right side is a drawer
// over the stage, so staging a view folds the drawers this gesture did not open: a
// case picked in the Cases drawer shows the case.
const shown = (context, type) => {
  let { stage, docks } = context;
  let staged = false;
  const opened = new Set();
  for (const v of context.views) {
    if (v.showsOn !== type) continue;
    const s = sideOf(docks, v.name);
    if (s) {
      docks = { ...docks, [s]: { ...docks[s], open: true, active: v.name } };
      opened.add(s);
    } else {
      stage = v.name;
      staged = true;
    }
  }
  if (staged && context.narrow())
    for (const s of ["left", "right"])
      if (docks[s]?.open && !opened.has(s)) docks = { ...docks, [s]: { ...docks[s], open: false } };
  return { stage, docks };
};

// Already in view: nothing to announce, so `dock` stores nothing.
const showsMore = ({ context, event }) => {
  const next = shown(context, event.type);
  if (next.stage !== context.stage) return true;
  return SIDES.some((s) => {
    const was = context.docks[s];
    const now = next.docks[s];
    return now && (was.open !== now.open || (now.open && (was.active ?? was.views[0]) !== (now.active ?? now.views[0])));
  });
};

// A selection gesture a child follows with `shows-on` (6.4). Showing a tab is daily
// use, like _activate, so it is not gated on arranging.
// Leaving the header-button detour (6.4): a selection gesture is choosing something
// else, so it returns to the stage — the pressed button clears whether or not the
// gesture changes the layout.
const clearPressed = assign({ pressed: null });

const show = [
  {
    guard: showsMore,
    actions: [
      emit(({ context, event }) => {
        const next = shown(context, event.type);
        return arranged(next.stage, next.docks);
      }),
      clearPressed,
    ],
  },
  { actions: clearPressed },
];

// Where Ctrl+h/j/k/l moves focus (12, "Vim keys"): the left dock, the stage and the
// right dock sit in one row, the bottom dock spans under all three. `present` names
// the groups that hold a view now; a missing or empty one is passed over, and null
// means there is nowhere to go, so the key does nothing.
const ROW = ["left", "stage", "right"];
export const nextGroup = (from, key, present) => {
  if (key === "j") return from !== "bottom" && present.includes("bottom") ? "bottom" : null;
  if (key === "k") return from === "bottom" && present.includes("stage") ? "stage" : null;
  const step = { h: -1, l: 1 }[key];
  if (!step) return null;
  for (let at = ROW.indexOf(from === "bottom" ? "stage" : from) + step; at >= 0 && at < ROW.length; at += step)
    if (present.includes(ROW[at])) return ROW[at];
  return null;
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
    // loading. subject.changed is held for this ask until its reply lands (subject:
    // read supersededBy).
    readSubject: fromPromise(({ input }) => input.ask("subject", "read", {})),
  },
}).createMachine({
  id: "dock-desk",
  meta: {
    description:
      "Arranges the page's views as tabs on a stage and on docks at the left, right and bottom " +
      "edges; the user moves tabs between them and folds a side to its strip, and `dock` stores " +
      "the layout. A page may give a child `side=\"left|right|bottom\"` for where it starts while " +
      "no layout is stored (left and right start folded where the desk is too narrow); " +
      "`control` to place it at the end of the stage header with no tab; `button=\"gear\"` to " +
      "show it from a button in the stage header that takes the stage while pressed, until it " +
      "is pressed again, a stage tab is chosen, Escape is pressed or a selection gesture " +
      "arrives, and is never saved (the desk owns the glyphs it can draw, so the icon stays a " +
      "literal in the view, 11.2); and `shows-on` naming a selection gesture (`book.selected`, " +
      "`note.selected`, `conversation.selected`, `case.selected`, `results.selected`), which " +
      "shows that child's tab when the gesture arrives, the same as a click (on the phone a " +
      "gesture that shows a stage tab also closes the side drawer it came from), while a reload or " +
      "another device's change never moves a tab. These are read from each child and are not attributes of `dock-desk` itself. While " +
      "the desk is being arranged, a dock with more than one tab offers two buttons that move " +
      "the shown tab one place earlier or later; the stage keeps the page's order. The tab of " +
      "the view that shows the subject carries a mark with the subject's title as its hover " +
      "text; the mark is an indicator, not a control, and no mark means there is no subject. " +
      "While the \"Vim keys\" preference is on, on the desk and not on the phone, Ctrl+h and " +
      "Ctrl+l move the keyboard focus between the left dock, the stage and the right dock, " +
      "Ctrl+j to the bottom dock and Ctrl+k back up to the stage, passing over an empty side " +
      "and unfolding a folded one; Ctrl+. and Ctrl+, show the next or previous tab of the group " +
      "that has focus and focus it, and so do gt and gT outside an editor; Ctrl+Shift+h, " +
      "Ctrl+Shift+l and Ctrl+Shift+j fold or unfold the left, right and bottom dock, and so do " +
      "zh, zl and zj outside an editor, the keyboard going to the stage when its side folds. " +
      "A clicked tab puts the keyboard in the view it shows, and a click that leaves the focus " +
      "nowhere (bare space, or a button Safari does not focus) puts it back where it was, so " +
      "the keyboard is always somewhere on the desk. For everyone, Vim keys or not, the stage " +
      "or dock whose view holds the keyboard wears a frame in the focus ring's accent, so a move " +
      "between panels is seen; there is no frame on the phone, where one panel fills the screen.",
    kind: "view",
    emits: ["dock.arranged"],
    attributes: [],
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
    // The "Vim keys" preference (12): while on, the view moves focus between the
    // groups with Ctrl+h/j/k/l and between tabs with Ctrl+. and Ctrl+,.
    vimKeys: false,
    // The subject, learned from subject: read then subject.changed, as
    // { kind, id, title, view } or null. The view marks the tab whose name is `view`.
    subject: null,
    // The address of the child shown from a header button (6.4), or null for the
    // stage. It is a detour the user leaves, so it rides no fact and is never in
    // dock.arranged; a reload starts on the stage.
    pressed: null,
  }),
  // The subject read runs for the machine's whole life (3.5), so the layout-load
  // transitions never cancel it: its reply lands on its own, and no layout reply ever
  // writes the subject, so a slow layout reply cannot re-apply a stale null over a
  // subject.changed that arrived first. A page without `subject` (no-answerer) leaves
  // it null and shows no mark, exactly as a page without `settings` stays arrangeable.
  invoke: {
    src: "readSubject",
    input: ({ context }) => ({ ask: context.ask }),
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
          {
            target: "ready",
            actions: assign({
              arranging: ({ event }) => event.output.arranging,
              vimKeys: ({ event }) => event.output.vimKeys === true,
            }),
          },
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
        // A stage tab click returns to the stage (6.4), so it clears the pressed
        // header button too, whether or not the click named a real stage tab.
        _open: [
          {
            guard: isStageTab,
            actions: [emit(({ context, event }) => arranged(event.name, context.docks)), clearPressed],
          },
          { actions: clearPressed },
        ],
        // A header button (6.4) toggles the child it names onto the stage. Daily use
        // like _activate, not a layout change, so it is not gated on arranging and
        // emits nothing: pressed is the desk's own state, never a stored fact.
        _press: {
          actions: assign({ pressed: ({ context, event }) => (context.pressed === event.name ? null : event.name) }),
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
        "conversation.selected": show,
        "case.selected": show,
        "results.selected": show,
      },
    },
    // No dock fact on the page: the desk still works as a plain tab switcher, so
    // _open assigns locally. Docking gestures are not offered by the view.
    failed: {
      on: {
        // As in ready (6.4): a stage tab click returns to the stage, clearing any
        // pressed header button whether or not it named a real stage tab.
        _open: [
          { guard: isStageTab, actions: assign({ stage: ({ event }) => event.name, pressed: null }) },
          { actions: clearPressed },
        ],
        _press: {
          actions: assign({ pressed: ({ context, event }) => (context.pressed === event.name ? null : event.name) }),
        },
        // A child follows a selection gesture (6.4); with no dock fact the desk is a
        // plain tab switcher, so a followed stage tab is staged locally, and the
        // detour ends.
        "book.selected": { actions: assign({ stage: ({ context, event }) => shown(context, event.type).stage, pressed: null }) },
        "note.selected": { actions: assign({ stage: ({ context, event }) => shown(context, event.type).stage, pressed: null }) },
        "conversation.selected": { actions: assign({ stage: ({ context, event }) => shown(context, event.type).stage, pressed: null }) },
        "case.selected": { actions: assign({ stage: ({ context, event }) => shown(context, event.type).stage, pressed: null }) },
        "results.selected": { actions: assign({ stage: ({ context, event }) => shown(context, event.type).stage, pressed: null }) },
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
      actions: assign({ arranging: ({ event }) => event.arranging, vimKeys: ({ event }) => event.vimKeys === true }),
    },
    // The subject changed (4.3): mark a different tab, or none. Held for us until the
    // starting subject: read reply lands, so it is never lost and never applied before
    // the picture it supersedes.
    "subject.changed": {
      actions: assign({ subject: ({ event }) => event.subject }),
    },
  },
});
