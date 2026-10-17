import { setup, assign, emit, enqueueActions, fromPromise, fromCallback } from "xstate";

// `llm` owns access to the language model (architecture.md 3.1): remote-only,
// because a completion can only come from the server, which also holds the
// account's model settings and API key (3.1, 7.7). It answers `read` (the account's
// picture, never the key) and `complete` (start one answer; the answer arrives as
// `completion.progressed` events, 6.3), and `decide` (ask Jev yes/no and pick-one questions; the
// answers come back in the reply, because there is nothing to stream). It follows `session.changed`, because the
// picture depends on who is signed in (3.4), `llm.edited` (the user's settings
// gestures) and `turn.steered` (a stop). Three parallel regions keep the account
// picture, the running answer and the running decision from waiting on each other. Everything with a side
// effect — the fetch, the stream — arrives through `input`, so the machine is a pure
// definition importable in Node.

// The picture while nobody is signed in (3.4): no server is called, and the account
// section of Settings shows "Sign in to set up the chat." The reply schema requires
// every field, so the lists are empty rather than absent.
export const SIGNED_OUT = {
  signedIn: false,
  provider: "",
  providers: [],
  model: "",
  models: [],
  effort: "default",
  efforts: [],
  ttl: "1h",
};

// The chosen provider needs a key it does not have (7.7): the one case `complete`
// refuses with no-key while signed in.
const needsKey = (picture) => {
  const provider = picture.providers.find((p) => p.id === picture.provider);
  return Boolean(provider && provider.needsKey && !provider.keySet);
};

// Only the patch fields a settings gesture may carry (7.7), never the event `type`.
// The key rides through to the server from here and never enters context.
const patchOf = (event) => {
  const patch = {};
  for (const field of ["provider", "key", "model", "effort", "ttl", "jevKey"]) if (field in event) patch[field] = event[field];
  return patch;
};

// Why a guest's request to this provider is refused before it reaches the server, or
// null (7.7): blocked, its own allowance used up, or paused for every guest. The server
// decides again, so this only saves a request the picture already says is refused.
export const refusal = (picture, provider) => {
  const free = picture.freeUse;
  if (!free) return null;
  if (free.blocked) return "blocked";
  if (free.left <= 0) return "used-up";
  if (free.paused.includes(provider)) return "paused";
  return null;
};

// Only the fields a gesture of the admin's may carry, never the event `type`; a guest
// key rides through to the server from here and never enters context.
const fieldsOf = (event, names) => {
  const out = {};
  for (const field of names) if (field in event) out[field] = event[field];
  return out;
};

// One streamed piece folded into the run: text and thinking are deltas the server
// sends, accumulated into the whole-so-far the event carries (4.3); a call is added
// as `conversations` will store it, without a label (llm is never told labels, 7.7).
const fold = (run, piece) => {
  if (piece.type === "text") return { ...run, text: run.text + piece.text };
  if (piece.type === "thinking") return { ...run, thinking: run.thinking + piece.text };
  if (piece.type === "call") {
    const call = { id: piece.id, target: piece.target, name: piece.name, payload: piece.payload };
    if (piece.invalid !== undefined) call.invalid = piece.invalid;
    return { ...run, calls: [...run.calls, call] };
  }
  return run;
};

// A completion.progressed payload from the run so far; `thinking` only when the
// provider gave any (events are self-contained, 4.3).
const progress = (run, extra) => {
  const payload = { type: "completion.progressed", id: run.id, text: run.text, calls: run.calls, done: false, ...extra };
  if (run.thinking) payload.thinking = run.thinking;
  return payload;
};

// The final event when the stream ends on its own: the accumulated answer plus how
// it ended and what the provider reported, each field only when it is there (a
// network failure carries no provider, model, raw or usage).
const ended = (run, end) => {
  const payload = progress(run, { done: true, status: end.status });
  for (const field of ["raw", "provider", "model", "usage", "error"])
    if (end[field] !== undefined) payload[field] = end[field];
  return payload;
};

