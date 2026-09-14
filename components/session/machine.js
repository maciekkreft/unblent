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
  };
};

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
    }),
  );

export const machine = setup({
  actors: {
    // Sign in: register while a slot is free and nobody is signed in, else log in
    // (the plan's one decision, on the cached picture). Returns { userId,
    // registrationOpen } or { error }.
    authenticate: fromPromise(({ input }) =>
      input.registrationOpen && !input.userId ? input.api.register() : input.api.login(),
    ),
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
    kind: "fact",
    shape: "replicated",
    emits: ["session.changed", "session.refused"],
    owns: "the signed-in user",
  },
  context: ({ input }) => ({ ...parse(input.stored), api: input.api, save: input.save }),
  initial: "ready",
  on: {
    // Query for the starting picture (4.3): answered from the cache at once, before
    // any network, so a view mounts without waiting on the server.
    "read?": {
      actions: ({ context, event }) =>
        event.reply({ userId: context.userId, registrationOpen: context.registrationOpen }),
    },
  },
  states: {
    ready: {
      on: {
        // The gesture from session-switch (4.3, fifth rule).
        "signin.requested": { target: "authing" },
        // Sign out is local-first (5): announce it at once so the UI flips, mark it
        // owed, then tell the server. An offline logout is retried on revalidation.
        "signout.requested": {
          guard: ({ context }) => Boolean(context.userId),
          actions: [
            assign({ userId: null, logoutOwed: true }),
            persist,
            emit(({ context }) => ({
              type: "session.changed",
              userId: null,
              registrationOpen: context.registrationOpen,
            })),
          ],
          target: "deauthing",
        },
        // Internal (7.2): sent by fact.js on mount and when the tab regains focus.
        _revalidate: { target: "revalidating" },
      },
    },
    authing: {
      invoke: {
        src: "authenticate",
        input: ({ context }) => ({
          api: context.api,
          registrationOpen: context.registrationOpen,
          userId: context.userId,
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
              assign({
                userId: ({ event }) => event.output.userId,
                registrationOpen: ({ event }) => event.output.registrationOpen === true,
                logoutOwed: false,
              }),
              persist,
              emit(({ context }) => ({
                type: "session.changed",
                userId: context.userId,
                registrationOpen: context.registrationOpen,
              })),
            ],
          },
        ],
        onError: {
          target: "ready",
          actions: emit({ type: "session.refused", reason: "unavailable" }),
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
            const userChanged = me.userId !== context.userId;
            const regChanged = registrationOpen !== context.registrationOpen;
            enqueue.assign({ registrationOpen });
            if (userChanged) enqueue.assign({ userId: me.userId });
            if (userChanged || regChanged) {
              enqueue.emit({ type: "session.changed", userId: me.userId, registrationOpen });
            }
            enqueue(persist);
          }),
        },
        onError: { target: "ready" },
      },
    },
  },
});
