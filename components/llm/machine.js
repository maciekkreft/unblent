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
// fields it carries. A guest's spending is forgotten only once the step of its Delete,
// which `session` records, leaves the admin's undo list (3.4).
const EDITS = {
  "limits.edited": (event) => ({ what: "limits", fields: fieldsOf(event, ["guest", "allGuests", "providers"]) }),
  "guestkeys.edited": (event) => ({ what: "guestkeys", fields: fieldsOf(event, ["jev", "anthropic"]) }),
  "guest.blocked": (event) => ({ what: "blocked", fields: { user: event.user, blocked: event.blocked } }),
  "use.reset": (event) => ({ what: "reset", fields: { user: event.user } }),
  "step.dropped": (event) =>
    event.payload?.kind === "guestkeys"
      ? { what: "guestkeys/forget", fields: { step: event.id } }
      : { what: "forget", fields: { user: event.payload.user } },
};

// --- Steps of the admin's gestures about guests (12, Undo) ------------------------------

// What guests spent lives in one shared file on the server, so a step holds what it
// expects to find there and is applied only while a fresh read still shows it. A guest
// key step is checked by the server itself, which alone holds the keys (7.7).
const SPENDING_STEPS = ["limits", "blocked", "reset"];

// The limits a shape names (limits.edited's), as a ledger (the spending picture) holds them.
function limitsIn(ledger, shape) {
  const out = {};
  if ("guest" in shape) out.guest = ledger.guest;
  if ("allGuests" in shape) out.allGuests = ledger.allGuests.limit;
  if (shape.providers)
    out.providers = Object.fromEntries(
      Object.keys(shape.providers).map((id) => [id, ledger.providers.find((p) => p.id === id)?.limit ?? null]),
    );
  return out;
}
const guestIn = (ledger, user) => ledger.guests.find((g) => g.userId === user);
const spentOf = (ledger, user) => guestIn(ledger, user)?.spent ?? 0;
const blockedOf = (ledger, user) => Boolean(guestIn(ledger, user)?.blocked);
// A total read twice is summed the same way, but not always in the same order.
const sameMoney = (a, b) => Math.abs(a - b) < 1e-9;

// The guest as People names it, for the step's label (12, Undo).
const guestName = (event) => (typeof event.name === "string" && event.name.trim() ? event.name.trim() : "a guest");

// --- Key steps (7.7, 12, Undo) --------------------------------------------------------

// A key never enters a step: the server keeps the key from before and the key after it,
// still encrypted, under the step's id, so the step says only which of the two to bring
// back and which it expects to find. Its id is minted before the gesture is sent, so the
// server files the kept keys under it.
const KEY_UNDO = { restore: "before", expect: "after" };
const KEY_REDO = { restore: "after", expect: "before" };

// One provider's key change in a gesture: add, replace or remove, or null when it changes
// nothing (removing a key that is not there).
function keyChange(provider, value, set) {
  if (typeof value !== "string" || (value === "" && !set)) return null;
  return { provider, kind: value === "" ? "remove" : set ? "replace" : "add" };
}

// The account's own key changes a settings gesture carries, from the picture it was
// made on: the provider's key (`key`, for the provider the gesture names or the chosen
// one) and the Jev key.
function keyEditOf(context, event) {
  const picture = context.picture;
  const provider = event.provider ?? picture.provider;
  const changes = [
    keyChange(provider, event.key, Boolean(picture.providers?.find((p) => p.id === provider)?.keySet)),
    keyChange("jev", event.jevKey, picture.jev?.keySet === true),
  ].filter(Boolean);
  return changes.length ? { id: context.mint(), changes } : null;
}

const KEY_NAMES = { jev: "the Jev key" };
const keyLabel = ({ provider, kind }) => `${kind} ${KEY_NAMES[provider] ?? "the API key"}`;
const GUEST_KEY_NAMES = { jev: "Jev", anthropic: "Anthropic" };
const guestKeyLabel = ({ provider, kind }) => `${kind} the guest ${GUEST_KEY_NAMES[provider] ?? provider} key`;

