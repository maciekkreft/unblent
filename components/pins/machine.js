import { setup, assign, enqueueActions, fromPromise } from "xstate";

// A local-only fact component (3.1): what is pinned on this device. A view's pin button
// emits the gesture, pin.toggled (4.3, fifth rule); this is the one place the pins live,
// and every view that honours a pin asks pins: read for the starting picture and follows
// pins.changed (4.3, fourth rule). A pin names one account's note, chat or book, so each
// account on this browser keeps its own pins (12): it asks session: read for who is signed
// in and follows session.changed. The store and the ask arrive through `input`, so the
// machine is a pure definition importable in Node.

const WHATS = ["note", "chat", "evaluators"];
const NONE = { note: null, chat: null, evaluators: null };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// The key of the pins kept while no one is signed in.
const SIGNED_OUT = "";
// The key of pins stored before they were kept per account; the first account seen takes them.
const EARLIER = "*";

const idOrNull = (v) => (typeof v === "string" && ULID.test(v) ? v : null);
const pinsOf = (v) => Object.fromEntries(WHATS.map((w) => [w, idOrNull(v?.[w])]));

// The stored value, one set of pins per account. A flat value from before is kept under
// EARLIER; one from an older or damaged page reads as nothing pinned rather than failing
// the fact.
const parse = (stored) => {
  try {
    const v = JSON.parse(stored);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    if (WHATS.some((w) => w in v)) return { [EARLIER]: pinsOf(v) };
    return Object.fromEntries(Object.entries(v).map(([account, pins]) => [account, pinsOf(pins)]));
  } catch {
    return {};
  }
};

const accountOf = (picture) => (typeof picture?.userId === "string" && picture.userId ? picture.userId : SIGNED_OUT);

// Switches to one account's pins. The pins kept from before were the browser's owner's,
// so they go to the first account seen that the admin is not only viewing as (12).
function become(context, account, viewing, enqueue) {
  const { [EARLIER]: earlier, ...all } = context.all;
  if (!earlier || viewing) {
    const pins = context.all[account] ?? { ...NONE };
    enqueue.assign({ account, pins });
    return pins;
  }
  const pins = all[account] ?? earlier;
  const next = { ...all, [account]: pins };
  enqueue.assign({ all: next, account, pins });
  enqueue(() => context.save(JSON.stringify(next)));
  return pins;
}

function toggle(context, event, enqueue) {
  if (!WHATS.includes(event.what) || context.pins[event.what] === idOrNull(event.id)) return;
  const pins = { ...context.pins, [event.what]: idOrNull(event.id) };
  const all = { ...context.all, [context.account]: pins };
  enqueue.assign({ pins, all });
  enqueue(() => context.save(JSON.stringify(all)));
  enqueue.emit({ type: "pins.changed", ...pins });
}

// Another account now holds the browser; the news that it is about to (leaving) is not it.
function follow(context, event, enqueue) {
  if (event.leaving === true) return;
  const account = accountOf(event);
  if (account === context.account) return;
  const pins = become(context, account, Boolean(event.viewingAs), enqueue);
  enqueue.emit({ type: "pins.changed", ...pins });
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

export const machine = setup({
  actors: {
    // Asked as this fact mounts, so a page loads session's fact.js before this one; a page
    // without session is answered no-answerer, and its pins are the signed-out ones.
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
}).createMachine({
  id: "pins",
  meta: {
    description:
      "Owns what is pinned on this device: the note the note editor stays on, the chat that " +
      "stays open, and the book the Evaluators tab stays on, each while the subject changes. " +
      "A pin button sends which of the three it is and the id it now pins, or none to unpin; " +
      "pressing a pin again replaces what that pin held. The pins follow the device and the " +
      "account: each account signed in on this browser has its own, so while the admin views " +
      "as someone the pins are that account's, and Back to you brings the admin's back. They " +
      "survive a reload.",
    kind: "fact",
    shape: "local-only",
    emits: ["pins.changed"],
    asks: ["session: read"],
    owns: "what is pinned on this device: a note, a chat, and the book of the Evaluators tab",
  },
  context: ({ input }) => ({
    all: input.stored == null ? {} : parse(input.stored),
    account: SIGNED_OUT,
    pins: { ...NONE },
    save: input.save,
    ask: input.ask,
    queued: [],
  }),
  initial: "loading",
  states: {
    // Who is signed in comes first, so the first read already answers that account's pins.
    loading: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => become(context, accountOf(event.output), Boolean(event.output?.viewingAs), enqueue)),
        },
        onError: {
          target: "ready",
          actions: enqueueActions(({ context, enqueue }) => become(context, SIGNED_OUT, false, enqueue)),
        },
      },
      on: { "read?": { actions: queue }, "pin.toggled": { actions: queue }, "session.changed": { actions: queue } },
    },
    ready: {
      entry: enqueueActions(({ context, enqueue }) => {
        for (const message of context.queued) enqueue.raise(message);
        enqueue.assign({ queued: [] });
      }),
      on: {
        // Guarded inside, so a repeat writes and announces nothing.
        "pin.toggled": { actions: enqueueActions(({ context, event, enqueue }) => toggle(context, event, enqueue)) },
        "session.changed": { actions: enqueueActions(({ context, event, enqueue }) => follow(context, event, enqueue)) },
        "read?": { actions: ({ context, event }) => event.reply({ ...context.pins }) },
      },
    },
  },
});
