import { setup, assign, emit, enqueueActions } from "xstate";
import { ulid } from "ulid";

// A remote-only fact component (3.1): each feature's Release and this account's Show
// are server truth, kept by its server module. The server also says what this viewer
// does not see, so the fact never asks who is the admin. The last
// answer is kept on the device through `input`, so a reload or an offline start hides
// the same features. The fetches arrive through `input` too, so the machine is a pure
// definition importable in Node.

// The features that have a flag (3.1). Pages name them in `flag="…"` (8).
export const FEATURES = ["choice-points", "usage", "slip-box", "reading-aloud", "book-experts"];

const list = (value) => (Array.isArray(value) ? value.filter((f) => typeof f === "string") : null);

// A picture as the server or the device gives it, or null when it is not one. A
// picture kept from before Release and Show reads as released where not off, and shown.
// A feature a kept picture names neither off nor released did not exist when it was
// kept, so it is hidden until the server answers (3.1: a new feature may start off).
export const pictureOf = (value) => {
  let off = list(value?.off);
  let hidden = list(value?.hidden);
  if (!off || !hidden) return null;
  const released = list(value?.released) ?? FEATURES.filter((f) => !off.includes(f));
  const shown = list(value?.shown) ?? [...FEATURES];
  const unknown = FEATURES.filter((f) => !off.includes(f) && !released.includes(f));
  off = [...off, ...unknown.filter((f) => !off.includes(f))];
  hidden = [...hidden, ...unknown.filter((f) => !hidden.includes(f))];
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

// --- Steps (12, Undo) -------------------------------------------------------------------

// Release and Show live on the server, so a step holds the switch it expects to find
// and is applied only while the picture the server last gave still shows it.
const LIST = { release: "released", show: "shown" };
const isOn = (picture, feature, column) => picture[LIST[column]].includes(feature);

const NAMES = {
  "choice-points": "Values and Choice Points",
  usage: "Usage",
  "slip-box": "Slip-Box",
  "reading-aloud": "Reading aloud",
  "book-experts": "Book experts",
};
const labelOf = (feature, column, on) =>
  column === "release" ? `${on ? "release" : "hold back"} ${NAMES[feature] ?? feature}` : `${on ? "show" : "hide"} ${NAMES[feature] ?? feature}`;

// Sends one switch to the server; `step` rides the answer, so the gesture's step is
// recorded, or an Undo or Redo settled, only once the server holds it.
function sendSwitch(context, self, feature, on, column, step) {
  const seq = context.seq;
  Promise.resolve()
    .then(() => context.save(feature, on, column))
    .then(
      (reply) => {
        const picture = pictureOf(reply);
        self.send(picture ? { type: "_answered", seq, picture, step } : { type: "_refused" });
      },
      () => self.send({ type: "_refused" }),
    );
}

export const machine = setup({
  actions: {
    applyStep: enqueueActions(({ context, event, enqueue, self }) => {
      const p = event.payload ?? {};
      const fits = p.kind === "switch" && FEATURES.includes(p.feature) && LIST[p.column] && typeof p.on === "boolean";
      if (!fits || isOn(context, p.feature, p.column) !== p.expect) {
        enqueue.emit({ type: "step.settled", id: event.id, owner: "flags", outcome: "refused", reason: "changed" });
        return;
      }
      enqueue.assign({ seq: context.seq + 1 });
      // No answer from the server leaves the step where it was: `undo` says so itself.
      enqueue(() => sendSwitch({ ...context, seq: context.seq + 1 }, self, p.feature, p.on, p.column, { settle: event.id }));
    }),
  },
}).createMachine({
  id: "flags",
  meta: {
    description:
      "Owns which features each person sees: Values and Choice Points, Usage, Slip-Box, Reading aloud, and Book experts. Each has " +
      "two switches in the Features tab. Release, set by the admin on the website, gives the " +
      "feature to everyone; one not released is hidden from everyone but the admin on the " +
      "website. A feature starts held back when it is added, until the admin releases it. " +
      "Show, set by each account for itself, hides a released feature from that " +
      "account alone. A Mac that is not connected reads Release " +
      "from the list frozen into the app when its version was built, and without that list " +
      "every feature counts as released. The last answer of the server is kept on this device, so a reload or " +
      "an offline start hides the same features; with no answer yet every feature that has " +
      "a flag is hidden, and so is one the kept answer does not know yet. It reads again whenever the account changes, and forgets the kept " +
      "answer when the browser is about to change account. A switch that cannot be saved, " +
      "for example offline, changes nothing, and the same picture is announced again so the " +
      "tab can say so. Each switch pressed is a step Undo and Redo reverse, refused when " +
      "that switch was changed since. Hiding is not a lock: the server parts of a hidden " +
      "feature still answer.",
    kind: "fact",
    shape: "remote-only",
    owns: "which features each person sees",
    steps: { "flag.switched": "step" },
    emits: ["flags.changed", "step.recorded", "step.settled"],
  },
  context: ({ input }) => {
    const kept = pictureOf(input.cached) ?? NONE;
    return {
      load: input.load,
      save: input.save,
      remember: input.remember ?? (() => {}),
      mint: input.mint ?? ulid,
      ...only(kept),
      seq: 0,
      applied: 0,
    };
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
          const column = event.column ?? "release";
          const was = isOn(context, event.feature, column);
          const step = was === event.on ? null : { record: { feature: event.feature, column, was, on: event.on } };
          sendSwitch(context, self, event.feature, event.on, column, step);
        },
      ],
    },
    // Undo and Redo of a switch (12, Undo): applied only while the switch is as the step
    // left it; a change since, on any device, refuses it.
    "step.undone": { guard: ({ event }) => event.owner === "flags", actions: "applyStep" },
    "step.redone": { guard: ({ event }) => event.owner === "flags", actions: "applyStep" },
    _answered: {
      actions: [
        enqueueActions(({ context, event, enqueue }) => {
          const r = event.step?.record;
          if (r && isOn(event.picture, r.feature, r.column) === r.on)
            enqueue.emit({
              type: "step.recorded",
              id: context.mint(),
              owner: "flags",
              label: labelOf(r.feature, r.column, r.on),
              undo: { kind: "switch", feature: r.feature, column: r.column, on: r.was, expect: r.on },
              redo: { kind: "switch", feature: r.feature, column: r.column, on: r.on, expect: r.was },
            });
          if (event.step?.settle) enqueue.emit({ type: "step.settled", id: event.step.settle, owner: "flags", outcome: "applied" });
          // An answer that arrives after a newer one is dropped.
          if (event.seq < context.applied) return;
          if (changed(context, event.picture)) enqueue(emit(announce(event.picture)));
          enqueue.assign({ ...only(event.picture), applied: event.seq });
          enqueue(() => context.remember(event.picture));
        }),
      ],
    },
    // Nothing changed; saying so again lets the view that asked put its switch back.
    _refused: { actions: emit(({ context }) => announce(context)) },
  },
});
