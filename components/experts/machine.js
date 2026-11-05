import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { ulid } from "ulid";

// The fact component that owns the book experts (3.1), replicated (5) the way
// `generators` is: local-first, cached in the browser, numbering versions itself while
// signed out and syncing to the per-user server when signed in. The last write wins and
// nothing is deleted (5). The view where the user acted emits expert.edited (4.3, fifth
// rule). Everything with a side effect (the store, the network, the ask) arrives through
// input, so this stays a pure definition importable in Node.

const isId = (v) => typeof v === "string" && v !== "";
const str = (v) => (typeof v === "string" ? v : "");
const version = (v) => (Number.isInteger(v) && v >= 1 ? v : 1);

// --- Records --------------------------------------------------------------------------

// One fixed shape and key order, so two copies of the same content compare equal as text.
const record = (r) => ({ id: r.id, prompt: str(r.prompt), on: r.on === true, version: version(r.version) });
const valid = (r) => isId(r?.id);

// What a write carries, and what decides whether a change is a new version.
const content = (r) => {
  const { version: _, ...rest } = record(r);
  return rest;
};
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

// The step that last wrote an expert in this browser (12, Undo): kept in the cache beside
// the record, never sent or announced, so an expert the server brings has none and
// refuses the step it overwrote.
const stampOf = (r) => (typeof r?.step === "string" ? { step: r.step } : {});

// A book the user never wrote an expert for stands at an empty prompt, switched off.
const expertOf = (context, id) => context.experts.get(id) ?? { id, prompt: "", on: false, version: 1 };

const announce = (r) => ({ type: "expert.changed", expert: record(r) });

const replyList = (context, reply) =>
  reply({ experts: [...context.experts.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(record) });

// --- Changes --------------------------------------------------------------------------

// The one place a changed expert is kept, stored and announced. A change of content is a
// new version: signed out it is minted here; signed in the record keeps the version it
// holds, is queued in the outbox (coalesced by id, keeping the first unsynced base) and a
// drain is asked for. An expert never stored has no base.
function commit(context, enqueue, next, step) {
  const current = context.experts.get(next.id);
  const stamped = step === undefined ? stampOf(current) : { step };
  if (current && same(current, next)) {
    if (step === undefined || current.step === step) return;
    const r = { ...record(current), ...stamped };
    context.experts.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    return;
  }
  let r = { ...record(next), ...stamped };
  if (context.userId == null) r = { ...r, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...r, version: current.version };
  context.experts.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null);
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  enqueue.emit(announce(r));
  if (context.userId != null) enqueue.raise({ type: "_drain" });
}

const outboxRow = (r, baseVersion) => ({ ...content(r), baseVersion });

// --- Steps (12, Undo) -------------------------------------------------------------------

const EDITED = ["prompt", "on"];
const pick = (r, fields) => Object.fromEntries(fields.map((k) => [k, r[k]]));

// `prior` is the step that wrote an expert before this one, so an Undo leaves it as that
// step left it and the step before can be undone next; an expert no step of this browser
// wrote is left stamped with a mark of the step undone.
const priorOf = (step) => (typeof step === "string" ? { prior: step } : {});
const priorStamp = (p, step) => p.prior ?? `^${step}`;

// What a step is about, as people read it after "Undo:". The fact knows no book titles.
const labelOf = (r, fields) =>
  fields.length === 1 && fields[0] === "on" ? `switch ${r.on ? "on" : "off"} a book expert` : "edit a book expert";

// expert.edited carries only the fields the user changed. Each edit is a step (12, Undo);
// typing on in the prompt the open stretch last wrote joins it, until the box is left
// (`left`), anything else changes or another step is applied. An expert is switched on
// only while it has a prompt, so the shelf never shows an empty one.
function applyEdit(context, event, enqueue) {
  if (!isId(event.id)) return;
  const was = expertOf(context, event.id);
  const next = { ...was };
  if (typeof event.prompt === "string") next.prompt = event.prompt;
  if (event.on === true && next.prompt.trim() !== "") next.on = true;
  if (event.on === false) next.on = false;
  const fields = EDITED.filter((k) => was[k] !== next[k]);
  if (fields.length > 0) {
    const typed = fields.length === 1 && fields[0] === "prompt";
    const open = context.stretch;
    const joins = open && typed && open.expert === event.id && context.experts.get(event.id)?.step === open.id;
    const step = joins ? open : { id: context.mint(), expert: event.id, before: pick(was, fields), prior: context.experts.get(event.id)?.step };
    commit(context, enqueue, next, step.id);
    const after = pick(next, Object.keys(step.before));
    enqueue.emit({
      type: "step.recorded",
      id: step.id,
      owner: "experts",
      label: labelOf(next, fields),
      undo: { kind: "expert", id: event.id, fields: step.before, ...priorOf(step.prior) },
      redo: { kind: "expert", id: event.id, fields: after, ...priorOf(step.prior) },
    });
    context.stretch = typed ? step : null;
  }
  if (event.left === true && context.stretch?.expert === event.id) context.stretch = null;
  enqueue.assign({ stretch: context.stretch });
}

