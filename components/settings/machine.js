import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the user's page
// preferences — the order and visibility of pages in the navigation, whether the
// viewport switch and the layout switch are shown, and whether the desk layout is
// being arranged. It keeps them in one global localStorage key and answers
// settings: read; a view takes its starting picture by query (4.3) and follows
// settings.changed after. The store arrives through `input`, so the machine is a
// pure definition importable in Node.

const DEFAULT = { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true };

// Sanitise any candidate into the contract shape (7.2): nav a list of
// { path: string, hidden: boolean } deduped by path (a page is listed once);
// booleans coerced with === true. Then the invariant: a hidden switch means the
// desk is not arrangeable, so hiding the switch turns arranging off; arranging is
// on by default and unknown/old fields fall to that.
const clean = (value) => {
  const v = value && typeof value === "object" ? value : {};
  const nav = [];
  const seen = new Set();
  if (Array.isArray(v.nav)) {
    for (const row of v.nav) {
      const path = row?.path;
      if (typeof path === "string" && !seen.has(path)) {
        seen.add(path);
        nav.push({ path, hidden: row.hidden === true });
      }
    }
  }
  const layoutSwitchHidden = v.layoutSwitchHidden === true;
  return {
    nav,
    viewportSwitchHidden: v.viewportSwitchHidden === true,
    layoutSwitchHidden,
    arranging: v.arranging !== false && !layoutSwitchHidden,
  };
};

const parse = (stored) => {
  try {
    return clean(JSON.parse(stored));
  } catch {
    return { ...DEFAULT };
  }
};

const sameNav = (a, b) => a.length === b.length && a.every((r, i) => r.path === b[i].path && r.hidden === b[i].hidden);

const same = (a, b) =>
  sameNav(a.nav, b.nav) &&
  a.viewportSwitchHidden === b.viewportSwitchHidden &&
  a.layoutSwitchHidden === b.layoutSwitchHidden &&
  a.arranging === b.arranging;

export const machine = setup({}).createMachine({
  id: "settings",
  meta: {
    kind: "fact",
    shape: "local-only",
    emits: ["settings.changed"],
    owns: "the user's page preferences: the order and visibility of pages in the navigation, whether the viewport switch and the layout switch are shown, and whether the desk layout is being arranged",
  },
  context: ({ input }) => ({ settings: parse(input.stored), save: input.save }),
  on: {
    // The gesture from settings-sheet, consumed as an event (4.3): the sheet emits
    // the whole settings, the fact never merges. Guarded so a repeat writes, saves
    // and announces nothing.
    "settings.edited": {
      guard: ({ context, event }) => !same(clean(event), context.settings),
      actions: [
        assign({ settings: ({ event }) => clean(event) }),
        ({ context }) => context.save(JSON.stringify(context.settings)),
        emit(({ context }) => ({ type: "settings.changed", ...context.settings })),
      ],
    },
    // The gesture from layout-switch. Guarded out when the switch is hidden (the
    // desk is not arrangeable, so arranging cannot be turned on) and on a no-op.
    "layout.switched": {
      guard: ({ context, event }) =>
        !context.settings.layoutSwitchHidden && event.arranging !== context.settings.arranging,
      actions: [
        assign({ settings: ({ context, event }) => clean({ ...context.settings, arranging: event.arranging }) }),
        ({ context }) => context.save(JSON.stringify(context.settings)),
        emit(({ context }) => ({ type: "settings.changed", ...context.settings })),
      ],
    },
    "read?": {
      actions: ({ context, event }) => event.reply({ ...context.settings, nav: context.settings.nav.map((r) => ({ ...r })) }),
    },
  },
});
