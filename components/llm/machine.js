import { setup, assign, emit, enqueueActions, fromPromise, fromCallback } from "xstate";
import { ulid } from "ulid";

// `llm` owns access to the models, the language models and Jev (architecture.md 3.1): remote-only,
// because a completion can only come from the server, which also holds the
// account's model settings and API key (3.1, 7.7). It answers `read` (the account's
// picture, never the key) and `complete` (start one answer; the answer arrives as
// `completion.progressed` events, 6.3), and `decide` (ask Jev yes/no and pick-one questions; the
// answers come back in the reply, because there is nothing to stream), and `generate`
// (one short text in one go, for a generator, also answered in the reply). It follows `session.changed`, because the
// picture depends on who is signed in (3.4), `llm.edited` (the user's settings
// gestures) and `turn.steered` (a stop). Parallel regions keep the account picture,
// the running answer, the running decision and the running generation from waiting
// on each other. Everything with a side
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
  for (const field of ["provider", "key", "model", "effort", "ttl", "jevKey", "address", "decider", "deciderModel"]) if (field in event) patch[field] = event[field];
  return patch;
};

// Jev answers decide unless the picture names Ollama on the user's Mac (3.4); a
// picture from before deciders were offered names none and means Jev.
const jevDecides = (picture) => (picture.decider?.provider ?? "jev") === "jev";

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
// fields it carries. Block and Reset use come from People and their Undo; a guest's
// Delete arrives as removal.settled once its Undo window ended, and its spending is
// forgotten.
const EDITS = {
  "limits.edited": (event) => ({ what: "limits", fields: fieldsOf(event, ["guest", "allGuests", "providers"]) }),
  "guestkeys.edited": (event) => ({ what: "guestkeys", fields: fieldsOf(event, ["jev", "anthropic"]) }),
  "guest.blocked": (event) => ({ what: "blocked", fields: { user: event.user, blocked: event.blocked } }),
  "use.reset": (event) => ({ what: "reset", fields: { user: event.user, ...(event.undone ? { undone: true } : {}) } }),
  "removal.settled": (event) => ({ what: "forget", fields: { user: event.id } }),
};

// --- Steps (12, Undo) -------------------------------------------------------------------

// The chat settings a step holds, as the picture shows them: never a key (7.7), so no key
// ever rides a step.
const SETTINGS = {
  provider: (p) => p.provider,
  model: (p) => p.model,
  effort: (p) => p.effort,
  ttl: (p) => p.ttl,
  address: (p) => p.ollama?.address,
  decider: (p) => p.decider?.provider,
  deciderModel: (p) => p.decider?.model,
};
const settingsOf = (picture) =>
  Object.fromEntries(Object.entries(SETTINGS).map(([k, read]) => [k, read(picture)]).filter(([, v]) => typeof v === "string"));

// The fields a gesture changed, as one step's undo and redo, or null when it changed no
// setting (a key alone is no step).
function stepOf(before, after) {
  const changed = Object.keys(after).filter((k) => before[k] !== after[k] && typeof before[k] === "string");
  if (!changed.length) return null;
  const pick = (from) => Object.fromEntries(changed.map((k) => [k, from[k]]));
  return { before: pick(before), after: pick(after) };
}

const LABELS = {
  provider: (v) => `choose the provider ${v}`,
  model: (v) => `choose the model ${v}`,
  effort: (v) => `set thinking to ${v}`,
  ttl: (v) => `keep the cache for ${v}`,
  address: () => "change the address of Ollama",
  decider: (v) => `choose ${v} to decide`,
  deciderModel: (v) => `choose the model ${v} to decide`,
};
const ORDER = Object.keys(LABELS);
const labelOf = (after) => {
  const first = ORDER.find((k) => k in after);
  return LABELS[first](after[first]);
};

// What a step writes back. A changed decider brings its own model back with it, so the
// model of the other decider is not stored over the user's choice.
const restoreOf = (fields) => {
  const patch = { ...fields };
  if ("decider" in patch) delete patch.deciderModel;
  return patch;
};

