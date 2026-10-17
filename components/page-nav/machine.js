import { setup, assign, fromPromise } from "xstate";

// A view component (3.1): one way of looking at the slip-box, the links between
// its pages. It owns only the list it is showing and which page is current; the
// pages belong to `pages` and the navigation order and hidden pages to `settings`,
// each reached through one query (4.3, fourth rule: query for the starting
// picture). The set of pages changes on deploy, not in a session, so there is no
// `pages.changed`; the order and visibility change in a session, so it follows
// `settings.changed`. `current` and the ask arrive through `input`, so the machine
// never touches `window` and imports in Node.

// The navigation as rows: listed paths first in nav order (keeping only pages that
// exist), then unlisted pages in pages order, shown. Duplicated in settings-sheet;
// components never import each other (11.2).
const merge = (pages, nav) => {
  const byPath = new Map(pages.map((p) => [p.path, p]));
  const rows = [];
  const seen = new Set();
  for (const n of nav) {
    const p = byPath.get(n.path);
    if (p && !seen.has(n.path)) {
      seen.add(n.path);
      rows.push({ path: p.path, title: p.title, hidden: n.hidden, kind: p.kind });
    }
  }
  for (const p of pages) {
    if (!seen.has(p.path)) {
      seen.add(p.path);
      rows.push({ path: p.path, title: p.title, hidden: false, kind: p.kind });
    }
  }
  return rows;
};

// The links to show: the merged order without the hidden pages, but the current
// page is always kept — you can always see where you are, even on a hidden page.
export const visible = (pages, nav, current) => merge(pages, nav).filter((r) => !r.hidden || r.path === current);

// The link groups, in architecture 8's composition order. The muted label is what
// tells apart two pages of the same title (the `notes` stem from the notes app);
// the user's order (nav) still holds within a group. A row of a kind in no group
// falls to Apps; the page check already rejects unknown kinds.
const GROUPS = [
  { label: "Design", kinds: ["tokens", "contracts", "components"] },
  { label: "Stems", kinds: ["stem"] },
  { label: "Apps", kinds: ["app"] },
  { label: "Try", kinds: ["try"] },
];
const groupOf = (kind) => GROUPS.find((g) => g.kinds.includes(kind)) ?? GROUPS[2];

// The product profile (§8, §12) shows no page links at all: the bar stays, but the
// only way on is the hidden door. Every other profile groups the pages as before.
export const grouped = (pages, nav, current, profile) => {
  if (profile === "product") return [];
  const rows = visible(pages, nav, current);
  return GROUPS.map((g) => ({ label: g.label, rows: rows.filter((r) => groupOf(r.kind) === g) })).filter(
    (g) => g.rows.length,
  );
};

export const machine = setup({
  actors: {
    list: fromPromise(({ input }) => input.ask("pages", "list", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "page-nav",
  meta: {
    description:
      "The bar of links to the other pages, grouped by kind in the order of section 8, in the " +
      "order and with the visibility the user set in Settings. The page being shown is always " +
      "listed, even when hidden. In the product profile it shows no page links.",
    kind: "view", emits: [], attributes: [], asks: ["pages: list", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    current: input.current,
    pages: [],
    nav: [],
    // The active profile (§12), adopted from settings; a page without settings
    // stays in `workshop`, the full nav, exactly as before profiles existed.
    profile: "workshop",
    error: null,
  }),
  initial: "loadingPages",
  states: {
    loadingPages: {
      invoke: {
        src: "list",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Boolean(event.output.error),
            target: "failed",
            actions: assign({ error: ({ event }) => event.output.error }),
          },
          { target: "loadingSettings", actions: assign({ pages: ({ event }) => event.output.pages }) },
        ],
        onError: { target: "failed", actions: assign({ error: "unavailable" }) },
      },
    },
    // Settings is optional: a page without it (the ask replies no-answerer) keeps
    // the default order with nothing hidden, exactly as before settings existed.
    loadingSettings: {
      invoke: {
        src: "settings",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output.error), target: "ready" },
          {
            target: "ready",
            actions: assign({
              nav: ({ event }) => event.output.nav,
              profile: ({ event, context }) => event.output.profile ?? context.profile,
            }),
          },
        ],
        onError: { target: "ready" },
      },
    },
    ready: {},
    failed: {},
  },
  on: {
    // The fact's news (4.3, fourth rule): adopt the order, hidden pages and profile.
    "settings.changed": {
      actions: assign({
        nav: ({ event }) => event.nav,
        profile: ({ event, context }) => event.profile ?? context.profile,
      }),
    },
  },
});
