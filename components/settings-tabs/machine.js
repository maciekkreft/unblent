import { setup, assign, fromPromise } from "xstate";

// A container view (3.1, 6.4) for the sheet the gear opens. It owns only its own UI
// state: which tab is shown. Who the account is belongs to `session`, and which features
// are hidden to `flags` (8), each reached by one query for the starting picture and its
// event after (4.3, fourth rule). The
// children arrive through `input`, read from the DOM by the view, so the machine stays
// a pure definition importable in Node.

// The People tab is the admin's alone, and hidden while the admin views as someone (12).
export const adminOf = (picture) =>
  Boolean(picture && !picture.error && picture.userId != null && picture.admin === true && !picture.viewingAs);

// Whether a child is shown: one marked `admin` only to the admin, and one with a `flag`
// only while `flags` reports that feature shown; until `flags` answers (`hidden` is null)
// a flagged child is hidden, as everywhere else (3.1).
const offered = (child, admin, hidden) =>
  (!child.admin || admin) && !(child.flag && (hidden === null || hidden.includes(child.flag)));

// The tabs the account may see, in page order, one per label.
export const tabsOf = (children, admin, hidden = []) => {
  const labels = [];
  for (const child of children) {
    if (!offered(child, admin, hidden)) continue;
    if (!labels.includes(child.label)) labels.push(child.label);
  }
  return labels;
};

// The tab shown: the one picked while it is still there, else the first, so losing the
// admin role (signing out, viewing as someone) falls back to Settings.
export const shownOf = (children, admin, picked, hidden = []) => {
  const tabs = tabsOf(children, admin, hidden);
  return tabs.includes(picked) ? picked : (tabs[0] ?? null);
};

// The children the shown tab holds, by their index among the children.
export const slottedOf = (children, admin, picked, hidden = []) => {
  const shown = shownOf(children, admin, picked, hidden);
  return children.flatMap((child, i) => (child.label === shown && offered(child, admin, hidden) ? [i] : []));
};

export const machine = setup({
  actors: {
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
    flags: fromPromise(({ input }) => input.ask("flags", "read", {})),
  },
}).createMachine({
  id: "settings-tabs",
  meta: {
    description:
      "The sheet the gear opens. It shows its children as tabs, named by each child's " +
      "label; children with the same label share one tab and stand one after another in " +
      "it, Settings first. A child marked `admin` is shown only to the admin, and is " +
      "hidden while the admin views as someone. A child with `flag` naming a feature is " +
      "shown only while `flags` reports that feature shown, and not until it answers (a page " +
      "without `flags` hides nothing). While only one tab is left there is no " +
      "tab bar. It asks `session` who the account is and `flags` which features are " +
      "hidden, and follows each after.",
    kind: "view",
    emits: [],
    attributes: [],
    asks: ["session: read", "flags: read"],
  },
  // The pick is handed back by the view after a reload (3.1); shownOf falls back to the
  // first tab while it is not offered, and keeps it for when it is again.
  context: ({ input }) => ({ ask: input.ask, children: input.children ?? [], admin: false, hidden: null, picked: input.picked ?? null }),
  invoke: [
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ admin: ({ event }) => adminOf(event.output) }) },
      onError: { actions: [] },
    },
    {
      src: "flags",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ hidden: ({ event }) => (Array.isArray(event.output?.hidden) ? event.output.hidden : []) }) },
      onError: { actions: assign({ hidden: [] }) },
    },
  ],
  on: {
    "session.changed": { actions: assign({ admin: ({ event }) => adminOf(event) }) },
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    _pick: { actions: assign({ picked: ({ event }) => event.label }) },
    _children: { actions: assign({ children: ({ event }) => event.children }) },
  },
});
