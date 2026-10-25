import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the Feature flags tab of the gear's sheet, shown only to the
// admin (12). It owns no fact: which features are off belongs to `flags`, reached by one
// query for the starting picture and flags.changed after (4.3, fourth rule). Each switch
// is emitted as flag.switched. Its own UI state is the switches still waiting for an
// answer, shown in the position asked for, and the feature whose switch was refused.
// The ask arrives through `input`, so the machine imports in Node.

// The features as people name them, each with what turning it off hides. The ids are
// the ones `flags` keeps and pages name in `flag="…"` (8).
export const FEATURES = [
  { id: "chats", name: "Chats", says: "The Chats tab, where people talk with the language model about what they read." },
  { id: "evaluators", name: "Evaluators", says: "The Evaluators tab, where people write questions Jev answers about a text." },
  { id: "choice-points", name: "Choice points", says: "The choice point sheets under a journal day, and their checks in Settings." },
  { id: "highlights", name: "Highlights", says: "The Highlights row at the top of a book's notes." },
];

// Whether a feature's switch shows on: what was asked while it waits, else what `flags`
// says.
export const onOf = (context, id) => (id in context.waiting ? context.waiting[id] : !context.off.includes(id));

// After a new picture: a waiting switch the picture agrees with is done, and one it
// does not agree with was refused.
export const settle = (waiting, off) => {
  const left = {};
  let refused = null;
  for (const [id, on] of Object.entries(waiting)) {
    if (on === !off.includes(id)) continue;
    refused = id;
  }
  return { waiting: left, refused };
};

const pictureOf = (reply) => (reply && Array.isArray(reply.off) ? reply.off : null);

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("flags", "read", {})),
  },
}).createMachine({
  id: "feature-flags",
  meta: {
    description:
      "The Feature flags tab of the gear's sheet, shown only to the admin. One switch per " +
      "feature that can be hidden from everyone but the admin (Chats, Evaluators, Choice " +
      "points, Highlights), each with a sentence saying what turning it off hides. A switch " +
      "moves at once when pressed and applies to everyone else at their next start; " +
      "pressing it again is the undo. The admin keeps seeing every feature. A switch that " +
      "cannot be saved, for example offline, goes back to where it was and a line under " +
      "the switches says so.",
    kind: "view",
    emits: ["flag.switched"],
    attributes: [],
    asks: ["flags: read"],
  },
  context: ({ input }) => ({ ask: input.ask, off: null, waiting: {}, refused: null }),
  invoke: {
    src: "read",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ off: ({ context, event }) => pictureOf(event.output) ?? context.off }) },
    onError: { actions: [] },
  },
  on: {
    "flags.changed": {
      actions: assign(({ context, event }) => {
        const { waiting, refused } = settle(context.waiting, event.off);
        return { off: event.off, waiting, refused: refused ?? context.refused };
      }),
    },
    _switch: {
      guard: ({ context, event }) => context.off !== null && FEATURES.some((f) => f.id === event.feature),
      actions: [
        assign(({ context, event }) => ({ waiting: { ...context.waiting, [event.feature]: event.on }, refused: null })),
        emit(({ event }) => ({ type: "flag.switched", feature: event.feature, on: event.on })),
      ],
    },
  },
});
