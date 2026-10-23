import { setup, assign, emit, fromPromise } from "xstate";

// A view component (3.1): the connect page of the web edition, which the Mac app opens
// in the user's browser to connect to an account (3.4). It owns no fact: who is signed
// in belongs to `session`, reached by session: read for the starting picture and
// session.changed after (4.3, fourth rule); whether the account may connect and the
// one-time code are session's answers too. The page's address carries the Mac's PKCE
// challenge, its state and its port; the code goes back only to the Mac's own server
// on the loopback address. The address, the ask and leaving the page arrive through
// `input`, so the machine imports in Node.

// The Mac app's fixed port (mac/src-tauri), used when the address names none.
export const MAC_PORT = 47321;
// RFC 7636: a challenge is unpadded base64url; a state is any short opaque token.
const CHALLENGE = /^[A-Za-z0-9_~.-]{43,128}$/;
const STATE = /^[A-Za-z0-9_~.-]{8,256}$/;

// What the address asks for, or null when it is not a whole connect link. The port is
// a whole number from 1 to 65535: the code only ever goes to 127.0.0.1 on it.
export const paramsOf = (search) => {
  const q = new URLSearchParams(search || "");
  const challenge = q.get("challenge") ?? "";
  const state = q.get("state") ?? "";
  const port = q.get("port") ?? String(MAC_PORT);
  if (!CHALLENGE.test(challenge) || !STATE.test(state) || !/^[0-9]{1,5}$/.test(port)) return null;
  const number = Number(port);
  if (number < 1 || number > 65535) return null;
  return { challenge, state, port: number };
};

// The Mac's own server, on the loopback address and nowhere else (3.4).
export const finishUrl = (params, answer) =>
  `http://127.0.0.1:${params.port}/api/session/connect/finish?` + new URLSearchParams({ ...answer, state: params.state });

const who = (picture) => ({
  userId: picture.userId ?? null,
  guest: picture.guest === true,
  name: typeof picture.name === "string" ? picture.name : null,
});
const adopt = assign(({ event }) => who(event));

// Every state that shows the account follows session's news (4.3, fourth rule).
const follows = { "session.changed": { target: "#device-connect.deciding", actions: adopt } };

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("session", "read", {})),
    allowed: fromPromise(({ input }) => input.ask("session", "connect", {})),
    code: fromPromise(({ input }) => input.ask("session", "connectCode", { challenge: input.challenge })),
  },
}).createMachine({
  id: "device-connect",
  meta: {
    description:
      "The connect page of app.unblent.com, which the Mac app opens in the user's browser to " +
      "connect to an account (3.4). Signed out, it says Connect your Mac and offers Sign in with " +
      "passkey. Signed in to an account whose Can sync is on, it asks Connect this Mac to and the " +
      "account's name, with Cancel and Connect, and Not you? Sign out under them. Connect sends " +
      "a one-time code back to the Mac app's own server on this computer, and Cancel tells the " +
      "Mac app nothing was connected; either way the browser leaves for the Mac app. An account " +
      "whose Can sync is off, or a guest, sees Sync is not turned on for this account, with no " +
      "Connect. A link without the Mac's details says to start again from the Mac app.",
    kind: "view",
    emits: ["signin.requested", "signout.requested"],
    attributes: [],
    asks: ["session: read", "session: connect", "session: connectCode"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    go: input.go,
    params: paramsOf(input.search),
    userId: null,
    guest: false,
    name: null,
    problem: null,
  }),
  initial: "start",
  states: {
    start: {
      always: [{ guard: ({ context }) => !context.params, target: "broken" }, { target: "loading" }],
    },
    // The address is not a whole connect link: nothing can be sent to the Mac.
    broken: {},
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output?.error), target: "failed" },
          { target: "deciding", actions: assign(({ event }) => who(event.output)) },
        ],
        onError: { target: "failed" },
      },
      on: follows,
    },
    deciding: {
      always: [
        { guard: ({ context }) => !context.userId, target: "signedOut" },
        { guard: ({ context }) => context.guest, target: "off" },
        { target: "checking" },
      ],
    },
    checking: {
      invoke: {
        src: "allowed",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => Boolean(event.output?.error), target: "failed" },
          { guard: ({ event }) => event.output.allowed === true, target: "ready", actions: assign({ problem: null }) },
          { target: "off" },
        ],
        onError: { target: "failed" },
      },
      on: follows,
    },
    signedOut: {
      on: {
        ...follows,
        // Leading underscore (7.2): the user's click; session decides (4.3, fifth rule).
        _signIn: { actions: emit({ type: "signin.requested" }) },
      },
    },
    ready: {
      on: {
        ...follows,
        _connect: { target: "connecting" },
        _cancel: {
          target: "leaving",
          actions: ({ context }) => context.go(finishUrl(context.params, { error: "cancelled" })),
        },
        _signOut: { actions: emit({ type: "signout.requested" }) },
      },
    },
    connecting: {
      invoke: {
        src: "code",
        input: ({ context }) => ({ ask: context.ask, challenge: context.params.challenge }),
        onDone: [
          {
            guard: ({ event }) => typeof event.output?.code === "string",
            target: "leaving",
            actions: ({ context, event }) => context.go(finishUrl(context.params, { code: event.output.code })),
          },
          { guard: ({ event }) => event.output?.error === "sync-off", target: "off" },
          { guard: ({ event }) => event.output?.error === "signed-out", target: "deciding", actions: assign({ userId: null }) },
          { target: "ready", actions: assign({ problem: "unavailable" }) },
        ],
        onError: { target: "ready", actions: assign({ problem: "unavailable" }) },
      },
    },
    off: {
      on: {
        ...follows,
        _signOut: { actions: emit({ type: "signout.requested" }) },
      },
    },
    failed: {
      on: {
        ...follows,
        _retry: { target: "loading" },
      },
    },
    // The browser is on its way to the Mac's own server.
    leaving: {},
  },
});
