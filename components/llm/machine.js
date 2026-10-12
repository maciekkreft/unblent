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
      "returns the answers in the reply. A new account judges on the owner's starter Jev key for its " +
      "first 100 answered requests, until it saves a key of its own. The settings belong to the account, so they are the " +
      "same on every device. Every lookup the model proposes is checked against the query's own schema on the " +
      "server before it reaches the browser. Echo, a test provider, answers without a key or a " +
      "network call.",
    kind: "fact",
    shape: "remote-only",
    owns: "access to the language model",
    emits: ["llm.changed", "completion.progressed"],
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    read: input.read,
    save: input.save,
    stream: input.stream,
    session: input.session,
    decide: input.decide,
    picture: SIGNED_OUT,
    pending: [], // read? replies held while a load is in flight (4.2)
    announce: false, // emit llm.changed when the next picture load lands (a re-sync)
    run: null, // the answer being streamed: { id, text, thinking, calls, dirty }
    decided: null, // the reply of the decide? in flight
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
          on: { "read?": { actions: "hold" } },
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
              { guard: "isEnd", target: "idle", actions: "emitEnd" },
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
              { guard: ({ context }) => !context.picture.signedIn, actions: ({ event }) => event.reply({ error: "signed-out" }) },
              { guard: ({ context }) => !context.picture.jev?.keySet, actions: ({ event }) => event.reply({ error: "no-key" }) },
              { target: "running", actions: assign({ decided: ({ event }) => event.reply }) },
            ],
          },
        },
        running: {
          invoke: {
            src: "decide",
            input: ({ context, event }) => ({ decide: context.decide, payload: event.payload }),
            onDone: {
              target: "idle",
              actions: [
                ({ context, event }) => context.decided(event.output),
                assign({ decided: null }),
                // A starter-key answer carries the count left, so Settings and Judge
                // show it without a reload (architecture.md 12, "Starter keys").
                enqueueActions(({ context, event, enqueue }) => {
                  const left = event.output?.starterLeft;
                  if (left === undefined) return;
                  const picture = { ...context.picture, jev: { keySet: left > 0, starterLeft: left } };
                  enqueue.assign({ picture });
                  enqueue.emit({ type: "llm.changed", ...picture });
                }),
              ],
            },
            onError: {
              target: "idle",
              actions: [({ context }) => context.decided({ error: "unavailable" }), assign({ decided: null })],
            },
          },
          on: { "decide?": { actions: ({ event }) => event.reply({ error: "busy" }) } },
        },
      },
    },
  },
});