// An Undo or Redo, applied only while the expert was last written in this browser by that
// step; a change since, here, in another tab or on another device, refuses it.
function applyStep(context, event, enqueue) {
  if (event.owner !== "experts") return;
  context.stretch = null;
  enqueue.assign({ stretch: null });
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "experts", outcome, ...(reason ? { reason } : {}) });
  const p = event.payload ?? {};
  if (p.kind !== "expert" || !isId(p.id) || !p.fields) return settle("refused", "changed");
  const undoing = event.type === "step.undone";
  if (context.experts.get(p.id)?.step !== (undoing ? event.id : priorStamp(p, event.id))) return settle("refused", "changed");
  const fields = pick(p.fields, EDITED.filter((k) => k in p.fields));
  commit(context, enqueue, { ...expertOf(context, p.id), ...fields }, undoing ? priorStamp(p, event.id) : event.id);
  settle("applied");
}

// A query or message that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "expert.edited") applyEdit(context, message, enqueue);
  else if (message.type === "step.undone" || message.type === "step.redone") applyStep(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(["list?", "expert.edited", "step.undone", "step.redone"].map((t) => [t, { actions: queue }]));

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

const ready = (context, enqueue) => {
  for (const message of context.queued) flush(context, message, enqueue);
  enqueue.assign({ queued: [] });
  if (context.userId) enqueue.raise({ type: "_sync", pull: true });
};

// The browser changed account while this fact was not on the page (12): a copy kept for
// another account, with nothing of it left to upload, is emptied before it is read, so
// none of it is shown to the account now signed in or uploaded as its own. A copy marked
// to be added to the account (12, keep) is kept instead, and `keepFor` sends it.
// The copy is marked with the account it now follows, so the next account change finds it.
async function claim(store, ask, api) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, outbox, from] = await Promise.all([store.metaGet("userId"), store.outboxAll(), store.metaGet("adopt")]);
  if (kept && kept !== userId && outbox.length === 0 && !from) await store.empty();
  if (kept !== userId) await store.metaPut("userId", userId).catch(() => {});
  await keepFor(store, from, userId, api);
}

