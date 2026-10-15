import { setup, assign, emit } from "xstate";

// A local-only fact component (3.1): what is pinned on this device. A view's pin button
// emits the gesture, pin.toggled (4.3, fifth rule); this is the one place the pins live,
// and every view that honours a pin asks pins: read for the starting picture and follows
// pins.changed (4.3, fourth rule). The store arrives through `input`, so the machine is a
// pure definition importable in Node.

const WHATS = ["note", "chat", "evaluators"];
const NONE = { note: null, chat: null, evaluators: null };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const idOrNull = (v) => (typeof v === "string" && ULID.test(v) ? v : null);

// A stored value from an older or damaged page reads as nothing pinned rather than
// failing the fact.
const parse = (stored) => {
  try {
    const v = JSON.parse(stored);
    return Object.fromEntries(WHATS.map((w) => [w, idOrNull(v?.[w])]));
  } catch {
    return { ...NONE };
  }
};

const changed = emit(({ context }) => ({ type: "pins.changed", ...context.pins }));

export const machine = setup({}).createMachine({
  id: "pins",
  meta: {
    description:
      "Owns what is pinned on this device: the note the note editor stays on, the chat that " +
      "stays open, and the book the Evaluators tab stays on, each while the subject changes. " +
      "A pin button sends which of the three it is and the id it now pins, or none to unpin; " +
      "pressing a pin again replaces what that pin held. The pins follow the device, not the " +
      "account, and survive a reload.",
    kind: "fact",
    shape: "local-only",
    emits: ["pins.changed"],
    owns: "what is pinned on this device: a note, a chat, and the book of the Evaluators tab",
  },
  context: ({ input }) => ({ pins: input.stored == null ? { ...NONE } : parse(input.stored), save: input.save }),
  on: {
    // Guarded so a repeat writes and announces nothing.
    "pin.toggled": {
      guard: ({ context, event }) => WHATS.includes(event.what) && context.pins[event.what] !== idOrNull(event.id),
      actions: [
        assign({ pins: ({ context, event }) => ({ ...context.pins, [event.what]: idOrNull(event.id) }) }),
        ({ context }) => context.save(JSON.stringify(context.pins)),
        changed,
      ],
    },
    "read?": { actions: ({ context, event }) => event.reply({ ...context.pins }) },
  },
});