// The guest key changes of guestkeys.edited, from the ledger it was made on. Without a
// ledger yet, a removal is taken to remove a key, as People offers Remove only on a
// saved key, and the server keeps nothing when nothing changed.
function guestKeysDraft(context, event) {
  const ledger = context.ledger;
  const changes = Object.keys(GUEST_KEY_NAMES)
    .map((id) => {
      const set = ledger ? Boolean(ledger.providers.find((p) => p.id === id)?.guestKeySet) : event[id] === "";
      return keyChange(id, event[id], set);
    })
    .filter(Boolean);
  return changes.length ? { kind: "guestkeys", id: context.mint(), changes } : null;
}

// What a gesture changes, as the ledger held it before the gesture was sent; null when
// the ledger was never read.
function draftOf(context, event) {
  if (event.type === "guestkeys.edited") return guestKeysDraft(context, event);
  const ledger = context.ledger;
  if (!ledger) return null;
  if (event.type === "limits.edited") return { kind: "limits", before: limitsIn(ledger, EDITS[event.type](event).fields) };
  if (event.type === "guest.blocked") return { kind: "blocked", user: event.user, name: guestName(event), before: blockedOf(ledger, event.user) };
  if (event.type === "use.reset") return { kind: "reset", user: event.user, name: guestName(event), before: spentOf(ledger, event.user) };
  return null;
}

const LIMIT_LABELS = { guest: () => "the limit for each guest", allGuests: () => "the limit for all guests" };

// The step a gesture made, from the draft and the server's answer, or null when nothing
// changed. Block and Reset use show the short notice with Undo, as they always offered one.
function stepOfDraft(draft, after) {
  if (draft.kind === "guestkeys")
    return {
      id: draft.id,
      label: guestKeyLabel(draft.changes[0]),
      notice: true,
      undo: { kind: "guestkeys", ...KEY_UNDO },
      redo: { kind: "guestkeys", ...KEY_REDO },
    };
  if (draft.kind === "limits") {
    const now = limitsIn(after, draft.before);
    const before = {};
    const changed = {};
    for (const k of ["guest", "allGuests"])
      if (k in draft.before && draft.before[k] !== now[k]) [before[k], changed[k]] = [draft.before[k], now[k]];
    for (const id of Object.keys(draft.before.providers ?? {}))
      if (draft.before.providers[id] !== now.providers[id]) {
        before.providers = { ...before.providers, [id]: draft.before.providers[id] };
        changed.providers = { ...changed.providers, [id]: now.providers[id] };
      }
    const first = Object.keys(changed)[0];
    if (!first) return null;
    const label =
      first === "providers"
        ? `the limit of ${after.providers.find((p) => p.id === Object.keys(changed.providers)[0])?.label ?? "a provider"}`
        : LIMIT_LABELS[first]();
    return {
      label: `change ${label}`,
      undo: { kind: "limits", fields: before, expect: changed },
      redo: { kind: "limits", fields: changed, expect: before },
    };
  }
  if (draft.kind === "blocked") {
    const now = blockedOf(after, draft.user);
    if (now === draft.before) return null;
    return {
      label: `${now ? "block" : "unblock"} ${draft.name}`,
      notice: true,
      undo: { kind: "blocked", user: draft.user, blocked: draft.before, expect: now },
      redo: { kind: "blocked", user: draft.user, blocked: now, expect: draft.before },
    };
  }
  // Reset use on a guest who spent nothing changes nothing.
  if (draft.before <= 0) return null;
  return {
    label: `reset the use of ${draft.name}`,
    notice: true,
    undo: { kind: "reset", user: draft.user, undone: true, expect: spentOf(after, draft.user) },
    redo: { kind: "reset", user: draft.user, expect: draft.before },
  };
}

// Whether a fresh ledger still shows what the step left.
function stillAsLeft(ledger, p) {
  if (!ledger || !Array.isArray(ledger.providers)) return false;
  if (p.kind === "limits") {
    const now = limitsIn(ledger, p.expect);
    const same = (k) => !(k in p.expect) || now[k] === p.expect[k];
    const providers = Object.entries(p.expect.providers ?? {}).every(([id, v]) => now.providers[id] === v);
    return same("guest") && same("allGuests") && providers;
  }
  if (p.kind === "blocked") return blockedOf(ledger, p.user) === p.expect;
  if (p.kind === "reset") return sameMoney(spentOf(ledger, p.user), p.expect);
  return false;
}