// The browser joined an account keeping this copy (12, keep). The account is asked for
// every expert it holds first: when it already holds one, this copy is emptied, outbox
// included, and the pull from 0 brings the account's. When it holds none, every expert is
// queued for it on the version it holds, which the server adopts on first insert, and the
// cursor goes back to 0. The mark is cleared only once every row is stored in the outbox,
// so a reload midway sends the copy again (coalesced by id) rather than losing it; when
// the account cannot be asked (offline), the mark stays and the next load decides. A mark
// left by a change of account that was called off names the account still signed in, and
// is only cleared.
async function keepFor(store, from, userId, api) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!Array.isArray(held?.experts)) return;
    if (held.experts.some(valid)) {
      await store.empty();
      await store.metaPut("userId", userId);
    } else {
      const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      for (const r of records.filter(valid).map(record)) {
        if (queued.has(r.id)) continue;
        await store.outboxPut(outboxRow(r, r.version));
      }
    }
    await store.metaPut("cursor", 0);
  }
  await store.metaPut("adopt", null);
}

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0 || context.leaving,
    // The browser is changing account (12): empty the local copy once nothing is left
    // to upload.
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store, ask, api } = input;
      await claim(store, ask, api);
      const [records, outbox, cursor, userId] = await Promise.all([store.all(), store.outboxAll(), store.metaGet("cursor"), store.metaGet("userId")]);
      return { records, outbox, cursor: cursor ?? 0, userId: userId ?? null };
    }),
    // Missing (a Node test) is treated as signed out, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // Empties the local copy in one transaction, outbox and cache together (12).
    // With keep (12) the copy stays and is marked, under the account it came from, to be
    // added to the account the browser joins after the reload.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // One sync: drain the outbox in id order, then pull what changed since the cursor
    // when asked to. It returns a summary the machine applies; it never emits (4.3). A
    // network error stops it with what it had; 401 reports the session is gone.
    sync: fromPromise(async ({ input }) => {
      const { api, store, rows, cursor, pull } = input;
      const acks = [];
      for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        let result;
        try {
          result = await api.put(row);
        } catch {
          return { acks, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, authFailed: true };
        acks.push(result);
        await store.outboxDelete(row.id).catch(() => {});
      }
      if (!pull) return { acks };
      let pulled;
      try {
        pulled = await api.pull(cursor);
      } catch {
        return { acks, networkError: true };
      }
      if (pulled.error === "unauthorized") return { acks, authFailed: true };
      return { acks, pulled: pulled.experts ?? [], newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "experts",
  meta: {
    description:
      "Owns the book experts: for each book, a prompt the user writes for an expert on it and " +
      "whether that expert is on. An expert that is on shows on the shelf above a new chat, " +
      "and the prompt of the one picked joins that chat's start. `experts: list` answers " +
      "every expert written and expert.changed announces each change. A change made in the " +
      "Book experts tab (expert.edited) carries only the fields changed and is a step Undo " +
      "and Redo reverse (section 12): typing on in one prompt stays one step until the box is " +
      "left or anything else changes, and each On switch is a step of its own. A step is " +
      "refused when the expert was changed since by anything else, here, in another tab or " +
      "on another device. An expert is switched on only while it has a prompt; a prompt " +
      "emptied later keeps the switch, and the shelf shows only an expert that is on and has " +
      "a prompt. An expert " +
      "whose book is gone is kept but never shown, because the views list only the books " +
      "`books: list` answers. Replicated (5): it works signed out, numbering versions itself, " +
      "and syncs to the account when signed in, so the experts are the same on every device; " +
      "the last write wins and nothing is deleted.",
    kind: "fact",
    shape: "replicated",
    owns: "the book experts",
    steps: { "expert.edited": "step" },
    emits: ["expert.changed", "step.recorded", "step.settled"],
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    mint: input.mint ?? ulid,
    // The stretch of typing still open (12, Undo): { id, expert, before, prior }.
    stretch: null,
    experts: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    userId: null,
    cursor: 0,
    queued: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    // The browser joins the next account keeping this copy (12, keep).
    keep: false,
    resync: false,
    pull: false,
  }),
  // While loading, only whether the browser is leaving is kept (12); the rest of the
  // news is read from session once the store is loaded.
  on: {
    "session.changed": {
      actions: assign({ leaving: ({ event }) => event.leaving === true, keep: ({ event }) => event.leaving === true && event.keep === true }),
    },
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask, api: context.api }),
        onDone: {
          target: "checkingSession",
          actions: assign(({ event }) => ({
            experts: new Map(event.output.records.filter(valid).map((r) => [r.id, { ...record(r), ...stampOf(r) }])),
            outbox: new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: event.output.cursor,
            userId: event.output.userId,
          })),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "list?") replyList(context, message.reply);
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: QUEUED,
    },
    // The store is loaded; confirm who is signed in before flushing, so a change is made
    // with the right signed-out or signed-in rule.
    checkingSession: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            context.userId = event.output?.userId ?? null;
            enqueue.assign({ userId: context.userId });
            ready(context, enqueue);
          }),
        },
        onError: {
          target: "ready",
          actions: enqueueActions(({ context, enqueue }) => ready(context, enqueue)),
        },
      },
      on: QUEUED,
    },
    ready: {
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "expert.edited": { actions: enqueueActions(({ context, event, enqueue }) => applyEdit(context, event, enqueue)) },
        "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        // Signing in enqueues the whole cache, so what was made signed out becomes the
        // account's (5); a different user resets the cursor.
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            // The browser is changing account (12): upload what is left, then empty the local
            // copy. Any other news ends it, and syncing goes on as before.
            if (event.leaving) {
              enqueue.assign({ leaving: true, keep: event.keep === true });
              enqueue.raise({ type: "_leave" });
              return;
            }
            if (context.leaving) enqueue.assign({ leaving: false, keep: false });
            // A keep called off (12): the copy stays this account's, so its mark goes.
            if (context.keep) enqueue(() => context.store.metaPut("adopt", null).catch(() => {}));
            const userId = event.userId;
            if (userId === context.userId) return;
            enqueue.assign({ userId });
            enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
            if (!userId) return;
            enqueue.assign({ cursor: 0 });
            enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
            for (const r of context.experts.values()) {
              if (context.outbox.has(r.id)) continue;
              const row = outboxRow(r, r.version);
              context.outbox.set(r.id, row);
              enqueue(() => context.store.outboxPut(row).catch(() => {}));
            }
            enqueue.raise({ type: "_sync", pull: true });
          }),
        },
      },
      initial: "idle",
      states: {
        // Leaving (12): what is left is uploaded at once, then the local copy is emptied.
        emptying: {
          entry: assign({ experts: () => new Map() }),
          invoke: {
            src: "empty",
            input: ({ context }) => ({ store: context.store, keep: context.keep, from: context.userId }),
            onDone: { target: "left" },
            onError: { target: "left" },
          },
        },
        // Emptied; a change made meanwhile is uploaded and emptied again. When the change
        // of account is called off, syncing goes on as before.
        left: {
          always: { guard: ({ context }) => !context.leaving, target: "idle" },
          on: {
            _drain: { guard: "syncable", target: "syncing" },
            _sync: { guard: "syncable", target: "syncing" },
            _leave: { guard: "syncable", target: "syncing" },
          },
        },
        idle: {
          always: { guard: "leftover", target: "emptying" },
          on: {
            _leave: { guard: "syncable", target: "syncing" },
            _drain: { guard: "syncable", target: "debouncing" },
            _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
          },
        },
        // A _drain reenters, which restarts the window; a focus, sign-in or hidden tab
        // (_sync) does not wait.
        debouncing: {
          on: {
            _drain: { target: "debouncing", reenter: true },
            _leave: { guard: "syncable", target: "syncing" },
            _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
          },
          after: {
            [SYNC_IDLE_MS]: [{ guard: "syncable", target: "syncing" }, { target: "idle" }],
          },
        },
        syncing: {
          entry: assign({ resync: false, pull: false }),
          invoke: {
            src: "sync",
            // pull comes from the triggering event: the entry assign above would wipe it.
            input: ({ context, event }) => ({
              api: context.api,
              store: context.store,
              rows: [...context.outbox.values()],
              cursor: context.cursor,
              pull: Boolean(event.pull) && !context.leaving,
            }),
            onDone: {
              target: "idle",
              actions: enqueueActions(({ context, event, enqueue }) => {
                applySync(context, event.output, enqueue);
                const { authFailed, networkError } = event.output;
                if (authFailed || networkError) return;
                if (context.resync) enqueue.raise({ type: "_sync", pull: context.pull });
                else if (context.outbox.size > 0) enqueue.raise({ type: "_drain" });
              }),
            },
            onError: { target: "idle" },
          },
          on: {
            _leave: { actions: assign({ resync: true }) },
            _sync: { actions: assign({ resync: true, pull: ({ context, event }) => context.pull || Boolean(event.pull) }) },
          },
        },
      },
    },
    failed: {
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
      },
    },
  },
});

// Adopt one expert the server holds, its content and version, and announce it.
function adopt(context, server, enqueue) {
  const r = record(server);
  context.experts.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  enqueue.emit(announce(r));
}

// Apply a sync's summary: adopt acknowledged and pulled experts, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    if (!valid(ack)) continue;
    const row = context.outbox.get(ack.id);
    const held = context.experts.get(ack.id);
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    if (row && same(row, ack)) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
    } else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    // Keep the latest local content (a mid-sync edit), take the server's version.
    const r = held ? { ...held, version: ack.version } : record(ack);
    context.experts.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    enqueue.emit(announce(r));
  }

  for (const server of pulled) {
    if (!valid(server)) continue;
    const current = context.experts.get(server.id);
    if (current && server.version <= current.version) continue;
    // A local change not yet sent is the later write, so it wins (last write wins) and is
    // sent at the next drain.
    if (context.outbox.has(server.id)) continue;
    adopt(context, server, enqueue);
  }

  if (newCursor !== undefined) {
    enqueue.assign({ cursor: newCursor });
    enqueue(() => context.store.metaPut("cursor", newCursor).catch(() => {}));
  }
  if (authFailed) {
    enqueue.assign({ userId: null });
    enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
  }
}
