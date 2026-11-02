import { setup, enqueueActions } from "xstate";
import { ulid } from "ulid";

// A local-only fact component (3.1): headless owner of the desk layout — which view
// is on the stage, and for each side (left, right, bottom) what is docked and
// whether that side is open. It stores the layout in localStorage and answers
// dock: read; a view takes its starting picture by query (4.3) and follows
// dock.changed after. The store arrives through `input`, so the machine is a pure
// definition importable in Node.

const SIDES = ["left", "right", "bottom"];

const DEFAULT = { stage: null, docks: {} };

// Sanitise one side into { open: boolean, views: string[] unique, active? } (7.2),
// dropping any view already seen on an earlier side: a view is docked in at most
// one place. `active` is kept only when it names one of the side's own views;
// otherwise it is omitted, and absent means the first.
const cleanSide = (value, seen) => {
  const views = [];
  if (Array.isArray(value?.views)) {
    for (const n of value.views) {
      if (typeof n === "string" && !seen.has(n)) {
        seen.add(n);
        views.push(n);
      }
    }
  }
  const side = { open: value?.open === true, views };
  if (views.includes(value?.active)) side.active = value.active;
  return side;
};

// Sanitise any candidate layout into the contract shape: stage a string or null;
// docks only the known sides, each a clean side, an empty side dropped (absent =
// nothing docked, closed). Anything malformed collapses to the default.
const clean = (value) => {
  if (!value || typeof value !== "object") return { stage: null, docks: {} };
  const seen = new Set();
  const docks = {};
  const from = value.docks && typeof value.docks === "object" ? value.docks : {};
  for (const side of SIDES) {
    if (!(side in from)) continue;
    const cleaned = cleanSide(from[side], seen);
    if (cleaned.views.length) docks[side] = cleaned;
  }
  const stage = typeof value.stage === "string" ? value.stage : null;
  return { stage, docks };
};

const parse = (stored) => {
  try {
    return clean(JSON.parse(stored));
  } catch {
    return { ...DEFAULT, docks: {} };
  }
};

const sameSide = (a, b) => {
  if (!a || !b) return !a === !b;
  return (
    a.open === b.open &&
    a.active === b.active &&
    a.views.length === b.views.length &&
    a.views.every((n, i) => n === b.views[i])
  );
};

const same = (a, b) => a.stage === b.stage && SIDES.every((s) => sameSide(a.docks[s], b.docks[s]));

// --- Steps (12, Undo) -------------------------------------------------------------------

// Which views sit on which side, in order: what arranging the desk changes. The stage, the
// tab a side shows and whether it is folded are moving around, so they make no step.
// Only the views both layouts name count: one named in only one of them is a view the page
// gained or lost since the layout was stored, which dock-desk fits in or leaves out by
// itself, so the first tab click after it is no arrangement the user made. Every gesture
// that arranges the desk moves a view both name (dock-desk docks the view on the stage).
const named = (layout) => new Set([layout.stage, ...SIDES.flatMap((s) => layout.docks[s]?.views ?? [])].filter(Boolean));
const placement = (layout, common) => JSON.stringify(SIDES.map((s) => (layout.docks[s]?.views ?? []).filter((n) => common.has(n))));
const rearranged = (before, after) => {
  const was = named(before);
  const common = new Set([...named(after)].filter((n) => was.has(n)));
  return placement(before, common) !== placement(after, common);
};

// `prior` is the step that wrote the layout before this one, so an Undo leaves it as that
// step left it and the step before can be undone next; a layout no step of this browser
// wrote is left stamped with a mark of the step undone.
const priorOf = (step) => (typeof step === "string" ? { prior: step } : {});
const priorStamp = (p, step) => p.prior ?? `^${step}`;

// The layout and the step that last arranged it, as this browser holds them now: read
// again from storage when it can be, so a step another tab took is seen.
function held(context) {
  const stored = context.load?.();
  if (typeof stored !== "string") return { layout: context.layout, stamp: context.stamp };
  return { layout: parse(stored), stamp: context.stampLoad?.() ?? undefined };
}

function write(context, enqueue, layout, stamp) {
  context.layout = layout;
  context.stamp = stamp;
  enqueue.assign({ layout, stamp });
  enqueue(() => context.save(JSON.stringify(layout)));
  enqueue(() => context.stampSave?.(stamp));
  enqueue.emit({ type: "dock.changed", ...layout });
}

// The whole layout from dock-desk (4.3), never merged. A change of where the views sit is
// one step; any other change keeps the stamp of the step that arranged it.
function applyArranged(context, event, enqueue) {
  const after = clean(event);
  const before = context.layout;
  if (same(after, before)) return;
  if (!rearranged(before, after)) return write(context, enqueue, after, context.stamp);
  const prior = held(context).stamp;
  const id = context.mint();
  write(context, enqueue, after, id);
  enqueue.emit({
    type: "step.recorded",
    id,
    owner: "dock",
    label: "arrange the desk",
    undo: { kind: "layout", layout: before, ...priorOf(prior) },
    redo: { kind: "layout", layout: after, ...priorOf(prior) },
  });
}

// An Undo or Redo, applied only while the desk was last arranged in this browser by that
// step; an arrangement written since, here or in another tab, refuses it.
function applyStep(context, event, enqueue) {
  if (event.owner !== "dock") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "dock", outcome, ...(reason ? { reason } : {}) });
  const p = event.payload ?? {};
  if (p.kind !== "layout" || !p.layout) return settle("refused", "changed");
  const undoing = event.type === "step.undone";
  const { stamp } = held(context);
  if (stamp !== (undoing ? event.id : priorStamp(p, event.id))) return settle("refused", "changed");
  write(context, enqueue, clean(p.layout), undoing ? priorStamp(p, event.id) : event.id);
  settle("applied");
}

export const machine = setup({}).createMachine({
  id: "dock",
  meta: {
    description:
      "Owns the desk layout: which view is on the stage, and for each side (left, right, " +
      "bottom) which views are docked there, which one is shown, and whether the side is open. " +
      "It keeps the layout on this device, in localStorage. A view is docked in at most one " +
      "place. Moving a view to another side, back to the stage or along its side is a step " +
      "Undo and Redo reverse (section 12), which puts the whole layout back; picking a tab, " +
      "folding or unfolding a side and following a selection are not, and neither is a view " +
      "the page gained or lost since the layout was stored. A step is refused when " +
      "the desk was arranged since by anything else, here or in another tab.",
    kind: "fact",
    shape: "local-only",
    emits: ["dock.changed", "step.recorded", "step.settled"],
    owns: "the desk layout: which view is on the stage, and for each side what is docked, which tab it shows and whether it is open",
    steps: { "dock.arranged": "step" },
  },
  context: ({ input }) => ({
    layout: parse(input.stored),
    save: input.save,
    // The step that last arranged the desk in this browser (12, Undo), kept beside it.
    stamp: input.stamp ?? undefined,
    load: input.load,
    stampLoad: input.stampLoad,
    stampSave: input.stampSave,
    mint: input.mint ?? ulid,
  }),
  on: {
    // The gesture from dock-desk, consumed as an event (4.3). The view emits the
    // whole layout; the fact never merges. Guarded so a repeat writes, saves and
    // announces nothing.
    "dock.arranged": { actions: enqueueActions(({ context, event, enqueue }) => applyArranged(context, event, enqueue)) },
    "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
    "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
    "read?": {
      actions: ({ context, event }) => event.reply({ ...context.layout }),
    },
  },
});