// Each of the admin's gestures about guests (7.7, 12): the route it is sent to and the
// fields it carries. Block and Reset use come from People and their Undo.
const EDITS = {
  "limits.edited": (event) => ({ what: "limits", fields: fieldsOf(event, ["guest", "allGuests", "providers"]) }),
  "guestkeys.edited": (event) => ({ what: "guestkeys", fields: fieldsOf(event, ["jev", "anthropic"]) }),
  "guest.blocked": (event) => ({ what: "blocked", fields: { user: event.user, blocked: event.blocked } }),
  "use.reset": (event) => ({ what: "reset", fields: { user: event.user, ...(event.undone ? { undone: true } : {}) } }),
};

export const machine = setup({
  actors: {
    // The starting session (3.4): who is signed in decides whether the server is
    // read at all. session.changed carries the userId after.
    session: fromPromise(({ input }) => input.session()),
    // The account picture from this component's own server module (section 3).
    picture: fromPromise(({ input }) => input.read()),
    // A settings gesture reaching the server: the patch arrives through input, so
    // the key never enters context (7.7).
    save: fromPromise(({ input }) => input.save(input.patch)),
    // The streamed answer (section 10, fromCallback): each neutral piece the server
    // sends becomes an internal _piece; the returned cleanup cancels the fetch, so
    // leaving `running` stops the provider and the spending (12).
    stream: fromCallback(({ input, sendBack }) => {
      const cancel = input.stream(input.request, (piece) => sendBack({ type: "_piece", piece }));
      return () => cancel?.();
    }),
    // One Jev request (llm: decide): the server module answers with Jev's answers or an
    // error code, so a failure rides the reply to the asker.
    decide: fromPromise(({ input }) => input.decide(input.payload)),
    // Signed out, the first decide makes a guest when the page is a try page (3.4):
    // session answers with the new account, or not-a-try-page anywhere else.
    guest: fromPromise(({ input }) => input.guest()),
    // What guests spent, for the admin (llm: spending), and the admin's two gestures
    // reaching the server, each answered with the whole spending picture.
    spending: fromPromise(({ input }) => input.spending()),
    editSpending: fromPromise(({ input }) => input.edit(input.what, input.fields)),
  },
  actions: {
    // Held read? replies are answered with the picture once a load lands (4.2), the
    // way `pages` holds its list.
    hold: assign({ pending: ({ context, event }) => [...context.pending, event.reply] }),
    replyPending: ({ context }) => {
      for (const reply of context.pending) reply(context.picture);
    },
    clearPending: assign({ pending: [] }),
    adopt: assign({ picture: ({ event }) => ({ signedIn: true, ...event.output }) }),
    emitChanged: emit(({ context }) => ({ type: "llm.changed", ...context.picture })),
    // The starting read answers the query and does not announce (4.3); a re-sync
    // after session.changed does. The flag is cleared either way.
    announceMaybe: enqueueActions(({ context, enqueue }) => {
      if (context.announce) enqueue.emit({ type: "llm.changed", ...context.picture });
      enqueue.assign({ announce: false });
    }),
    // The throttle (at most one completion.progressed every 50 ms, plus the final one):
    // the first piece of a window emits at once and arms a `_flush` timer; later pieces
    // only accumulate and mark the run dirty. The timer is a self-re-raised delayed
    // event with a fixed id that arriving pieces never touch, so it keeps firing every
    // 50 ms through a fast steady stream (an `after` on the state stops re-firing when
    // pieces arrive faster than the window).
    onPiece: enqueueActions(({ context, event, enqueue }) => {
      const run = fold(context.run, event.piece);
      if (context.run.armed) {
        run.dirty = true;
        enqueue.assign({ run });
        return;
      }
      run.armed = true;
      run.dirty = false;
      enqueue.assign({ run });
      enqueue.emit(progress(run, {}));
      enqueue.raise({ type: "_flush" }, { delay: 50, id: "flush" });
    }),
    onFlush: enqueueActions(({ context, enqueue }) => {
      if (context.run.dirty) {
        const run = { ...context.run, dirty: false };
        enqueue.assign({ run });
        enqueue.emit(progress(run, {}));
        enqueue.raise({ type: "_flush" }, { delay: 50, id: "flush" });
      } else {
        enqueue.assign({ run: { ...context.run, armed: false } });
      }
    }),
    emitEnd: emit(({ context, event }) => ended(context.run, event.piece)),
    emitStopped: emit(({ context }) => progress(context.run, { done: true, status: "stopped" })),
    // After a guest's request, or one that made the guest, the picture is read again so
    // freeUse shows what is left (7.7); an account's own picture does not change.
    rereadMaybe: enqueueActions(({ context, enqueue }) => {
      if (!context.picture.signedIn || context.picture.freeUse) enqueue.raise({ type: "_reread" });
    }),
    holdSpending: assign({ spendingPending: ({ context, event }) => [...context.spendingPending, event.reply] }),
    replySpending: enqueueActions(({ context, event, enqueue }) => {
      const reply = event.output && typeof event.output === "object" ? event.output : { error: "unavailable" };
      for (const r of context.spendingPending) r(reply);
      enqueue.assign({ spendingPending: [] });
    }),
  },
  guards: {
    signedIn: ({ event }) => event.userId != null,
    isEnd: ({ event }) => event.piece.type === "end",
    stopping: ({ context, event }) => event.action === "stop" && event.turnId === context.run.id,
  },
}).createMachine({
  id: "llm",
  meta: {
    description:
      "Owns access to the language models and the account's model settings: provider, model, " +
      "thinking effort, cache lifetime, and the API keys, which are kept encrypted on the " +
      "server and never sent back to the browser. A chat answer streams back piece by piece as " +
      "events, one answer at a time; `decide` asks Jev yes-or-no and pick-one questions and " +
      "returns the answers in the reply, on the account's own Jev key. Signed out on a try page, the first `decide` makes a guest and is asked as that guest. " +
      "A guest spends only on the guest keys, one per provider, which the admin enters; a provider without a guest key is " +
      "not offered to guests. Every use costs the tokens the provider reports at that provider's published price (Jev $42 " +
      "per billion tokens read; Anthropic each model's price), kept as running totals per guest and per provider since the " +
      "start. A guest is refused as used-up once its own $1.00 is spent, as paused once all guests together reach $10.00 or " +
      "a provider's own limit, or has no guest key, and as blocked when the admin blocked it; the last request may go a " +
      "little over, because its cost is known only after. A guest's picture carries the share of its allowance left, never " +
      "an amount, and is read again after each of its requests. Only the admin reads what guests spent and changes the " +
      "limits and guest keys; a change made while what guests spent is being read is still " +
      "saved. The settings belong to the account, so they are the " +
      "same on every device. Every lookup the model proposes is checked against the query's own schema on the " +
      "server before it reaches the browser. Echo, a test provider, answers without a key or a " +
      "network call.",
    kind: "fact",
    shape: "remote-only",
    owns: "access to the language model",
    emits: ["llm.changed", "completion.progressed", "spending.changed"],
    asks: ["session: read", "session: guest"],
  },
  context: ({ input }) => ({
    read: input.read,
    save: input.save,
    stream: input.stream,
    session: input.session,
    guest: input.guest,
    decide: input.decide,
    picture: SIGNED_OUT,
    pending: [], // read? replies held while a load is in flight (4.2)
    announce: false, // emit llm.changed when the next picture load lands (a re-sync)
    run: null, // the answer being streamed: { id, text, thinking, calls, dirty }
    decided: null, // the reply of the decide? in flight
    asked: null, // the payload of the decide? in flight
    spending: input.spending,
    edit: input.edit,
    spendingPending: [], // spending? replies held while a read or an edit is in flight
  }),
  type: "parallel",
  states: {
    account: {
      // The picture depends on who is signed in (3.4); session.changed re-syncs it
      // and, unlike the starting read, announces the change so a view following
      // llm.changed updates.
      on: {
        "session.changed": [
          { guard: "signedIn", target: ".readingPicture", actions: assign({ announce: true }) },
          { target: ".ready", actions: [assign({ picture: SIGNED_OUT }), "emitChanged"] },
        ],
      },
      initial: "readingSession",
      states: {
        readingSession: {
          on: { "read?": { actions: "hold" } },
          invoke: {
            src: "session",
            input: ({ context }) => ({ session: context.session }),
            onDone: [
              { guard: ({ event }) => event.output.userId != null, target: "readingPicture" },
              { target: "ready", actions: [assign({ picture: SIGNED_OUT }), "replyPending", "clearPending"] },
            ],
            onError: { target: "ready", actions: [assign({ picture: SIGNED_OUT }), "replyPending", "clearPending"] },
          },
        },
        readingPicture: {
          on: {
            "read?": { actions: "hold" },
            // A read already in flight may predate the spend, so it starts over.
            _reread: { target: "readingPicture", reenter: true, actions: assign({ announce: true }) },
          },
          invoke: {
            src: "picture",
            input: ({ context }) => ({ read: context.read }),
            onDone: { target: "ready", actions: ["adopt", "replyPending", "clearPending", "announceMaybe"] },
            // Remote-only fails honestly (12): a failed read (offline, or a lapsed
            // session's 401) shows the signed-out picture rather than a stale one.
            onError: {
              target: "ready",
              actions: [assign({ picture: SIGNED_OUT }), "replyPending", "clearPending", "announceMaybe"],
            },
          },
        },
        ready: {
          on: {
            "read?": { actions: ({ context, event }) => event.reply(context.picture) },
            "llm.edited": { target: "saving" },
            _reread: { target: "readingPicture", actions: assign({ announce: true }) },
          },
        },
        saving: {
          on: { "read?": { actions: "hold" } },
          invoke: {
            src: "save",
            input: ({ context, event }) => ({ save: context.save, patch: patchOf(event) }),
            onDone: { target: "ready", actions: ["adopt", "replyPending", "clearPending", "emitChanged"] },
            onError: { target: "ready", actions: ["replyPending", "clearPending"] },
          },
        },
      },
    },
    completion: {
      initial: "idle",
      states: {
        idle: {
          on: {
            "complete?": [
              { guard: ({ context }) => !context.picture.signedIn, actions: ({ event }) => event.reply({ error: "signed-out" }) },
              {
                guard: ({ context }) => context.picture.provider !== "echo" && refusal(context.picture, context.picture.provider) != null,
                actions: ({ context, event }) => event.reply({ error: refusal(context.picture, context.picture.provider) }),
              },
              { guard: ({ context }) => needsKey(context.picture), actions: ({ event }) => event.reply({ error: "no-key" }) },
              { target: "running", actions: ({ event }) => event.reply({ id: event.payload.id }) },
            ],
          },
        },
        running: {
          entry: assign({ run: ({ event }) => ({ id: event.payload.id, text: "", thinking: "", calls: [], dirty: false, armed: false }) }),
          // Leaving cancels a pending flush, so it never fires against the next answer.
          exit: enqueueActions(({ enqueue }) => enqueue.cancel("flush")),
          invoke: { src: "stream", input: ({ context, event }) => ({ stream: context.stream, request: event.payload }) },
          on: {
            // A second answer while one runs is refused (a completion at a time, 12).
            "complete?": { actions: ({ event }) => event.reply({ error: "busy" }) },
            // Stop (12): announce what arrived as stopped, then leave running, which
            // stops the stream actor and so cancels the provider call.
            "turn.steered": { guard: "stopping", target: "idle", actions: "emitStopped" },
            _piece: [
              { guard: "isEnd", target: "idle", actions: ["emitEnd", "rereadMaybe"] },
              { actions: "onPiece" },
            ],
            _flush: { actions: "onFlush" },
          },
        },
      },
    },
    // One Jev request at a time, like one completion at a time (12): a second asker is
    // told busy rather than queued behind a request it did not see start.
    decision: {
      initial: "idle",
      states: {
        idle: {
          on: {
            "decide?": [
              {
                guard: ({ context }) => !context.picture.signedIn,
                target: "guesting",
                actions: assign({ decided: ({ event }) => event.reply, asked: ({ event }) => event.payload }),
              },
              {
                guard: ({ context }) => refusal(context.picture, "jev") != null,
                actions: ({ context, event }) => event.reply({ error: refusal(context.picture, "jev") }),
              },
              // A guest without a guest Jev key is paused, not told to add a key (7.7).
              {
                guard: ({ context }) => Boolean(context.picture.freeUse) && !context.picture.jev?.keySet,
                actions: ({ event }) => event.reply({ error: "paused" }),
              },
              { guard: ({ context }) => !context.picture.jev?.keySet, actions: ({ event }) => event.reply({ error: "no-key" }) },
              {
                target: "running",
                actions: assign({ decided: ({ event }) => event.reply, asked: ({ event }) => event.payload }),
              },
            ],
          },
        },
        // Nobody is signed in: on a try page this request is the first that needs the
        // server, so it makes the guest (3.4) and goes on as that guest; anywhere else
        // it stays signed out.
        guesting: {
          invoke: {
            src: "guest",
            input: ({ context }) => ({ guest: context.guest }),
            onDone: [
              { guard: ({ event }) => event.output?.userId != null, target: "running" },
              {
                target: "idle",
                actions: [
                  ({ context, event }) =>
                    context.decided({ error: event.output?.error === "unavailable" ? "unavailable" : "signed-out" }),
                  assign({ decided: null, asked: null }),
                ],
              },
            ],
            onError: {
              target: "idle",
              actions: [({ context }) => context.decided({ error: "unavailable" }), assign({ decided: null, asked: null })],
            },
          },
          on: { "decide?": { actions: ({ event }) => event.reply({ error: "busy" }) } },
        },
        running: {
          invoke: {
            src: "decide",
            input: ({ context }) => ({ decide: context.decide, payload: context.asked }),
            onDone: {
              target: "idle",
              actions: [
                ({ context, event }) => context.decided(event.output),
                assign({ decided: null, asked: null }),
                "rereadMaybe",
              ],
            },
            onError: {
              target: "idle",
              actions: [({ context }) => context.decided({ error: "unavailable" }), assign({ decided: null, asked: null }), "rereadMaybe"],
            },
          },
          on: { "decide?": { actions: ({ event }) => event.reply({ error: "busy" }) } },
        },
      },
    },
    // What guests spent (7.7), for the admin only; the server answers not-admin to
    // anyone else. An edit answers held asks with the new picture and announces it.
    spending: {
      initial: "idle",
      states: {
        idle: {
          on: {
            "spending?": { target: "reading", actions: "holdSpending" },
            "limits.edited": { target: "editing" },
            "guestkeys.edited": { target: "editing" },
            "guest.blocked": { target: "editing" },
            "use.reset": { target: "editing" },
          },
        },
        // An edit made while the picture is read is never dropped: the read is left, the
        // edit goes to the server, and every held asker gets the answer to the edit,
        // which is the newer picture.
        reading: {
          on: {
            "spending?": { actions: "holdSpending" },
            "limits.edited": { target: "editing" },
            "guestkeys.edited": { target: "editing" },
            "guest.blocked": { target: "editing" },
            "use.reset": { target: "editing" },
          },
          invoke: {
            src: "spending",
            input: ({ context }) => ({ spending: context.spending }),
            onDone: { target: "idle", actions: "replySpending" },
            onError: { target: "idle", actions: "replySpending" },
          },
        },
        editing: {
          // A second gesture before the first is answered is sent too; the server
          // applies both, and the answer to the last is the picture adopted.
          on: {
            "spending?": { actions: "holdSpending" },
            "limits.edited": { target: "editing", reenter: true },
            "guestkeys.edited": { target: "editing", reenter: true },
            "guest.blocked": { target: "editing", reenter: true },
            "use.reset": { target: "editing", reenter: true },
          },
          // The gesture arrives through input, so a guest key never enters context.
          invoke: {
            src: "editSpending",
            input: ({ context, event }) => ({ edit: context.edit, ...EDITS[event.type](event) }),
            onDone: [
              {
                guard: ({ event }) => Array.isArray(event.output?.providers),
                target: "idle",
                actions: ["replySpending", emit(({ event }) => ({ type: "spending.changed", ...event.output }))],
              },
              { target: "idle", actions: "replySpending" },
            ],
            onError: { target: "idle", actions: "replySpending" },
          },
        },
      },
    },
  },
});
