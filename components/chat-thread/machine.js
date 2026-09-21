import { setup, assign, fromPromise } from "xstate";

// The view that shows the open conversation (architecture.md 3.1): headless of the
// fact, it owns only its own UI state (the transcript scroll, which thinking records
// are open, a just-copied flash — all in the view). It asks `conversations` which chat
// is open and reads it for the starting picture (4.3), then follows the conversation
// events for everything after. The question box is a separate view shown through a
// default slot (6.3), so this component emits nothing. Everything with a side effect —
// the queries — arrives through input, so this stays a pure definition importable in
// Node.

// A conversation.changed payload is the whole conversation with a `type` on it; the
// read reply is the same shape without the `type`. One helper, so both feed the view
// the same object.
const asConversation = (event) => {
  const { type, ...rest } = event;
  return rest;
};

export const machine = setup({
  actors: {
    // The starting picture (4.3): which chat is open, then that chat. conversation.opened
    // is held for us until the open reply lands (open's supersededBy), and
    // conversation.changed until the read reply lands (read's supersededBy), so a change
    // that races the start is applied after it, in order.
    open: fromPromise(({ input }) => input.ask("conversations", "open", {})),
    read: fromPromise(({ input }) => input.ask("conversations", "read", { id: input.id })),
  },
}).createMachine({
  id: "chat-thread",
  meta: {
    kind: "view",
    attributes: ["height"],
    emits: [],
    asks: ["conversations: open", "conversations: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Which chat is open on this device, and its contents, or null when none is open.
    openId: null,
    conversation: null,
  }),
  initial: "starting",
  on: {
    // The open chat changed on this device (12): load the new one, or clear to the
    // empty page when nothing is open.
    "conversation.opened": [
      {
        guard: ({ event }) => event.id == null,
        target: ".empty",
        actions: assign({ openId: null, conversation: null }),
      },
      { target: ".loading", actions: assign({ openId: ({ event }) => event.id }) },
    ],
    // The fact's news about the open chat (4.3, fourth rule): adopt it whole. A change
    // for another chat is left to the bus to record as ignored. Held until the read
    // reply lands (4.2), so it never overtakes the starting picture.
    "conversation.changed": {
      guard: ({ context, event }) => event.id === context.openId,
      actions: assign({ conversation: ({ event }) => asConversation(event) }),
    },
    // The open chat was deleted (4.3): fall back to the empty page.
    "conversation.deleted": {
      guard: ({ context, event }) => event.id === context.openId,
      target: ".empty",
      actions: assign({ openId: null, conversation: null }),
    },
  },
  states: {
    starting: {
      invoke: {
        src: "open",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => event.output?.id == null, target: "empty" },
          { target: "loading", actions: assign({ openId: ({ event }) => event.output.id }) },
        ],
        onError: "empty",
      },
    },
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.openId }),
        onDone: [
          {
            guard: ({ event }) => "conversation" in event.output,
            target: "showing",
            actions: assign({ conversation: ({ event }) => event.output.conversation }),
          },
          { guard: ({ event }) => event.output.error === "unavailable", target: "unavailable" },
          // A chat the server has no record of is an empty new chat (12): the empty page.
          { target: "empty", actions: assign({ conversation: null }) },
        ],
        onError: "unavailable",
      },
    },
    // The chat is on screen; conversation.changed keeps it current from the root.
    showing: {},
    // No chat is open, or an id with no record: the transcript is blank and the box
    // invites a first message.
    empty: {},
    // The server could not be reached (5): the chat says so.
    unavailable: {},
  },
});
