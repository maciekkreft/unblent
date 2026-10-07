import { setup, assign, emit } from "xstate";

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

export const machine = setup({}).createMachine({
  id: "dock",
  meta: {
    description:
      "Owns the desk layout: which view is on the stage, and for each side (left, right, " +
      "bottom) which views are docked there, which one is shown, and whether the side is open. " +
      "It keeps the layout on this device, in localStorage. A view is docked in at most one " +
      "place.",
    kind: "fact",
    shape: "local-only",
    emits: ["dock.changed"],
    owns: "the desk layout: which view is on the stage, and for each side what is docked, which tab it shows and whether it is open",
  },
  context: ({ input }) => ({ layout: parse(input.stored), save: input.save }),
  on: {
    // The gesture from dock-desk, consumed as an event (4.3). The view emits the
    // whole layout; the fact never merges. Guarded so a repeat writes, saves and
    // announces nothing.
    "dock.arranged": {
      guard: ({ context, event }) => !same(clean(event), context.layout),
      actions: [
        assign({ layout: ({ event }) => clean(event) }),
        ({ context }) => context.save(JSON.stringify(context.layout)),
        emit(({ context }) => ({ type: "dock.changed", ...context.layout })),
      ],
    },
    "read?": {
      actions: ({ context, event }) => event.reply({ ...context.layout }),
    },
  },
});
