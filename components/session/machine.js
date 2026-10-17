import { setup, assign, emit, enqueueActions, fromPromise } from "xstate";

// The fact component that owns the signed-in user (3.4): headless, the single
// place identity lives in the browser. It answers session: read from a cache,
// emits session.changed when the user changes and session.refused when a gesture
// cannot be honoured (12). Replicated (5): the cache is local, the truth is the
// server it reaches through `api`; while nobody is signed in a replicated fact's
// outbox does not drain, and sign-in starts it. Everything with a side effect —
// the WebAuthn ceremony, the fetches, the clock, the store — arrives through
// `input`, so this stays a pure definition importable in Node.

const clean = (value) => {
  const v = value && typeof value === "object" ? value : {};
  return {
    userId: typeof v.userId === "string" ? v.userId : null,
    // Optimistic until the server answers: a fresh visitor (no cache) is assumed
    // able to create an account, so the switch offers it without waiting on the
    // first revalidation; a cached false (a full registry seen earlier) is kept.
    registrationOpen: v.registrationOpen !== false,
    // The one thing that must survive a reload while offline (5): a sign-out the
    // server has not yet acknowledged, so the next revalidation retries it.
    logoutOwed: v.logoutOwed === true,
    // What the account is (3.4), kept with the id so a reload shows it offline.
    guest: v.userId != null && v.guest === true,
    admin: v.userId != null && v.admin === true,
    name: v.userId != null && typeof v.name === "string" ? v.name : null,
  };
};

// What the account is, from a server answer: absent flags read as false (3.4).
const account = (answer) => ({
  guest: answer.userId != null && answer.guest === true,
  admin: answer.userId != null && answer.admin === true,
  name: answer.userId != null && typeof answer.name === "string" ? answer.name : null,
});

// The session as session: read answers it and session.changed carries it. guest,
// admin and name ride only when they say something, so an ordinary account's
// picture is the same as before guests existed.
const picture = (c) => ({
  userId: c.userId,
  registrationOpen: c.registrationOpen,
  ...(c.guest ? { guest: true } : {}),
  ...(c.admin ? { admin: true } : {}),
  ...(c.name ? { name: c.name } : {}),
});
const changed = (c) => ({ type: "session.changed", ...picture(c) });

const parse = (stored) => {
  try {
    return clean(JSON.parse(stored));
  } catch {
    return clean(null);
  }
};

const persist = ({ context }) =>
  context.save(
    JSON.stringify({
      userId: context.userId,
      registrationOpen: context.registrationOpen,
      logoutOwed: context.logoutOwed,
      guest: context.guest,
      admin: context.admin,
      name: context.name,
    }),
  );

