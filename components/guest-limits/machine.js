import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// A view component (3.1): the Limits and Guest keys parts of Administration (12). It owns
// no fact: the limits and the guest keys belong to `llm`, reached by one query for the
// starting picture and spending.changed after (4.3, fourth rule); every gesture is
// emitted, and spending.changed is the only assignment of the picture. It asks only once it is shown
// (`_shown`, sent by the view), so nobody but the admin, the one account the sheet shows
// it to, ever asks. The ask arrives through `input`, so the machine imports in Node.

// A provider as people name it in a row: "Jev by typesafe.ai" is "Jev".
export const shortOf = (label) => label.split(" by ")[0];

// A limit as the box shows it: dollars with cents, or empty for a provider with no own
// limit (the box then says so).
export const limitText = (value) => (value == null ? "" : `$${value.toFixed(2)}`);

// What the admin typed, read as dollars: "$2", "2.50" or "2,50". Empty is no limit,
// which only a provider may have. undefined means the text is not an amount.
export const parseLimit = (text, optional) => {
  const t = String(text).replace(/[$\s]/g, "").replace(",", ".");
  if (t === "") return optional ? null : undefined;
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return undefined;
  return Math.round(Number(t) * 100) / 100;
};

// The limits.edited a typed limit makes, or null when it is not an amount or changes
// nothing. `field` is "guest", "allGuests", or a provider's id.
export const limitEdit = (spending, field, text) => {
  if (!spending) return null;
  if (field === "guest" || field === "allGuests") {
    const value = parseLimit(text, false);
    const now = field === "guest" ? spending.guest : spending.allGuests.limit;
    return value === undefined || value === now ? null : { [field]: value };
  }
  const provider = spending.providers.find((p) => p.id === field);
  if (!provider) return null;
  const value = parseLimit(text, true);
  return value === undefined || value === provider.limit ? null : { providers: { [field]: value } };
};

const ok = (reply) => reply && !reply.error;
const pictureOf = (e) => ({ allGuests: e.allGuests, guest: e.guest, providers: e.providers, guests: e.guests });

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("llm", "spending", {})),
  },
}).createMachine({
  id: "guest-limits",
  meta: {
    description:
      "The Limits and Guest keys parts of Administration, shown only to the admin, laid " +
      "out like Settings: a name on the left, its control on the right. Limits are in " +
      "dollars and counted since the start: each guest in total, all guests in total, " +
      "and each provider for all guests, which starts with no own limit. A note says " +
      "the prices used. Guest keys are one per provider, entered like the keys on the " +
      "Settings tab, with Key saved, Replace and Remove; guests spend only on these, " +
      "and a provider without a guest key is not offered to guests. Every change " +
      "applies at once, except Remove on a key: the row reads Key removed with an Undo " +
      "and a bar draining the undo window, and the key is removed only when the window " +
      "ends; leaving the page before then keeps it. A gesture made while the part is " +
      "reading its data again is still applied.",
    kind: "view",
    emits: ["limits.edited", "guestkeys.edited"],
    attributes: [],
    asks: ["llm: spending"],
  },
  // `removing` names the providers whose key waits out the undo window (12, forgiveness);
  // `removed` those whose removal went out and whose new picture has not come yet, so
  // the row does not read Key saved in between.
  context: ({ input }) => ({ ask: input.ask, undoMs: input.undoMs ?? 3000, spending: null, failed: false, removing: [], removed: [] }),
  initial: "hidden",
  states: {
    hidden: { on: { _shown: "reading" } },
    reading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: assign(({ event }) =>
            ok(event.output) ? { spending: pictureOf(event.output), failed: false, removed: [] } : { failed: true },
          ),
        },
        onError: { target: "ready", actions: assign({ failed: true }) },
      },
    },
    ready: {
      on: {
        _shown: "reading",
      },
    },
  },
  // The gestures are handled in every state, so one made while the part reads its data
  // again (each time it comes into view) is never dropped.
  on: {
    "spending.changed": { actions: assign({ spending: ({ event }) => pictureOf(event), failed: false, removed: [] }) },
    _setLimit: {
      guard: ({ context, event }) => limitEdit(context.spending, event.field, event.text) !== null,
      actions: emit(({ context, event }) => ({
        type: "limits.edited",
        ...limitEdit(context.spending, event.field, event.text),
      })),
    },
    // A guest key goes out in the gesture only; it never enters context (7.2).
    _saveKey: {
      guard: ({ event }) => typeof event.key === "string" && event.key.trim() !== "",
      actions: emit(({ event }) => ({ type: "guestkeys.edited", [event.provider]: event.key.trim() })),
    },
    // Remove waits out the undo window; nothing is emitted until it ends.
    _removeKey: {
      guard: ({ context, event }) => typeof event.provider === "string" && !context.removing.includes(event.provider),
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.assign({ removing: [...context.removing, event.provider] });
        enqueue.raise({ type: "_removeElapsed", provider: event.provider }, { delay: context.undoMs, id: `remove:${event.provider}` });
      }),
    },
    _undoRemove: {
      guard: ({ context, event }) => context.removing.includes(event.provider),
      actions: enqueueActions(({ context, event, enqueue }) => {
        enqueue.cancel(`remove:${event.provider}`);
        enqueue.assign({ removing: context.removing.filter((p) => p !== event.provider) });
      }),
    },
    _removeElapsed: {
      guard: ({ context, event }) => context.removing.includes(event.provider),
      actions: [
        assign({
          removing: ({ context, event }) => context.removing.filter((p) => p !== event.provider),
          removed: ({ context, event }) => [...context.removed, event.provider],
        }),
        emit(({ event }) => ({ type: "guestkeys.edited", [event.provider]: "" })),
      ],
    },
  },
});
