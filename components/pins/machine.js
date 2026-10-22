import { setup, assign, enqueueActions, fromPromise } from "xstate";

// A local-only fact component (3.1): what is pinned on this device. A view's pin button
// emits the gesture, pin.toggled (4.3, fifth rule); this is the one place the pins live,
// and every view that honours a pin asks pins: read for the starting picture and follows
// pins.changed (4.3, fourth rule). A pin names one account's note, chat or book, so each
// account on this browser keeps its own pins (12): it asks session: read for who is signed
// in and follows session.changed. The store and the ask arrive through `input`, so the
// machine is a pure definition importable in Node.
//
// A pin is on until the user turns it off, and an "off" is remembered. While a pin is on
// it holds what its panel is showing, so pins learns that from the panels' own news
// (note.opened, conversation.opened) and from the stage (the subject's book, for the
// Evaluators tab).

const WHATS = ["note", "chat", "evaluators"];
const NONE = { note: null, chat: null, evaluators: null };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// The key of the pins kept while no one is signed in.
const SIGNED_OUT = "";
// The key of pins stored before they were kept per account; the first account seen takes them.
const EARLIER = "*";

const idOrNull = (v) => (typeof v === "string" && ULID.test(v) ? v : null);
const pinsOf = (v) => Object.fromEntries(WHATS.map((w) => [w, idOrNull(v?.[w])]));
// The pins the user turned off, kept beside the ids and written only when there is one;
// a value without it reads as every pin on.
const offOf = (v) => (Array.isArray(v?.off) ? WHATS.filter((w) => v.off.includes(w)) : []);
const recordOf = (v) => ({ ...pinsOf(v), off: offOf(v) });
const storedOf = ({ off, ...pins }) => (off.length ? { ...pins, off } : pins);
const bookOf = (subject) => (subject?.kind === "book" ? idOrNull(subject.id) : null);

// The stored value, one set of pins per account. A flat value from before is kept under
// EARLIER; one from an older or damaged page reads as nothing pinned rather than failing
// the fact.
const parse = (stored) => {
  try {
    const v = JSON.parse(stored);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    if (WHATS.some((w) => w in v)) return { [EARLIER]: recordOf(v) };
    return Object.fromEntries(Object.entries(v).map(([account, pins]) => [account, recordOf(pins)]));
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
    const { off, ...pins } = context.all[account] ?? { ...NONE, off: [] };
    enqueue.assign({ account, pins, off });
    return pins;
  }
  const record = all[account] ?? earlier;
  const next = { ...all, [account]: record };
  const { off, ...pins } = record;
  enqueue.assign({ all: next, account, pins, off });
  enqueue(() => context.save(save(next)));
  return pins;
}

const save = (all) => JSON.stringify(Object.fromEntries(Object.entries(all).map(([account, record]) => [account, storedOf(record)])));

// Writes the current account's pins and off list, announcing only when a pin changed.
function put(context, pins, off, enqueue) {
  const changed = WHATS.some((w) => pins[w] !== context.pins[w]);
  if (!changed && off.join() === context.off.join()) return;
  const all = { ...context.all, [context.account]: { ...pins, off } };
  enqueue.assign({ pins, off, all });
  enqueue(() => context.save(save(all)));
  if (changed) enqueue.emit({ type: "pins.changed", ...pins });
}

// The pin of the Evaluators tab holds a book; while it is on and holds none, it takes the
// book on the stage, which is the book the tab is showing.
const withBook = (pins, off, book) =>
  !off.includes("evaluators") && pins.evaluators == null && book != null ? { ...pins, evaluators: book } : pins;

// The user pressed a pin: an id turns it on there, null turns it off and is remembered.
function toggle(context, event, enqueue) {
  if (!WHATS.includes(event.what)) return;
  const id = idOrNull(event.id);
  const off = WHATS.filter((w) => (w === event.what ? id == null : context.off.includes(w)));
  const pins = withBook({ ...context.pins, [event.what]: id }, off, context.book);
  put(context, pins, off, enqueue);
}

// A panel now shows this note or chat, or nothing: an "on" pin follows it.
function shown(context, what, id, enqueue) {
  if (context.off.includes(what)) return;
  put(context, { ...context.pins, [what]: idOrNull(id) }, context.off, enqueue);
}

// What the pinned thing was is gone: the pin lets go of it, and stays on or off.
function gone(context, what, id, enqueue) {
  if (context.pins[what] == null || context.pins[what] !== id) return;
  const pins = withBook({ ...context.pins, [what]: null }, context.off, context.book === id ? null : context.book);
  put(context, pins, context.off, enqueue);
}

function onStage(context, subject, enqueue) {
  const book = bookOf(subject);
  enqueue.assign({ book });
  put(context, withBook(context.pins, context.off, book), context.off, enqueue);
}

// Another account now holds the browser; the news that it is about to (leaving) is not it.
function follow(context, event, enqueue) {
  if (event.leaving === true) return;
  const account = accountOf(event);
  if (account === context.account) return;
  const pins = become(context, account, Boolean(event.viewingAs), enqueue);
  enqueue.emit({ type: "pins.changed", ...pins });
}

const QUEUED = ["read?", "pin.toggled", "session.changed", "note.opened", "conversation.opened", "conversation.deleted", "subject.changed", "book.deleted"];

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