export const machine = setup({
  actors: {
    // Sign in. Prefer an existing passkey so a shared one signs into its account
    // instead of minting a duplicate on a second device (5); register only when
    // nothing can sign in and a slot is free. cancelled covers both an empty
    // prompt and a user cancel (WebAuthn conflates them, 12); unknown-credential
    // is a passkey the registry no longer holds — either, with a slot, means no
    // account, so create. unavailable is a network fault, not a missing account,
    // so it is left to refuse. Returns { userId, registrationOpen } or { error }.
    authenticate: fromPromise(async ({ input }) => {
      const result = await input.api.login();
      if (!result.error) return result;
      const recoverable = result.error === "cancelled" || result.error === "unknown-credential";
      if (recoverable && input.registrationOpen) return input.api.register();
      return result;
    }),
    // Make a guest on the server (3.4). Returns the session picture or { error }.
    makeGuest: fromPromise(({ input }) => input.api.guest()),
    // Clear the session on the server. Returns { error } when it could not (offline).
    logout: fromPromise(({ input }) => input.api.logout()),
    // Who am I, per the server. When a sign-out is owed, retry it first and report
    // whether it was acknowledged, so a still-signed-in answer can be ignored.
    revalidate: fromPromise(async ({ input }) => {
      let loggedOutAck = false;
      if (input.logoutOwed) loggedOutAck = !(await input.api.logout()).error;
      return { me: await input.api.me(), loggedOutAck };
    }),
  },
}).createMachine({
  id: "session",
  meta: {
    description:
      "Owns who is signed in. Signing in and registering use passkeys, and the server sets a " +
      "cookie the browser code never sees, so this fact asks its own server who the user is. " +
      "Instead of an outbox it keeps a copy of the answer on the device and owes the server a " +
      "sign-out made while offline. Registration closes once the number of users reaches " +
      "`MAX_USERS`, and a refused sign-in or registration is announced so a notice can show it. " +
      "On a try page, the first thing that needs the server makes a guest: an account with no " +
      "passkey, named Guest 1, Guest 2 and so on, which does not count toward `MAX_USERS`. The " +
      "account registered first with a passkey is the admin, named Admin; only the admin may " +
      "list the people, with when each was first and last seen, where from and on what, and " +
      "the space their work takes.",
    kind: "fact",
    shape: "replicated",
    emits: ["session.changed", "session.refused", "people.changed"],
    owns: "the signed-in user",
  },
  context: ({ input }) => ({
    ...parse(input.stored),
    api: input.api,
    save: input.save,
    // Only a try page may make a guest (3.4, 8); fact.js reads it from the address.
    tryPage: input.tryPage === true,
    // Replies owed to guest? asks, answered together once the guest exists, so two
    // facts asking at once make one guest.
    guestAsks: [],
  }),
  initial: "ready",
  on: {
    // Planned (9, step 1): View as is a later step, and does nothing until it is built.
    "viewas.requested": { actions: () => {} },
    // Query for the starting picture (4.3): answered from the cache at once, before
    // any network, so a view mounts without waiting on the server.
    "read?": {
      actions: ({ context, event }) => event.reply(picture(context)),
    },
    // Asked by the fact that first needs the server on a try page (3.4). An account
    // already held is the answer; otherwise the ask waits until ready can make one.
    "guest?": {
      actions: enqueueActions(({ context, event, enqueue }) => {
        if (context.userId) return event.reply(picture(context));
        if (!context.tryPage) return event.reply({ error: "not-a-try-page" });
        enqueue.assign({ guestAsks: [...context.guestAsks, event.reply] });
      }),
    },
    // Only the admin sees across accounts (12). The server decides; the cache only
    // spares everyone else a request that would be refused.
    "people?": {
      actions: ({ context, event }) => {
        if (!context.userId || !context.admin) return event.reply({ error: "not-admin" });
        Promise.resolve()
          .then(() => context.api.people())
          .then(event.reply, () => event.reply({ error: "unavailable" }));
      },
    },
  },
  states: {
    ready: {
      // Asks that waited while a ceremony or a revalidation ran: answered with the
      // account it found, or a guest is made now.
      always: [
        {
          guard: ({ context }) => context.guestAsks.length > 0 && Boolean(context.userId),
          actions: [
            ({ context }) => context.guestAsks.forEach((reply) => reply(picture(context))),
            assign({ guestAsks: [] }),
          ],
        },
        { guard: ({ context }) => context.guestAsks.length > 0, target: "guesting" },
      ],
      on: {
        // The gesture from session-switch (4.3, fifth rule).
        "signin.requested": { target: "authing" },
        // Sign out is local-first (5): announce it at once so the UI flips, mark it
        // owed, then tell the server. An offline logout is retried on revalidation.
        "signout.requested": {
          guard: ({ context }) => Boolean(context.userId),
          actions: [
            assign({ userId: null, logoutOwed: true, guest: false, admin: false, name: null }),
            persist,
            emit(({ context }) => changed(context)),
          ],
          target: "deauthing",
        },
        // Internal (7.2): sent by fact.js on mount and when the tab regains focus.
        _revalidate: { target: "revalidating" },
        // A fact's request was rejected by the server as unauthenticated (books emits
        // session.rejected on a 401): the cookie is gone though this cache still reads
        // signed in. Re-check now, rather than waiting for the next focus, so the auth
        // control flips at once (4.3, fourth rule). Only when we think we are signed in;
        // a stray one while already signed out needs no round trip.
        "session.rejected": { guard: ({ context }) => Boolean(context.userId), target: "revalidating" },
      },
    },
    authing: {
      invoke: {
        src: "authenticate",
        input: ({ context }) => ({
          api: context.api,
          registrationOpen: context.registrationOpen,
        }),
        onDone: [
          {
            guard: ({ event }) => Boolean(event.output.error),
            target: "ready",
            actions: emit(({ event }) => ({ type: "session.refused", reason: event.output.error })),
          },
          {
            target: "ready",
            actions: [
              assign(({ event }) => ({
                userId: event.output.userId,
                registrationOpen: event.output.registrationOpen === true,
                logoutOwed: false,
                ...account(event.output),
              })),
              persist,
              emit(({ context }) => changed(context)),
            ],
          },
        ],
        onError: {
          target: "ready",
          actions: emit({ type: "session.refused", reason: "unavailable" }),
        },
      },
    },
    guesting: {
      invoke: {
        src: "makeGuest",
        input: ({ context }) => ({ api: context.api }),
        onDone: [
          {
            guard: ({ event }) => Boolean(event.output.error) || !event.output.userId,
            target: "ready",
            actions: [
              ({ context }) => context.guestAsks.forEach((reply) => reply({ error: "unavailable" })),
              assign({ guestAsks: [] }),
            ],
          },
          {
            target: "ready",
            actions: [
              assign(({ event }) => ({
                userId: event.output.userId,
                registrationOpen: event.output.registrationOpen === true,
                logoutOwed: false,
                ...account(event.output),
              })),
              persist,
              emit(({ context }) => changed(context)),
              ({ context }) => context.guestAsks.forEach((reply) => reply(picture(context))),
              assign({ guestAsks: [] }),
            ],
          },
        ],
        onError: {
          target: "ready",
          actions: [
            ({ context }) => context.guestAsks.forEach((reply) => reply({ error: "unavailable" })),
            assign({ guestAsks: [] }),
          ],
        },
      },
    },
    deauthing: {
      invoke: {
        src: "logout",
        input: ({ context }) => ({ api: context.api }),
        // Acknowledged: the sign-out is no longer owed. session.changed was already
        // emitted when the gesture arrived, so nothing more is announced here.
        onDone: [
          {
            guard: ({ event }) => !event.output.error,
            target: "ready",
            actions: [assign({ logoutOwed: false }), persist],
          },
          // The server refused/was offline: keep owing it, retried on revalidation.
          { target: "ready" },
        ],
        onError: { target: "ready" },
      },
    },
    revalidating: {
      invoke: {
        src: "revalidate",
        input: ({ context }) => ({ api: context.api, logoutOwed: context.logoutOwed }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            const { me, loggedOutAck } = event.output;
            // Offline or 5xx: keep the cached picture untouched (no news).
            if (me.error) return;
            const registrationOpen = me.registrationOpen === true;
            const now = account(me);
            if (context.logoutOwed) {
              // A sign-out is owed: never adopt a still-signed-in answer. If the
              // retry was acknowledged, stop owing; otherwise keep owing. userId is
              // already null, so session.changed was announced when the gesture
              // arrived — nothing more is emitted here.
              enqueue.assign({ registrationOpen, logoutOwed: !loggedOutAck });
              enqueue(persist);
              return;
            }
            // No sign-out owed: adopt the server's picture, announcing any change —
            // a different user (a sign-in or sign-out on another device, 5) or a
            // registrationOpen the switch must relabel on (a full install seen for
            // the first time: "Create account" → "Sign in", 4.3 fourth rule).
            // An account turning into the admin, or its name arriving, is news too.
            const userChanged = me.userId !== context.userId;
            const regChanged = registrationOpen !== context.registrationOpen;
            const accountChanged =
              now.guest !== context.guest || now.admin !== context.admin || now.name !== context.name;
            enqueue.assign({ registrationOpen, userId: me.userId, ...now });
            if (userChanged || regChanged || accountChanged) {
              enqueue.emit(changed({ userId: me.userId, registrationOpen, ...now }));
            }
            enqueue(persist);
          }),
        },
        onError: { target: "ready" },
      },
    },
  },
});
