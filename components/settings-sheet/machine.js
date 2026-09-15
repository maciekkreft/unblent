import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the sheet that edits the user's page preferences. It owns
// no fact; the preferences belong to `settings`, reached by one query for the
// starting picture and settings.changed after (4.3, fourth rule), and the pages by
// `pages: list`. Once ready, every gesture computes the whole settings and emits
// settings.edited; nothing is assigned locally, settings.changed is the only
// assignment. `current` and the ask arrive through `input`, so the machine never
// touches `window` and imports in Node.

// The navigation as rows: listed paths first in nav order (keeping only pages that
// exist), then unlisted pages in pages order, shown. Each row carries its title.
// Duplicated in page-nav (task 4); components never import each other (11.2).
export const merge = (pages, nav) => {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const rows = [];
  const seen = new Set();
  for (const n of nav) {
    const p = byPath.get(n.path);
    if (p && !seen.has(n.path)) {
      seen.add(n.path);
      rows.push({ path: p.path, title: p.title, hidden: n.hidden });
    }
  }
  for (const p of pages) {
    if (!seen.has(p.path)) {
      seen.add(p.path);
      rows.push({ path: p.path, title: p.title, hidden: false });
    }
  }
  return rows;
};

// A full settings object with nav materialised from rows: reordering or hiding one
// page writes every page's position, so the order is stable whatever changes next.
const withNav = (settings, rows) => ({ ...settings, nav: rows.map((r) => ({ path: r.path, hidden: r.hidden })) });

const swap = (rows, i, j) => {
  const next = [...rows];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
};

const rowsOf = (context) => merge(context.pages, context.settings.nav);
const indexOf = (context, path) => rowsOf(context).findIndex((r) => r.path === path);

const edited = (settings) => ({ type: "settings.edited", ...settings });
const setHidden = (context, path, hidden) => {
  const rows = rowsOf(context).map((r) => (r.path === path ? { ...r, hidden } : r));
  return edited(withNav(context.settings, rows));
};

const DEFAULT = { nav: [], viewportSwitchHidden: false, layoutSwitchHidden: false, arranging: true, editors: {} };

const adopt = (event) => ({
  nav: event.nav.map((r) => ({ ...r })),
  viewportSwitchHidden: event.viewportSwitchHidden,
  layoutSwitchHidden: event.layoutSwitchHidden,
  arranging: event.arranging,
  editors: { ...(event.editors ?? {}) },
});

// The role a member fills, keyed by tag for the default and by data-role for a
// swapped-in member; the sheet only needs the members of a role to list them.
const membersByRole = (components) => {
  const roles = {};
  for (const c of components ?? []) {
    if (c.role) (roles[c.role] ??= []).push(c.name);
  }
  return roles;
};

export const machine = setup({
  actors: {
    pages: fromPromise(({ input }) => input.ask("pages", "list", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    catalog: fromPromise(({ input }) => input.ask("catalog", "list", {})),
  },
}).createMachine({
  id: "settings-sheet",
  meta: {
    kind: "view",
    emits: ["settings.edited"],
    attributes: [],
    asks: ["pages: list", "settings: read", "catalog: list"],
  },
  context: ({ input }) => ({ ask: input.ask, current: input.current, pages: [], settings: { ...DEFAULT }, roles: {} }),
  initial: "loadingPages",
  states: {
    loadingPages: {
      invoke: {
        src: "pages",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          { target: "loadingSettings", actions: assign({ pages: ({ event }) => event.output.pages }) },
        ],
        onError: { target: "failed" },
      },
    },
    loadingSettings: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "failed" },
          { target: "loadingCatalog", actions: assign({ settings: ({ event }) => adopt(event.output) }) },
        ],
        onError: { target: "failed" },
      },
    },
    // The catalog names the role members to offer in each swap select; it is
    // optional, so a page without it, or an offline catalog, leaves roles empty
    // and the sheet simply shows no swap selects.
    loadingCatalog: {
      invoke: {
        src: "catalog",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "ready" },
          { target: "ready", actions: assign({ roles: ({ event }) => membersByRole(event.output.components) }) },
        ],
        onError: { target: "ready" },
      },
    },
    // Every gesture emits the whole settings; the sheet adopts it back through
    // settings.changed. Nothing is assigned locally here (4.3, fourth rule).
    ready: {
      on: {
        _up: {
          guard: ({ context, event }) => indexOf(context, event.path) > 0,
          actions: emit(({ context, event }) => {
            const i = indexOf(context, event.path);
            return edited(withNav(context.settings, swap(rowsOf(context), i, i - 1)));
          }),
        },
        _down: {
          guard: ({ context, event }) => {
            const rows = rowsOf(context);
            const i = rows.findIndex((r) => r.path === event.path);
            return i >= 0 && i < rows.length - 1;
          },
          actions: emit(({ context, event }) => {
            const i = indexOf(context, event.path);
            return edited(withNav(context.settings, swap(rowsOf(context), i, i + 1)));
          }),
        },
        // The current page keeps no hide control: the sheet is the way back.
        _hide: {
          guard: ({ context, event }) => event.path !== context.current && indexOf(context, event.path) >= 0,
          actions: emit(({ context, event }) => setHidden(context, event.path, true)),
        },
        _show: {
          guard: ({ context, event }) => indexOf(context, event.path) >= 0,
          actions: emit(({ context, event }) => setHidden(context, event.path, false)),
        },
        _toggleViewport: {
          actions: emit(({ context }) =>
            edited({ ...context.settings, viewportSwitchHidden: !context.settings.viewportSwitchHidden }),
          ),
        },
        _toggleLayout: {
          actions: emit(({ context }) =>
            edited({ ...context.settings, layoutSwitchHidden: !context.settings.layoutSwitchHidden }),
          ),
        },
        // Choose the implementation for a swappable role (3.6, 7.3): the whole
        // settings with this role's choice set, like every other gesture here.
        _setEditor: {
          actions: emit(({ context, event }) =>
            edited({
              ...context.settings,
              editors: { ...context.settings.editors, [event.role]: event.component },
            }),
          ),
        },
        _reset: { actions: emit(() => edited({ ...DEFAULT })) },
      },
    },
    failed: {},
  },
  on: {
    "settings.changed": { actions: assign({ settings: ({ event }) => adopt(event) }) },
  },
});
