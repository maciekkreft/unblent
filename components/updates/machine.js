import { setup, emit, enqueueActions } from "xstate";
import { ulid } from "ulid";

// A remote-only fact component (3.1): whether this Mac is offered test versions lives in
// `updates.json` in the data folder, because the Mac app reads it there before it checks
// for updates (10). Only the local edition's server module answers, so on the website
// every read fails and the switch is never shown. The fetches arrive through `input`,
// so the machine is a pure definition importable in Node.

const pictureOf = (value) => (typeof value?.test === "boolean" ? { test: value.test } : null);

const labelOf = (on) => `turn ${on ? "on" : "off"} Test versions`;

// `step` rides the answer, so the gesture's step is recorded, or an Undo or Redo settled,
// only once the server holds it.
function sendSwitch(context, self, on, step) {
  Promise.resolve()
    .then(() => context.save(on))
    .then(
      (reply) => {
        const picture = pictureOf(reply);
        self.send(picture ? { type: "_answered", picture, step } : { type: "_refused" });
      },
      () => self.send({ type: "_refused" }),
    );
}

export const machine = setup({
  actions: {
    // Undo and Redo of the switch (12, Undo): applied only while the switch is as the step
    // left it; a change since, in another tab, refuses it.
    applyStep: enqueueActions(({ context, event, enqueue, self }) => {
      const p = event.payload ?? {};
      if (p.kind !== "switch" || typeof p.on !== "boolean" || context.test !== p.expect) {
        enqueue.emit({ type: "step.settled", id: event.id, owner: "updates", outcome: "refused", reason: "changed" });
        return;
      }
      // No answer from the server leaves the step where it was: `undo` says so itself.
      enqueue(() => sendSwitch(context, self, p.on, { settle: event.id }));
    }),
  },
}).createMachine({
  id: "updates",
  meta: {
    description:
      "Owns whether this Mac is offered test versions of the app, the Test versions switch in " +
      "Settings › This device. Off at first. When it is on, the Mac app, the next time it " +
      "checks for updates, also offers test builds of the next version; when it is off, only " +
      "finished versions. Turning it off does not go back to an older version: the Mac stays " +
      "on the test build until the next finished version, which is always newer. Only the Mac " +
      "app answers, so on the website reading it fails and Settings shows no switch. A switch " +
      "that cannot be saved changes nothing, and the same answer is announced again so the " +
      "switch shows what is saved. Each switch pressed is a step Undo and Redo reverse, " +
      "refused when the switch was changed since.",
    kind: "fact",
    shape: "remote-only",
    owns: "whether this Mac is offered test versions",
    steps: { "updates.edited": "step" },
    emits: ["updates.changed", "step.recorded", "step.settled"],
  },
  context: ({ input }) => ({
    load: input.load,
    save: input.save,
    mint: input.mint ?? ulid,
    // The last answer of the server; null until one came, and on the website.
    test: null,
  }),
  on: {
    // Each read asks the server again, so a page opened after the file changed by hand
    // still shows what the Mac app will read.
    "read?": {
      actions: ({ context, event, self }) => {
        Promise.resolve()
          .then(() => context.load())
          .then(
            (reply) => {
              const picture = pictureOf(reply);
              if (!picture) return event.reply({ error: "unavailable" });
              self.send({ type: "_answered", picture, quiet: true });
              event.reply(picture);
            },
            () => event.reply({ error: "unavailable" }),
          );
      },
    },
    "updates.edited": {
      guard: ({ event }) => typeof event.test === "boolean",
      actions: ({ context, event, self }) => {
        const step = context.test === null || context.test === event.test ? null : { record: { was: context.test, on: event.test } };
        sendSwitch(context, self, event.test, step);
      },
    },
    "step.undone": { guard: ({ event }) => event.owner === "updates", actions: "applyStep" },
    "step.redone": { guard: ({ event }) => event.owner === "updates", actions: "applyStep" },
    _answered: {
      actions: enqueueActions(({ context, event, enqueue }) => {
        const r = event.step?.record;
        if (r && event.picture.test === r.on)
          enqueue.emit({
            type: "step.recorded",
            id: context.mint(),
            owner: "updates",
            label: labelOf(r.on),
            undo: { kind: "switch", on: r.was, expect: r.on },
            redo: { kind: "switch", on: r.on, expect: r.was },
          });
        if (event.step?.settle) enqueue.emit({ type: "step.settled", id: event.step.settle, owner: "updates", outcome: "applied" });
        // A read's answer is the starting picture of the one who asked; it is announced
        // only when it differs from what was known, so no one else hears a read.
        const differs = context.test !== event.picture.test;
        enqueue.assign({ test: event.picture.test });
        if (!event.quiet || (differs && context.test !== null)) enqueue(emit({ type: "updates.changed", test: event.picture.test }));
      }),
    },
    // Nothing changed; saying so again lets the view put its switch back.
    _refused: {
      guard: ({ context }) => context.test !== null,
      actions: emit(({ context }) => ({ type: "updates.changed", test: context.test })),
    },
  },
});