// Only a guest's removal is llm's; every other removal passes by.
const guestRemoved = ({ event }) => event.kind === "guest";

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
    // One short text (llm: generate): the server module answers with the text or an
    // error code, so a failure rides the reply to the asker.
    generate: fromPromise(({ input }) => input.generate(input.payload)),
    // Signed out, the first decide makes a guest when the page is a try page (3.4):
    // session answers with the new account, or not-a-try-page anywhere else.
    guest: fromPromise(({ input }) => input.guest()),
    // What guests spent, for the admin (llm: spending), and the admin's two gestures
    // reaching the server, each answered with the whole spending picture.
    spending: fromPromise(({ input }) => input.spending()),
    editSpending: fromPromise(({ input }) => input.edit(input.what, input.fields)),
  },
  actions: {
    // A gesture that changed any chat setting is one step (12, Undo); its undo and redo
    // hold only those settings, and each names what it expects to find.
    recordStep: enqueueActions(({ context, enqueue }) => {
      const step = context.editing && stepOf(context.editing, settingsOf(context.picture));
      enqueue.assign({ editing: null });
      if (!step) return;
      enqueue.emit({
        type: "step.recorded",
        id: context.mint(),
        owner: "llm",
        label: labelOf(step.after),
        undo: { kind: "settings", fields: step.before, expect: step.after },
        redo: { kind: "settings", fields: step.after, expect: step.before },
      });
    }),
    startApplying: assign({ applying: ({ event }) => ({ id: event.id }) }),
    settleApplied: enqueueActions(({ context, enqueue }) => {
      if (context.applying) enqueue.emit({ type: "step.settled", id: context.applying.id, owner: "llm", outcome: "applied" });
      enqueue.assign({ applying: null });
    }),
    refuseStep: emit(({ event }) => ({ type: "step.settled", id: event.id, owner: "llm", outcome: "refused", reason: "changed" })),
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
    ownStep: ({ event }) => event.owner === "llm",
    stepApplies: ({ context, event }) => {
      const p = event.payload ?? {};
      if (event.owner !== "llm" || p.kind !== "settings" || !p.fields || !p.expect || !context.picture.signedIn) return false;
      const now = settingsOf(context.picture);
      const keys = Object.keys(p.expect);
      return keys.length > 0 && keys.every((k) => now[k] === p.expect[k]);
    },
    isEnd: ({ event }) => event.piece.type === "end",
    stopping: ({ context, event }) => event.action === "stop" && event.turnId === context.run.id,
  },
}).createMachine({
  id: "llm",
  meta: {
    description:
      "Owns access to the models: the language models that write, and Jev, which decides; and the account's model settings: provider, model, " +
      "thinking effort, cache lifetime, and the API keys, which are kept encrypted on the " +
      "server and never sent back to the browser. A chat answer streams back piece by piece as " +
      "events, one answer at a time; `decide` asks Jev yes-or-no and pick-one questions and " +
      "returns the answers in the reply, on the account's own Jev key, and refuses as no-key at once when Jev decides and no Jev key is saved. `generate` writes one short text in one go " +
      "for a generator, the generator's prompt as the instruction and the item's content as the message, on the account's " +
      "own Anthropic key whichever provider the chat uses, one at a time and beside a chat answer; a model the key does not " +
      "offer is refused as unavailable. On the Mac it writes on the chat's provider instead: on the generator's model when " +
      "that provider offers it, otherwise on the chat model, so by default on Gemma in Ollama with no key and no cost, " +
      "and unavailable while Ollama does not answer. Guests and signed-out visitors are refused as signed-out, and the model \"echo\" " +
      "answers \"Echo: \" and the content's first line, without a key or a network call, for any signed-in account. Signed out on a try page, the first `decide` makes a guest and is asked as that guest. " +
      "A guest spends only on the guest keys, one per provider, which the admin enters; a provider without a guest key is " +
      "not offered to guests. Every use costs the tokens the provider reports at that provider's published price (Jev $42 " +
      "per billion tokens read; Anthropic each model's price), kept as running totals per guest and per provider since the " +
      "start. A guest is refused as used-up once its own $1.00 is spent, as paused once all guests together reach $10.00 or " +
      "a provider's own limit, or has no guest key, and as blocked when the admin blocked it; the last request may go a " +
      "little over, because its cost is known only after. A guest's picture carries the share of its allowance left, never " +
      "an amount, and is read again after each of its requests. Only the admin reads what guests spent and changes the " +
      "limits and guest keys; a change made while what guests spent is being read is still " +
      "saved. When the admin deletes a guest, what it spent stops counting toward every limit. The settings belong to the account, so they are the " +
      "same on every device. Each change of a chat setting (provider, model, thinking effort, cache " +
      "lifetime, the address of Ollama, who decides and its model) is a step Undo and Redo " +
      "reverse (section 12); a key is never part of a step, and a change of a key alone is no " +
      "step. A step is refused when the settings it would reverse were changed since, on any device. Every lookup the model proposes is checked against the query's own schema on the " +
      "server before it reaches the browser. Echo, a test provider, answers without a key or a " +
      "network call. In the Mac app that is not connected, Ollama, a model server on the user's own Mac, is the first " +
      "provider: it needs no key, costs nothing and is not counted, its address is kept with the account (empty brings " +
      "back http://localhost:11434), and the picture says whether it answered there just now and lists only the models " +
      "downloaded in it, preferring gemma4:e4b-mlx; its thinking is On or Off, and an answer it cannot give because it is not " +
      "running fails as local-off. In the Mac app `decide` is answered by default by the decision model kev:0.8b-mlx-bf16 in Ollama, " +
      "with no key and no cost; the user may choose Jev on their own Jev key instead. The picture names who decides, its " +
      "model, and whether it can answer now (a Jev key is saved, or Ollama answered and has kev:0.8b-mlx-bf16 downloaded); a " +
      "decision Ollama cannot give fails as local-off when it is not running and as no-model when kev:0.8b-mlx-bf16 is not " +
      "downloaded. The website never offers Ollama, for chats or for decisions.",
    kind: "fact",
    shape: "remote-only",
    owns: "access to the models: the language models that write, and Jev, which decides",
    steps: {
      "llm.edited": "step",
      "turn.steered": "spends",
      "limits.edited": "pending",
      "guestkeys.edited": "keys",
      "guest.blocked": "pending",
      "use.reset": "pending",
      "removal.settled": "pending",
    },
    emits: ["llm.changed", "completion.progressed", "spending.changed", "step.recorded", "step.settled"],
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
    generate: input.generate,
    generated: null, // the reply of the generate? in flight
    wanted: null, // the payload of the generate? in flight
    spending: input.spending,
    edit: input.edit,
    spendingPending: [], // spending? replies held while a read or an edit is in flight
    mint: input.mint ?? ulid,
    // The chat settings as the gesture being saved found them, to record its step (12, Undo).
    editing: null,
    // The Undo or Redo being saved: { id }, settled once the server answers.
    applying: null,
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
            "llm.edited": { target: "saving", actions: assign({ editing: ({ context }) => settingsOf(context.picture) }) },
            _reread: { target: "readingPicture", actions: assign({ announce: true }) },
            // An Undo or Redo is applied only while the settings are as the step left them,
            // as the server last reported them; a change since, on any device, refuses it.
            // The settings live on the server, not in this browser, so what is compared is
            // the settings themselves, and several steps undo in a row as each leaves them
            // as the step before it found them.
            "step.undone": [
              { guard: "stepApplies", target: "restoring", actions: "startApplying" },
              { guard: "ownStep", actions: "refuseStep" },
            ],
            "step.redone": [
              { guard: "stepApplies", target: "restoring", actions: "startApplying" },
              { guard: "ownStep", actions: "refuseStep" },
            ],
          },
        },
        saving: {
          on: { "read?": { actions: "hold" } },
          invoke: {
            src: "save",
            input: ({ context, event }) => ({ save: context.save, patch: patchOf(event) }),
            onDone: { target: "ready", actions: ["adopt", "replyPending", "clearPending", "emitChanged", "recordStep"] },
            onError: { target: "ready", actions: ["replyPending", "clearPending", assign({ editing: null })] },
          },
        },
        restoring: {
          on: { "read?": { actions: "hold" } },
          invoke: {
            src: "save",
            input: ({ context, event }) => ({ save: context.save, patch: restoreOf(event.payload.fields) }),
            onDone: { target: "ready", actions: ["adopt", "replyPending", "clearPending", "emitChanged", "settleApplied"] },
            // No answer from the server leaves the step where it was: `undo` says so itself.
            onError: { target: "ready", actions: ["replyPending", "clearPending", assign({ applying: null })] },
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
              // With Ollama deciding, only the server can tell whether it is running
              // and has the model, so the request goes through (local-off, no-model).
              {
                guard: ({ context }) => jevDecides(context.picture) && !context.picture.jev?.keySet,
                actions: ({ event }) => event.reply({ error: "no-key" }),
              },
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
    // One generator text at a time, beside a chat answer and a decision (12): a second
    // asker is told busy, as with decide.
    generation: {
      initial: "idle",
      states: {
        idle: {
          on: {
            // Who may generate and with which key is decided by the server alone, not
            // from the picture, so an ask that arrives while the picture is still being
            // read at page load is not refused as signed out.
            "generate?": {
              target: "running",
              actions: assign({ generated: ({ event }) => event.reply, wanted: ({ event }) => event.payload }),
            },
          },
        },
        running: {
          invoke: {
            src: "generate",
            input: ({ context }) => ({ generate: context.generate, payload: context.wanted }),
            onDone: {
              target: "idle",
              actions: [({ context, event }) => context.generated(event.output), assign({ generated: null, wanted: null })],
            },
            onError: {
              target: "idle",
              actions: [({ context }) => context.generated({ error: "unavailable" }), assign({ generated: null, wanted: null })],
            },
          },
          on: { "generate?": { actions: ({ event }) => event.reply({ error: "busy" }) } },
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
            "removal.settled": { guard: guestRemoved, target: "editing" },
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
            "removal.settled": { guard: guestRemoved, target: "editing" },
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
            "removal.settled": { guard: guestRemoved, target: "editing", reenter: true },
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