// What a step writes back, as the route and fields of an admin's gesture.
function writeOf({ id, payload: p }) {
  if (p.kind === "guestkeys") return { what: "guestkeys/step", fields: { step: id, restore: p.restore, expect: p.expect } };
  if (p.kind === "limits") return { what: "limits", fields: p.fields };
  if (p.kind === "blocked") return { what: "blocked", fields: { user: p.user, blocked: p.blocked } };
  return { what: "reset", fields: { user: p.user, ...(p.undone ? { undone: true } : {}) } };
}

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

// The steps leaving the undo list that the spending part finishes: a guest's Delete,
// whose spending stops counting (3.4, 12), and a guest key step, whose kept keys go.
const guestPurged = ({ event }) =>
  (event.owner === "session" && event.payload?.kind === "guest" && event.payload.deleted === true) ||
  (event.owner === "llm" && event.payload?.kind === "guestkeys");

// The admin's gestures about guests, each sent to the server from any state of `spending`
// that is not already applying a step.
const GESTURES = {
  "limits.edited": { target: "editing", actions: "draft" },
  "guestkeys.edited": { target: "editing", actions: "draft" },
  "guest.blocked": { target: "editing", actions: "draft" },
  "use.reset": { target: "editing", actions: "draft" },
  "step.dropped": { guard: guestPurged, target: "editing", actions: "draft" },
};
// A guest key step goes straight to the server, which alone can tell whether the keys
// are still as the step left them.
const STEPS = {
  "step.undone": [
    { guard: "guestKeyStep", target: "applying", actions: "startStepping" },
    { guard: "spendingStep", target: "verifying", actions: "startStepping" },
  ],
  "step.redone": [
    { guard: "guestKeyStep", target: "applying", actions: "startStepping" },
    { guard: "spendingStep", target: "verifying", actions: "startStepping" },
  ],
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
    // An Undo or Redo of a key step: the server brings back the key it kept and answers
    // with the picture, or with the error changed (7.7, 12).
    moveKey: fromPromise(({ input }) => input.moveKey(input.body)),
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
    // A gesture that changed a key is one step of its own, under the id the server kept
    // the keys by; the step holds no key (7.7).
    recordKeyStep: enqueueActions(({ context, enqueue }) => {
      const edit = context.keyEdit;
      enqueue.assign({ keyEdit: null });
      if (!edit) return;
      enqueue.emit({
        type: "step.recorded",
        id: edit.id,
        owner: "llm",
        label: keyLabel(edit.changes[0]),
        notice: true,
        undo: { kind: "key", ...KEY_UNDO },
        redo: { kind: "key", ...KEY_REDO },
      });
    }),
    refuseApplying: enqueueActions(({ context, enqueue }) => {
      if (context.applying)
        enqueue.emit({ type: "step.settled", id: context.applying.id, owner: "llm", outcome: "refused", reason: "changed" });
      enqueue.assign({ applying: null });
    }),
    // The key step left the undo list: the server erases the keys it kept (7.7).
    forgetKey: ({ context, event }) =>
      Promise.resolve()
        .then(() => context.forgetKey(event.id))
        .catch(() => {}),
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
      if (Array.isArray(reply.providers)) enqueue.assign({ ledger: reply });
    }),
    // The gesture being sent, with what it changes as the ledger held it (12, Undo).
    draft: assign({ draft: ({ context, event }) => draftOf(context, event) }),
    recordSpendingStep: enqueueActions(({ context, event, enqueue }) => {
      const step = context.draft && Array.isArray(event.output?.providers) && stepOfDraft(context.draft, event.output);
      enqueue.assign({ draft: null });
      if (!step) return;
      enqueue.emit({
        type: "step.recorded",
        id: step.id ?? context.mint(),
        owner: "llm",
        label: step.label,
        undo: step.undo,
        redo: step.redo,
        ...(step.notice ? { notice: true } : {}),
      });
    }),
    startStepping: assign({ stepping: ({ event }) => ({ id: event.id, payload: event.payload }) }),
    settleStepping: enqueueActions(({ context, enqueue }) => {
      if (context.stepping) enqueue.emit({ type: "step.settled", id: context.stepping.id, owner: "llm", outcome: "applied" });
      enqueue.assign({ stepping: null });
    }),
    refuseStepping: enqueueActions(({ context, enqueue }) => {
      if (context.stepping)
        enqueue.emit({ type: "step.settled", id: context.stepping.id, owner: "llm", outcome: "refused", reason: "changed" });
      enqueue.assign({ stepping: null });
    }),
  },
  guards: {
    signedIn: ({ event }) => event.userId != null,
    ownStep: ({ event }) => event.owner === "llm" && event.payload?.kind === "settings",
    spendingStep: ({ event }) => event.owner === "llm" && SPENDING_STEPS.includes(event.payload?.kind),
    guestKeyStep: ({ event }) => event.owner === "llm" && event.payload?.kind === "guestkeys",
    keyStep: ({ event }) => event.owner === "llm" && event.payload?.kind === "key",
    stillAsLeft: ({ context, event }) => stillAsLeft(event.output, context.stepping.payload),
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
      "saved. Each change of a limit, each Block or Unblock and each Reset use is a step Undo and Redo " +
      "reverse, Block and Reset use with the short notice naming the guest as People does, such as " +
      "Block Guest 12; Undo of a Reset use brings back the totals from " +
      "before it, and a step is refused when a fresh read shows the limit, the block or what the guest spent " +
      "changed since. When the admin deletes a guest, what it spent stops counting toward every limit once " +
      "that delete can no longer be undone. The settings belong to the account, so they are the " +
      "same on every device. Each change of a chat setting (provider, model, thinking effort, cache " +
      "lifetime, the address of Ollama, who decides and its model) is a step Undo and Redo " +
      "reverse (section 12). Adding, replacing or removing a key, the account's own or a guest key, is a step " +
      "too, at once and with the short notice with Undo, such as Remove the API key; no key is ever part of a step: the server keeps the key from " +
      "before and the key after, still encrypted, under the step's id, Undo and Redo bring one back from there, " +
      "and both are erased once the step leaves the undo list. A step is refused when the settings or the key it would reverse were changed since, on any device. Every lookup the model proposes is checked against the query's own schema on the " +
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
      "limits.edited": "step",
      "guestkeys.edited": "step",
      "guest.blocked": "step",
      "use.reset": "step",
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
    // What guests spent as the server last said, so a gesture's step knows what it changed.
    ledger: null,
    // The admin's gesture being sent, with what it changes: { kind, ... } (12, Undo).
    draft: null,
    // The Undo or Redo of an admin's gesture being checked and applied: { id, payload }.
    stepping: null,
    mint: input.mint ?? ulid,
    // The chat settings as the gesture being saved found them, to record its step (12, Undo).
    editing: null,
    // The key changes of the gesture being saved and the id of their step: { id, changes }.
    keyEdit: null,
    moveKey: input.moveKey,
    forgetKey: input.forgetKey,
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
        "step.dropped": { guard: ({ context, event }) => context.picture.signedIn && event.owner === "llm" && event.payload?.kind === "key", actions: "forgetKey" },
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
            "llm.edited": {
              target: "saving",
              actions: assign({ editing: ({ context }) => settingsOf(context.picture), keyEdit: ({ context, event }) => keyEditOf(context, event) }),
            },
            _reread: { target: "readingPicture", actions: assign({ announce: true }) },
            // An Undo or Redo is applied only while the settings are as the step left them,
            // as the server last reported them; a change since, on any device, refuses it.
            // The settings live on the server, not in this browser, so what is compared is
            // the settings themselves, and several steps undo in a row as each leaves them
            // as the step before it found them.
            // A key step is checked by the server, which alone holds the keys.
            "step.undone": [
              { guard: "keyStep", target: "rekeying", actions: "startApplying" },
              { guard: "stepApplies", target: "restoring", actions: "startApplying" },
              { guard: "ownStep", actions: "refuseStep" },
            ],
            "step.redone": [
              { guard: "keyStep", target: "rekeying", actions: "startApplying" },
              { guard: "stepApplies", target: "restoring", actions: "startApplying" },
              { guard: "ownStep", actions: "refuseStep" },
            ],
          },
        },
        saving: {
          on: { "read?": { actions: "hold" } },
          invoke: {
            src: "save",
            input: ({ context, event }) => ({
              save: context.save,
              patch: { ...patchOf(event), ...(context.keyEdit ? { step: context.keyEdit.id } : {}) },
            }),
            onDone: { target: "ready", actions: ["adopt", "replyPending", "clearPending", "emitChanged", "recordStep", "recordKeyStep"] },
            onError: { target: "ready", actions: ["replyPending", "clearPending", assign({ editing: null, keyEdit: null })] },
          },
        },
        rekeying: {
          on: { "read?": { actions: "hold" } },
          invoke: {
            src: "moveKey",
            input: ({ context, event }) => ({
              moveKey: context.moveKey,
              body: { step: event.id, restore: event.payload.restore, expect: event.payload.expect },
            }),
            onDone: [
              {
                guard: ({ event }) => Array.isArray(event.output?.providers),
                target: "ready",
                actions: ["adopt", "replyPending", "clearPending", "emitChanged", "settleApplied"],
              },
              { guard: ({ event }) => event.output?.error === "changed", target: "ready", actions: ["replyPending", "clearPending", "refuseApplying"] },
              // No answer from the server leaves the step where it was: `undo` says so itself.
              { target: "ready", actions: ["replyPending", "clearPending", assign({ applying: null })] },
            ],
            onError: { target: "ready", actions: ["replyPending", "clearPending", assign({ applying: null })] },
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
            ...GESTURES,
            ...STEPS,
          },
        },
        // An edit made while the picture is read is never dropped: the read is left, the
        // edit goes to the server, and every held asker gets the answer to the edit,
        // which is the newer picture.
        reading: {
          on: {
            "spending?": { actions: "holdSpending" },
            ...GESTURES,
            ...STEPS,
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
            ...Object.fromEntries(Object.entries(GESTURES).map(([k, v]) => [k, { ...v, reenter: true }])),
          },
          // The gesture arrives through input, so a guest key never enters context; a guest
          // key change carries the id of its step, under which the server keeps the keys.
          invoke: {
            src: "editSpending",
            input: ({ context, event }) => {
              const { what, fields } = EDITS[event.type](event);
              const step = context.draft?.kind === "guestkeys" ? { step: context.draft.id } : {};
              return { edit: context.edit, what, fields: { ...fields, ...step } };
            },
            onDone: [
              {
                guard: ({ event }) => Array.isArray(event.output?.providers),
                target: "idle",
                actions: ["replySpending", emit(({ event }) => ({ type: "spending.changed", ...event.output })), "recordSpendingStep"],
              },
              { target: "idle", actions: ["replySpending", assign({ draft: null })] },
            ],
            onError: { target: "idle", actions: ["replySpending", assign({ draft: null })] },
          },
        },
        // An Undo or Redo of the admin's gesture is applied only while a fresh read still
        // shows what the step left; a change since, on any device or by a guest's use,
        // refuses it. A gesture meanwhile goes first, and the step waits for `undo` to
        // say it was not answered.
        verifying: {
          on: {
            "spending?": { actions: "holdSpending" },
            ...Object.fromEntries(Object.entries(GESTURES).map(([k, v]) => [k, { ...v, actions: ["draft", assign({ stepping: null })] }])),
          },
          invoke: {
            src: "spending",
            input: ({ context }) => ({ spending: context.spending }),
            onDone: [
              { guard: "stillAsLeft", target: "applying", actions: "replySpending" },
              { target: "idle", actions: ["replySpending", "refuseStepping"] },
            ],
            onError: { target: "idle", actions: ["replySpending", assign({ stepping: null })] },
          },
        },
        applying: {
          on: { "spending?": { actions: "holdSpending" } },
          invoke: {
            src: "editSpending",
            input: ({ context }) => ({ edit: context.edit, ...writeOf(context.stepping) }),
            onDone: [
              {
                guard: ({ event }) => Array.isArray(event.output?.providers),
                target: "idle",
                actions: ["replySpending", emit(({ event }) => ({ type: "spending.changed", ...event.output })), "settleStepping"],
              },
              // A guest key changed since: the server wrote nothing, and a fresh read answers
              // whoever asked meanwhile.
              { guard: ({ event }) => event.output?.error === "changed", target: "reading", actions: "refuseStepping" },
              // No answer from the server leaves the step where it was: `undo` says so itself.
              { target: "idle", actions: ["replySpending", assign({ stepping: null })] },
            ],
            onError: { target: "idle", actions: ["replySpending", assign({ stepping: null })] },
          },
        },
      },
    },
  },
});
