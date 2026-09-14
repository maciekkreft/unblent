import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): headless owner of the user's page
// preferences — the order and visibility of pages in the navigation, whether the
// viewport switch and the layout lock are shown, and whether the desk layout is
// locked. It keeps them in one global localStorage key and answers settings: read;
// a view takes its starting picture by query (4.3) and follows settings.changed
// after. The store arrives through `input`, so the machine is a pure definition
// importable in Node.

const DEFAULT = { nav: [], viewportSwitchHidden: false, layoutLockHidden: false, layoutLocked: false };

// Sanitise any candidate into the contract shape (7.2): nav a list of
// { path: string, hidden: boolean } deduped by path (a page is listed once);
// three booleans coerced with === true. Then the invariant: a hidden lock means a
// locked desk, so hiding the switch locks, and after unhiding it the desk stays
// locked until the visible switch clears it.
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
  const layoutLockHidden = v.layoutLockHidden === true;
  return {
    nav,
    viewportSwitchHidden: v.viewportSwitchHidden === true,
    layoutLockHidden,
    layoutLocked: v.layoutLocked === true || layoutLockHidden,
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
  a.layoutLockHidden === b.layoutLockHidden &&
  a.layoutLocked === b.layoutLocked;

export const machine = setup({}).createMachine({
  id: "settings",
  meta: {
    kind: "fact",
    shape: "local-only",
    emits: ["settings.changed"],
    owns: "the user's page preferences: the order and visibility of pages in the navigation, whether the viewport switch and the layout lock are shown, and whether the desk layout is locked",
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
    // The gesture from layout-lock. Guarded out when the switch is hidden (the desk
    // is locked regardless, so the lock cannot be cleared) and on a no-op.
    "layout.locked": {
      guard: ({ context, event }) =>
        !context.settings.layoutLockHidden && event.locked !== context.settings.layoutLocked,
      actions: [
        assign({ settings: ({ context, event }) => clean({ ...context.settings, layoutLocked: event.locked }) }),
        ({ context }) => context.save(JSON.stringify(context.settings)),
        emit(({ context }) => ({ type: "settings.changed", ...context.settings })),
      ],
    },
    "read?": {
      actions: ({ context, event }) => event.reply({ ...context.settings, nav: context.settings.nav.map((r) => ({ ...r })) }),
    },
  },
});
