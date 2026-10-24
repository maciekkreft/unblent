import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the Account tab of the Mac app, where the Mac is connected to
// an account on app.unblent.com and disconnected from it (3.4). It owns no fact: whether
// the Mac is connected belongs to `session`, reached by session: read for the starting
// picture and session.changed after (4.3, fourth rule), and every gesture goes to
// session as an event (4.3, fifth rule). Only waiting for Safari is its own state: the
// server says off until the user has finished there. The ask arrives through `input`,
// so the machine imports in Node.

// Coming back to the window without having finished in Safari: how long the tab keeps
// saying Waiting after the window regains focus, so session's look at the server can
// bring a ready sign-in first.
export const BACK_MS = 2000;

const picture = (p) => ({
  connect: ["off", "ready", "on"].includes(p?.connect) ? p.connect : null,
  remote: typeof p?.remote === "string" ? p.remote : null,
  userId: typeof p?.userId === "string" ? p.userId : null,
});
const adopt = assign(({ event }) => picture(event));

// Every state that shows the connection follows session's news; a change of account
// already under way (leaving) is not news for the tab.
const follows = {
  "session.changed": [
    { guard: ({ event }) => event.leaving === true },
    { target: "#mac-account.deciding", actions: adopt },
  ],
};

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
}).createMachine({
  id: "mac-account",
  meta: {
    description:
      "The Account tab of the gear's sheet in the Mac app, where the Mac is connected to an " +
      "account on app.unblent.com and disconnected from it (3.4). It shows nothing outside the " +
      "Mac app. Not connected, it says everything is kept on this Mac only and offers Connect " +
      "account, which opens the connect page in Safari; it then says Waiting for you to finish " +
      "in Safari, with Open Safari again and Cancel, until the user comes back to the window. " +
      "When the account's sign-in is ready, it asks Connect this Mac to and the account's " +
      "name, saying that if the account already has notes, journal days or books the Mac will " +
      "show them, and if it is empty the Mac's are added to it; there is no choice to make, " +
      "only Connect, or Cancel, which forgets the sign-in. Connected, it says Connected to and " +
      "the account's name, with Disconnect, which stops syncing while the Mac keeps what it " +
      "shows. If what is not yet sent cannot be sent within a few seconds, nothing changes, " +
      "the tab says changes are waiting on this Mac, and a notice says why. When the admin has " +
      "turned sync off for the account, it says Sync was turned off for this account, and " +
      "Disconnect is shown greyed out with the reason: the account's books could not be " +
      "fetched, so sync must be turned on again for this account in Administration on " +
      "app.unblent.com before this Mac can disconnect. Nothing waiting on the Mac is thrown " +
      "away meanwhile.",
    kind: "view",
    attributes: [],
    emits: ["connect.requested", "connect.confirmed", "disconnect.requested"],
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    connect: null,
    remote: null,
    userId: null,
    // A Disconnect that session refused because changes could not be sent (12).
    waiting: false,
    disconnecting: false,
    // What the tab is waiting on while session works: connect, cancel or disconnect.
    doing: null,
  }),
  initial: "loading",
  on: {
    // session announces the change it could not make right after it stops leaving.
    "session.refused": {
      guard: ({ context, event }) => context.disconnecting && event.reason === "unsent",
      actions: assign({ waiting: true, disconnecting: false }),
    },
  },
  states: {
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { target: "deciding", actions: assign(({ event }) => picture(event.output)) },
        onError: { target: "hidden" },
      },
      on: follows,
    },
    deciding: {
      always: [
        { guard: ({ context }) => !context.connect, target: "hidden" },
        { guard: ({ context }) => context.connect === "ready", target: "choosing" },
        { guard: ({ context }) => context.connect === "on" && !context.userId, target: "syncOff" },
        { guard: ({ context }) => context.connect === "on", target: "connected" },
        { target: "notConnected" },
      ],
    },
    // Not the local edition: the tab shows nothing.
    hidden: { on: follows },
    notConnected: {
      on: {
        ...follows,
        // Leading underscore (7.2): the user's click, which session acts on.
        _connect: { target: "waiting", actions: emit({ type: "connect.requested" }) },
      },
    },
    waiting: {
      initial: "away",
      on: {
        "session.changed": [
          { guard: ({ event }) => event.leaving === true },
          // Still off: the user is still in Safari, as far as anyone knows.
          { guard: ({ event }) => picture(event).connect === "off", actions: adopt },
          { target: "#mac-account.deciding", actions: adopt },
        ],
        // The connect page could not be named, so Safari was not opened.
        "session.refused": { target: "notConnected" },
        _again: { actions: emit({ type: "connect.requested" }) },
        _cancel: { target: "notConnected" },
      },
      states: {
        away: { on: { _focused: { target: "back" } } },
        // Back in the window: unless session finds the sign-in ready meanwhile, the user
        // did not finish, and Connect account is offered again.
        back: {
          after: { [BACK_MS]: { target: "#mac-account.notConnected" } },
          on: { _focused: { target: "back", reenter: true } },
        },
      },
    },
    choosing: {
      on: {
        ...follows,
        // Always with keep (12): after the reload each kind of thing is taken from the
        // account when it has some, and sent to it when it has none.
        _confirm: {
          target: "switching",
          actions: [assign({ doing: "connect" }), emit({ type: "connect.confirmed", keep: true })],
        },
        // Forgets the waiting sign-in; nothing on this Mac has changed yet.
        _cancel: { target: "switching", actions: [assign({ doing: "cancel" }), emit({ type: "disconnect.requested" })] },
      },
    },
    connected: {
      on: {
        ...follows,
        _disconnect: {
          target: "switching",
          actions: [assign({ waiting: false, disconnecting: true, doing: "disconnect" }), emit({ type: "disconnect.requested" })],
        },
      },
    },
    // No Disconnect (3.4): the Mac's server would refuse it, since the account's book
    // files could not be fetched for the Mac to keep.
    syncOff: { on: follows },
    // Until session reloads the page or says nothing changed.
    switching: {
      on: {
        ...follows,
        "session.refused": {
          target: "deciding",
          actions: assign(({ context, event }) =>
            context.disconnecting && event.reason === "unsent" ? { waiting: true, disconnecting: false } : { disconnecting: false },
          ),
        },
      },
    },
  },
});
