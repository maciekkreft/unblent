import { setup, assign, emit, enqueueActions } from "xstate";

// A remote-only fact component (3.1): each feature's Release and this account's Show
// are server truth, kept by its server module. The server also says what this viewer
// does not see, so the fact never asks who is the admin. The last
// answer is kept on the device through `input`, so a reload or an offline start hides
// the same features. The fetches arrive through `input` too, so the machine is a pure
// definition importable in Node.

// The features that have a flag (3.1). Pages name them in `flag="…"` (8).
export const FEATURES = ["choice-points", "undo"];

const list = (value) => (Array.isArray(value) ? value.filter((f) => typeof f === "string") : null);

// A picture as the server or the device gives it, or null when it is not one. A
// picture kept from before Release and Show reads as released where not off, and shown.
export const pictureOf = (value) => {
  const off = list(value?.off);
  const hidden = list(value?.hidden);
  if (!off || !hidden) return null;
  const released = list(value?.released) ?? FEATURES.filter((f) => !off.includes(f));
  const shown = list(value?.shown) ?? [...FEATURES];
  return { off, hidden, released, shown };
};

// With no answer yet every feature that has a flag is hidden (3.1).
export const NONE = { off: [...FEATURES], hidden: [...FEATURES], released: [], shown: [...FEATURES] };

const KEYS = ["off", "hidden", "released", "shown"];
const only = (picture) => Object.fromEntries(KEYS.map((k) => [k, picture[k]]));

const same = (a, b) => a.length === b.length && a.every((f, i) => f === b[i]);
const changed = (context, picture) => KEYS.some((k) => !same(context[k], picture[k]));
const announce = (picture) => ({ type: "flags.changed", ...only(picture) });

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
      "Owns which features each person sees: Values and Choice Points, and Undo. Each has " +
      "two switches in the Features tab. Release, set by the admin on the website, gives the " +
      "feature to everyone; one not released is hidden from everyone but the admin on the " +
      "website. Show, set by each account for itself, hides a released feature from that " +
      "account alone. Undo starts not released, on a new server as on one that has never " +
      "stored it, until the admin releases it. A Mac that is not connected reads Release " +
      "from the list frozen into the app when its version was built, and without that list " +
      "every feature counts as released. The last answer of the server is kept on this device, so a reload or " +
      "an offline start hides the same features; with no answer yet every feature that has " +
      "a flag is hidden. It reads again whenever the account changes, and forgets the kept " +
      "answer when the browser is about to change account. A switch that cannot be saved, " +
      "for example offline, changes nothing, and the same picture is announced again so the " +
      "tab can say so. Hiding is not a lock: the server parts of a hidden feature still " +
      "answer.",
    kind: "fact",
    shape: "remote-only",
    owns: "which features each person sees",
    emits: ["flags.changed"],
  },
  context: ({ input }) => {
    const kept = pictureOf(input.cached) ?? NONE;
    return { load: input.load, save: input.save, remember: input.remember ?? (() => {}), ...only(kept), seq: 0, applied: 0 };
  },
  entry: read,
  on: {
    "read?": { actions: ({ context, event }) => event.reply(only(context)) },
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
            .then(() => context.save(event.feature, event.on, event.column ?? "release"))
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
        assign(({ event }) => ({ ...only(event.picture), applied: event.seq })),
        ({ context, event }) => context.remember(event.picture),
      ],
    },
    // Nothing changed; saying so again lets the view that asked put its switch back.
    _refused: { actions: emit(({ context }) => announce(context)) },
  },
});
