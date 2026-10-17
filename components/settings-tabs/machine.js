import { setup, assign, fromPromise } from "xstate";

// A container view (3.1, 6.4) for the sheet the gear opens. It owns only its own UI
// state: which tab is shown. Who the account is belongs to `session`, reached by one
// query for the starting picture and session.changed after (4.3, fourth rule). The
// children arrive through `input`, read from the DOM by the view, so the machine stays
// a pure definition importable in Node.

// Administration is the admin's alone, and hidden while the admin views as someone (12).
export const adminOf = (picture) =>
  Boolean(picture && !picture.error && picture.userId != null && picture.admin === true && !picture.viewingAs);

// The tabs the account may see, in page order, one per label: a child marked `admin`
// counts only for the admin.
export const tabsOf = (children, admin) => {
  const labels = [];
  for (const child of children) {
    if (child.admin && !admin) continue;
    if (!labels.includes(child.label)) labels.push(child.label);
  }
  return labels;
};

// The tab shown: the one picked while it is still there, else the first, so losing the
// admin role (signing out, viewing as someone) falls back to Settings.
export const shownOf = (children, admin, picked) => {
  const tabs = tabsOf(children, admin);
  return tabs.includes(picked) ? picked : (tabs[0] ?? null);
};

// The children the shown tab holds, by their index among the children.
export const slottedOf = (children, admin, picked) => {
  const shown = shownOf(children, admin, picked);
  return children.flatMap((child, i) => (child.label === shown && (admin || !child.admin) ? [i] : []));
};

export const machine = setup({
  actors: {
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
}).createMachine({
  id: "settings-tabs",
  meta: {
    description:
      "The sheet the gear opens. It shows its children as tabs, named by each child's " +
      "label; children with the same label share one tab and stand one after another in " +
      "it, Settings first. A child marked `admin` is shown only to the admin, and is " +
      "hidden while the admin views as someone. While only one tab is left there is no " +
      "tab bar, so everyone but the admin sees Settings exactly as before. It asks " +
      "`session` who the account is and follows it after.",
    kind: "view",
    emits: [],
    attributes: [],
    asks: ["session: read"],
  },
  context: ({ input }) => ({ ask: input.ask, children: input.children ?? [], admin: false, picked: null }),
  invoke: {
    src: "session",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ admin: ({ event }) => adminOf(event.output) }) },
    onError: { actions: [] },
  },
  on: {
    "session.changed": { actions: assign({ admin: ({ event }) => adminOf(event) }) },
    _pick: { actions: assign({ picked: ({ event }) => event.label }) },
    _children: { actions: assign({ children: ({ event }) => event.children }) },
  },
});