export const machine = setup({
  actors: {
    // Asked as this fact mounts, so a page loads session's fact.js before this one; a page
    // without session is answered no-answerer, and its pins are the signed-out ones.
    // The subject is asked beside it, for the book the Evaluators tab shows;
    // subject.changed is held for us until that reply lands (4.2).
    session: fromPromise(async ({ input }) => {
      const [session, subject] = await Promise.all([
        input.ask("session", "read", {}),
        input.ask("subject", "read", {}).catch(() => null),
      ]);
      return { ...session, subject: subject?.subject ?? null };
    }),
    // conversation.opened and conversation.deleted are held for us until this reply lands (4.2).
    chat: fromPromise(({ input }) => input.ask("conversations", "open", {})),
  },
}).createMachine({
  id: "pins",
  meta: {
    description:
      "Owns what is pinned on this device: the note the note editor stays on, the chat that " +
      "stays open, and the book the Evaluators tab stays on, each while the subject changes. " +
      "Every pin is on until the user turns it off, and stays off until the user turns it on " +
      "again: while on, it holds what its panel shows, the note the editor opened, the open " +
      "chat, or the book on the stage when the Evaluators tab has none yet. A pin button " +
      "sends which of the three it is and the id it now pins, or none to turn it off. " +
      "A note or chat that is deleted, or a book removed, lets go of its pin, which stays on " +
      "for the next one. The pins and which are off follow the device and the " +
      "account: each account signed in on this browser has its own, so while the admin views " +
      "as someone the pins are that account's, and Back to you brings the admin's back. They " +
      "survive a reload.",
    kind: "fact",
    shape: "local-only",
    emits: ["pins.changed"],
    asks: ["session: read", "subject: read", "conversations: open"],
    owns: "what is pinned on this device: a note, a chat, and the book of the Evaluators tab",
  },
  context: ({ input }) => ({
    all: input.stored == null ? {} : parse(input.stored),
    account: SIGNED_OUT,
    pins: { ...NONE },
    off: [],
    // The book on the stage, from subject: read and subject.changed.
    book: null,
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
          actions: enqueueActions(({ context, event, enqueue }) => {
            become(context, accountOf(event.output), Boolean(event.output?.viewingAs), enqueue);
            enqueue.assign({ book: bookOf(event.output.subject) });
          }),
        },
        onError: {
          target: "ready",
          actions: enqueueActions(({ context, enqueue }) => become(context, SIGNED_OUT, false, enqueue)),
        },
      },
      on: Object.fromEntries(QUEUED.map((type) => [type, { actions: queue }])),
    },
    ready: {
      entry: enqueueActions(({ context, enqueue }) => {
        put(context, withBook(context.pins, context.off, context.book), context.off, enqueue);
        for (const message of context.queued) enqueue.raise(message);
        enqueue.assign({ queued: [] });
      }),
      on: {
        // Guarded inside, so a repeat writes and announces nothing.
        "pin.toggled": { actions: enqueueActions(({ context, event, enqueue }) => toggle(context, event, enqueue)) },
        "session.changed": { actions: enqueueActions(({ context, event, enqueue }) => follow(context, event, enqueue)) },
        "read?": { actions: ({ context, event }) => event.reply({ ...context.pins }) },
        "note.opened": { actions: enqueueActions(({ context, event, enqueue }) => shown(context, "note", event.id, enqueue)) },
        "conversation.opened": { actions: enqueueActions(({ context, event, enqueue }) => shown(context, "chat", event.id, enqueue)) },
        "conversation.deleted": { actions: enqueueActions(({ context, event, enqueue }) => gone(context, "chat", event.id, enqueue)) },
        "book.deleted": { actions: enqueueActions(({ context, event, enqueue }) => gone(context, "evaluators", event.id, enqueue)) },
        "subject.changed": { actions: enqueueActions(({ context, event, enqueue }) => onStage(context, event.subject ?? null, enqueue)) },
      },
      // The chat open at the start, which `conversations` restores without announcing it.
      // A page mounts pins before `conversations`, which asks pins: read as it starts, so
      // the first ask may find no one; it is asked again at the next pins: read, which
      // comes once every fact on the page is mounted. A second no-answerer means the
      // page has no chats (the Mac page, section 8), so it is not asked again.
      initial: "askingChat",
      states: {
        askingChat: {
          invoke: {
            src: "chat",
            input: ({ context }) => ({ ask: context.ask }),
            onDone: [
              { guard: ({ event }) => event.output?.error === "no-answerer", target: "chatUnasked" },
              {
                target: "chatKnown",
                actions: enqueueActions(({ context, event, enqueue }) => {
                  if (event.output && "id" in event.output) shown(context, "chat", event.output.id, enqueue);
                }),
              },
            ],
            onError: "chatKnown",
          },
        },
        chatUnasked: {
          on: { "read?": { target: "askingChatAgain", actions: ({ context, event }) => event.reply({ ...context.pins }) } },
        },
        askingChatAgain: {
          invoke: {
            src: "chat",
            input: ({ context }) => ({ ask: context.ask }),
            onDone: {
              target: "chatKnown",
              actions: enqueueActions(({ context, event, enqueue }) => {
                if (event.output && "id" in event.output) shown(context, "chat", event.output.id, enqueue);
              }),
            },
            onError: "chatKnown",
          },
        },
        chatKnown: {},
      },
    },
  },
});
