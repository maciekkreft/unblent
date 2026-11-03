import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the Features tab of the gear's sheet, shown to everyone (12).
// It owns no fact: Release and Show belong to `flags`, and who the account is to
// `session`, each reached by one query for the starting picture and its event after
// (4.3, fourth rule). Each switch is emitted as flag.switched with its column. Its own
// UI state is the switches still waiting for an answer, shown in the position asked
// for, and the switch that was refused. The asks arrive through `input`, so the machine
// imports in Node.

// The features as people name them, each with what hiding it hides. The ids are the
// ones `flags` keeps and pages name in `flag="…"` (8).
export const FEATURES = [
  {
    id: "choice-points",
    name: "Values and Choice Points",
    says: "Your values and the choice point sheets under a journal day, with their checks.",
  },
];

const key = (column, id) => `${column}:${id}`;

const listOf = (picture, name) => (Array.isArray(picture?.[name]) ? picture[name] : null);

// The two columns as the tab shows them, from a picture of `flags`: what is released
// and what this account shows. An answer from before Release and Show reads as
// released where not off, and shown.
export const pictureOf = (reply) => {
  const off = listOf(reply, "off");
  if (!off) return null;
  return {
    released: listOf(reply, "released") ?? FEATURES.map((f) => f.id).filter((id) => !off.includes(id)),
    shown: listOf(reply, "shown") ?? FEATURES.map((f) => f.id),
  };
};

// Whether a switch shows on: what was asked while it waits, else what `flags` says.
export const onOf = (context, column, id) => {
  const k = key(column, id);
  if (k in context.waiting) return context.waiting[k];
  return (column === "release" ? context.released : context.shown).includes(id);
};

// After a new picture: a waiting switch the picture agrees with is done, and one it
// does not agree with was refused.
export const settle = (waiting, picture) => {
  let refused = null;
  for (const [k, on] of Object.entries(waiting)) {
    const [column, id] = k.split(":");
    if (on === (column === "release" ? picture.released : picture.shown).includes(id)) continue;
    refused = { column, id };
  }
  return { waiting: {}, refused };
};

// The admin on the website, not viewing as someone (12): the one who sees the Release
// column, and the rows of features that are not released.
export const mayReleaseOf = (session) =>
  Boolean(session && !session.error && session.userId != null && session.admin === true && !session.viewingAs && !session.connect);

const signedInOf = (session) => Boolean(session && !session.error && session.userId != null);

// The rows the tab shows: a feature not released only to whoever may release it.
export const rowsOf = (context) =>
  FEATURES.filter((f) => context.mayRelease || (context.released ?? []).includes(f.id));

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("flags", "read", {})),
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
}).createMachine({
  id: "feature-flags",
  meta: {
    description:
      "The Features tab of the gear's sheet, shown to everyone. One row per feature that " +
      "`flags` can hide, named as people know it (Values and Choice Points), with " +
      "what it holds under the name, and two switches. Release gives the feature to " +
      "everyone; it is shown only to the admin on the website, not while viewing as someone, " +
      "and only then is a feature that is not released shown as a row. Show hides or shows " +
      "the feature for this account alone; signed out it cannot be changed, and a line says " +
      "to sign in. A switch moves at once when pressed; pressing it again, or Undo, takes it back. A " +
      "switch that cannot be saved, for example offline, goes back to where it was and a " +
      "line under the switches says so.",
    kind: "view",
    emits: ["flag.switched"],
    attributes: [],
    asks: ["flags: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    released: null,
    shown: null,
    mayRelease: false,
    signedIn: false,
    waiting: {},
    refused: null,
  }),
  invoke: [
    {
      src: "read",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign(({ context, event }) => pictureOf(event.output) ?? { released: context.released, shown: context.shown }) },
      onError: { actions: [] },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ mayRelease: ({ event }) => mayReleaseOf(event.output), signedIn: ({ event }) => signedInOf(event.output) }) },
      onError: { actions: [] },
    },
  ],
  on: {
    "flags.changed": {
      actions: assign(({ context, event }) => {
        const picture = pictureOf(event);
        if (!picture) return {};
        const { waiting, refused } = settle(context.waiting, picture);
        return { ...picture, waiting, refused: refused ?? context.refused };
      }),
    },
    "session.changed": {
      actions: assign({ mayRelease: ({ event }) => mayReleaseOf(event), signedIn: ({ event }) => signedInOf(event) }),
    },
    _switch: {
      guard: ({ context, event }) =>
        context.released !== null &&
        FEATURES.some((f) => f.id === event.feature) &&
        (event.column === "release" ? context.mayRelease : event.column === "show" && context.signedIn),
      actions: [
        assign(({ context, event }) => ({ waiting: { ...context.waiting, [key(event.column, event.feature)]: event.on }, refused: null })),
        emit(({ event }) => ({ type: "flag.switched", feature: event.feature, on: event.on, column: event.column })),
      ],
    },
  },
});
