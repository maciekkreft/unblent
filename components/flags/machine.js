import { setup, assign, emit, enqueueActions } from "xstate";

// A remote-only fact component (3.1): which features are off is server truth, kept in
// one shared file by its server module. The server also says what this viewer does not
// see, read from the cookie (3.4), so the fact never asks who is the admin. The last
// answer is kept on the device through `input`, so a reload or an offline start hides
// the same features. The fetches arrive through `input` too, so the machine is a pure
// definition importable in Node.

// The features that have a flag (3.1). Pages name them in `flag="…"` (8).
export const FEATURES = ["chats", "evaluators", "choice-points", "highlights"];

const list = (value) => (Array.isArray(value) ? value.filter((f) => typeof f === "string") : null);

// A picture as the server or the device gives it, or null when it is not one.
export const pictureOf = (value) => {
  const off = list(value?.off);
  const hidden = list(value?.hidden);
  return off && hidden ? { off, hidden } : null;
};

// With no answer yet every feature that has a flag is hidden (3.1).
export const NONE = { off: [...FEATURES], hidden: [...FEATURES] };

const same = (a, b) => a.length === b.length && a.every((f, i) => f === b[i]);
const changed = (context, picture) => !same(context.off, picture.off) || !same(context.hidden, picture.hidden);
const announce = (picture) => ({ type: "flags.changed", off: picture.off, hidden: picture.hidden });

// A failed read keeps what the device holds; it is tried again at the next change of
// account or reload. `seq` numbers each request, so an answer that arrives after a
// newer one is dropped.
const read = [
  assign({ seq: ({ context }) => context.seq + 1 }),
  ({ context, self }) => {
    const { seq } = context;
    Promise.resolve()
      .then(() => context.load())
      .then(
        (reply) => {
          const picture = pictureOf(reply);
          if (picture) self.send({ type: "_answered", seq, picture });
        },
        () => {},
      );
  },
];

export const machine = setup({}).createMachine({
  id: "flags",
  meta: {
    description:
      "Owns which features are off for everyone except the admin: Chats, Evaluators, Choice " +
      "points and Highlights. The admin turns them on and off in the Feature flags tab and " +
      "sees every feature, except while viewing as someone, when the admin sees what that " +
      "account sees. The last answer of the server is kept on this device, so a reload or " +
      "an offline start hides the same features; with no answer yet every feature that has " +
      "a flag is hidden. It reads again whenever the account changes, and forgets the kept " +
      "answer when the browser is about to change account. A switch that cannot be saved, " +
      "for example offline, changes nothing, and the same picture is announced again so the " +
      "tab can say so. Hiding is not a lock: the server parts of a hidden feature still " +
      "answer.",
    kind: "fact",
    shape: "remote-only",
    owns: "which features are off",
    emits: ["flags.changed"],
  },
  context: ({ input }) => {
    const kept = pictureOf(input.cached) ?? NONE;
    return { load: input.load, save: input.save, remember: input.remember ?? (() => {}), off: kept.off, hidden: kept.hidden, seq: 0, applied: 0 };
  },
  entry: read,
  on: {
    "read?": { actions: ({ context, event }) => event.reply({ off: context.off, hidden: context.hidden }) },
    // The browser is about to change account (12): the next account must not start
    // from this one's answer. Any other change of account reads again.
    "session.changed": [
      { guard: ({ event }) => event.leaving === true, actions: ({ context }) => context.remember(null) },
      { actions: read },
    ],
    "flag.switched": {
      guard: ({ event }) => FEATURES.includes(event.feature),
      actions: [
        assign({ seq: ({ context }) => context.seq + 1 }),
        ({ context, event, self }) => {
          const { seq } = context;
          Promise.resolve()
            .then(() => context.save(event.feature, event.on))
            .then(
              (reply) => {
                const picture = pictureOf(reply);
                self.send(picture ? { type: "_answered", seq, picture } : { type: "_refused" });
              },
              () => self.send({ type: "_refused" }),
            );
        },
      ],
    },
    _answered: {
      guard: ({ context, event }) => event.seq >= context.applied,
      actions: [
        enqueueActions(({ context, event, enqueue }) => {
          if (changed(context, event.picture)) enqueue(emit(announce(event.picture)));
        }),
        assign(({ event }) => ({ off: event.picture.off, hidden: event.picture.hidden, applied: event.seq })),
        ({ context, event }) => context.remember(event.picture),
      ],
    },
    // Nothing changed; saying so again lets the view that asked put its switch back.
    _refused: { actions: emit(({ context }) => announce(context)) },
  },
});
