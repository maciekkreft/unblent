import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { ulid } from "ulid";

// The fact component that owns the Wheels of Life (3.1), replicated (5) the way
// `choice-points` is: local-first, cached in the browser, numbering versions itself while
// signed out and syncing to the per-user server when signed in. The last write wins and
// a delete is a tombstone that always wins (5). The view where the user acted emits
// wheel.saved (4.3, fifth rule). Everything with a side effect (the store, the network,
// the ask) arrives through input, so this stays a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const isDay = (v) => typeof v === "string" && DAY.test(v);

const AREAS = 8;
const isScore = (v) => Number.isInteger(v) && v >= 1 && v <= 10;
// A copy from storage or the network may hold anything; what cannot be read counts as no score.
const scores = (v) => Array.from({ length: AREAS }, (_, i) => (Array.isArray(v) && isScore(v[i]) ? v[i] : null));
const areScores = (v) => Array.isArray(v) && v.length === AREAS && v.every((s) => s === null || isScore(s));

// --- Records --------------------------------------------------------------------------

// One fixed shape and key order, so two copies of the same content compare equal as
// text.
const toRecord = (r) => ({
  id: r.id,
  day: r.day,
  actual: scores(r.actual),
  wanted: scores(r.wanted),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  ...(r.deleted === true ? { deleted: true } : {}),
  // The step that last wrote it in this browser (12, Undo); the server never has it.
  ...(typeof r.step === "string" ? { step: r.step } : {}),
});

// What a write carries, and what decides whether a change is a new version.
const content = (r) => ({ day: r.day, actual: r.actual, wanted: r.wanted });
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

// A tombstone is kept for the sync (5) but never listed or announced as a change.
const visible = (r) => r && !r.deleted;

const announce = (context, r) => ({
  id: r.id,
  day: r.day,
  actual: r.actual,
  wanted: r.wanted,
  version: r.version,
  pending: context.outbox.has(r.id),
});

function replyList(context, day, reply) {
  const wheels = [...context.wheels.values()]
    .filter((r) => visible(r) && (day === undefined || r.day === day))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => announce(context, r));
  reply({ wheels });
}

// --- Changes --------------------------------------------------------------------------

// The one place a changed record is kept, stored and announced. A change of content is
// a new version: signed out it is minted here; signed in the record keeps the version
// it holds, is queued in the outbox (coalesced by id, keeping the first unsynced base)
// and a drain is asked for.
function commit(context, enqueue, next) {
  const current = context.wheels.get(next.id);
  const changed = !current || !same(current, next) || Boolean(next.deleted) !== Boolean(current.deleted);
  let r = next;
  if (changed && context.userId == null) r = { ...next, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...next, version: current.version };
  context.wheels.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (changed && context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null);
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  if (r.deleted) {
    if (visible(current)) enqueue.emit({ type: "wheel.deleted", id: r.id, day: r.day });
  } else {
    enqueue.emit({ type: "wheel.changed", wheel: announce(context, r) });
  }
  if (changed && context.userId != null) enqueue.raise({ type: "_drain" });
}

const outboxRow = (r, baseVersion) => ({ id: r.id, ...content(r), baseVersion, ...(r.deleted ? { deleted: true } : {}) });

// --- Steps (12, Undo) -------------------------------------------------------------------

// A wheel as a step names it: its scores, whether it is deleted, and `prior`, the step
// that wrote it before this one, so an Undo leaves it as that step left it and the step
// before can be undone next.
const entry = (r, prior = r.step) => ({
  kind: "wheel",
  id: r.id,
  actual: r.actual,
  wanted: r.wanted,
  deleted: Boolean(r.deleted),
  ...(prior ? { prior } : {}),
});
const todayFrom = (picture) => (isDay(picture?.today) ? picture.today : null);

// What a wheel undone back past every step this browser knows of is stamped with.
const before = (e, step) => e.prior ?? `^${step}`;

// Every save that changes a wheel is a step. One stretch of rating one wheel is one step,
// from its first save until a save says `finished`; a save while that stretch last wrote
// it joins it. Adding one is the first save's step, whose Undo deletes it again; a delete
// is a step of its own, which asks for the notice.
function recordStep(context, enqueue, was, next, event) {
  const open = context.stretch;
  const removing = Boolean(next.deleted);
  const joins = !removing && open != null && open.id === next.id && was?.step === open.step;
  const step = joins ? open.step : context.mint();
  const first = joins ? open.before : was ? entry(was) : entry({ ...next, deleted: true }, null);
  commit(context, enqueue, { ...next, step });
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "wheels",
    label: `${removing ? "delete" : first.deleted ? "add" : "edit"} Wheel of Life`,
    undo: first,
    redo: entry({ ...next, step }, first.prior ?? null),
    ...(removing ? { notice: true } : {}),
  });
  const stretch = removing || event.finished === true ? null : { step, id: next.id, before: first };
  context.stretch = stretch;
  enqueue.assign({ stretch });
}

// An Undo or Redo of one of this fact's steps. It is applied only while the wheel is as
// the step left it, last written in this browser by that step; anything written since,
// here, in another tab or on another device, refuses it. A deleted wheel comes back with
// a restore write (5). A wheel of a day that has closed is refused.
function applyStep(context, event, enqueue) {
  if (event.owner !== "wheels") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "wheels", outcome, ...(reason ? { reason } : {}) });
  context.stretch = null;
  enqueue.assign({ stretch: null });
  const p = event.payload ?? {};
  const undoing = event.type === "step.undone";
  const current = isId(p.id) ? context.wheels.get(p.id) : null;
  if (p.kind !== "wheel" || !current || !areScores(p.actual) || !areScores(p.wanted)) return settle("refused", "changed");
  if (current.step !== (undoing ? event.id : before(p, event.id))) return settle("refused", "changed");
  // Wheels are written only while their journal day is (13, Journal).
  if (context.today != null && current.day !== context.today) return settle("refused", "closed");
  const { deleted: _, ...live } = current;
  commit(context, enqueue, {
    ...live,
    actual: p.actual,
    wanted: p.wanted,
    ...(p.deleted ? { deleted: true } : {}),
    step: undoing ? before(p, event.id) : event.id,
  });
  settle("applied");
}

const blank = (actual, wanted) => [...actual, ...wanted].every((s) => s === null);

// A new id adds a wheel to its day, unless it holds no score at all: that is not a wheel
// yet. A save to one already kept changes its scores and keeps its day, except that no
// score at all removes it: that is how the view says it is gone. Its tombstone keeps the
// scores it had, so it can still be restored. A deleted id stays deleted (5).
function applySave(context, event, enqueue) {
  if (!isId(event.id)) return;
  const was = context.wheels.get(event.id);
  if (was?.deleted) return;
  const actual = scores(event.actual);
  const wanted = scores(event.wanted);
  if (!was) {
    if (!isDay(event.day) || blank(actual, wanted)) return;
    return recordStep(context, enqueue, null, toRecord({ id: event.id, day: event.day, actual, wanted }), event);
  }
  if (blank(actual, wanted)) return recordStep(context, enqueue, was, { ...was, deleted: true }, event);
  const next = { ...was, actual, wanted };
  if (same(was, next)) {
    // A fold with nothing new to save still ends the stretch of rating.
    if (event.finished === true && context.stretch?.id === event.id) {
      context.stretch = null;
      enqueue.assign({ stretch: null });
    }
    return;
  }
  recordStep(context, enqueue, was, next, event);
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.payload.day, message.reply);
  else if (message.type === "wheel.saved") applySave(context, message, enqueue);
  else if (message.type === "step.undone" || message.type === "step.redone") applyStep(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(
  ["list?", "wheel.saved", "step.undone", "step.redone"].map((t) => [t, { actions: queue }]),
);

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
// every wheel it holds first: when it already holds one that is not deleted, this copy is
// emptied, outbox included, and the pull from 0 brings the account's. When it holds none,
// every wheel is queued for it on the version it holds, which the server adopts on first
// insert, and the cursor goes back to 0. A tombstone is not sent: the account never had
// the record, so there is nothing to delete. The mark is cleared only once every row is
// stored in the outbox, so a reload midway sends the copy again (coalesced by id) rather
// than losing it; when the account cannot be asked (offline), the mark stays and the next
// load decides. A mark left by a change of account that was called off names the account
// still signed in, and is only cleared.
async function keepFor(store, from, userId, api) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!Array.isArray(held?.wheels)) return;
    if (held.wheels.some((r) => isId(r?.id) && !r.deleted)) {
      await store.empty();
      await store.metaPut("userId", userId);
    } else {
      const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      for (const r of records.filter((r) => isId(r?.id) && isDay(r?.day)).map(toRecord)) {
        if (r.deleted || queued.has(r.id)) continue;
        const row = outboxRow(r, r.version);
        await store.outboxPut(row);
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
      const [wheels, outbox, cursor, userId, journal] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
        // Which day is today, for an Undo (12): a page without the journal answers nothing.
        ask ? ask("journal", "read", {}).catch(() => null) : null,
      ]);
      return { wheels, outbox, cursor: cursor ?? 0, userId: userId ?? null, today: todayFrom(journal) };
    }),
    // Missing (a Node test) is treated as signed out, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // Empties the local copy in one transaction, outbox and cache together (12).
    // With keep (12) the copy stays and is marked, under the account it came from, to be
    // added to the account the browser joins after the reload.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // It returns a summary the machine applies; it never emits (4.3). A network error
    // stops it with what it had; 401 reports the session is gone.
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
      return { acks, pulled: pulled.wheels, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "wheels",
  meta: {
    description:
      "Owns the Wheels of Life kept with the journal's days. A wheel is eight fixed areas (Health, " +
      "Work, Money, Family, Love, Friends, Growth, Fun), each with an Actual and a Wanted score " +
      "from 1 to 10 or none. Each one names its journal day by date and keeps that day for good. " +
      "`wheels: list` answers one day's wheels, or every day's when no day is given, oldest first; " +
      "the chat does not read it. A new wheel with no score at all is not kept, and a save that " +
      "leaves a kept wheel with no score at all deletes it at once; its tombstone keeps the " +
      "scores it had. Every change is a step Undo and Redo reverse (section 12): one stretch of " +
      "rating one wheel, from its first save until a save says finished, and a delete, which " +
      "asks for the short notice. Undo of a new wheel's first stretch deletes it, and a deleted " +
      "one comes back with a restore write the server accepts. A step is refused when the wheel " +
      "was written since by anything else, and when its journal day has closed, which it learns " +
      "from the journal. It works signed out, numbering versions itself, and syncs to the account " +
      "when signed in (section 5); signing in uploads every wheel with its history. The last write " +
      "wins, so two devices never conflict, and a deleted wheel is kept as a tombstone, which " +
      "always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["wheel.changed", "wheel.deleted", "step.recorded", "step.settled"],
    owns: "the Wheels of Life kept with each journal day",
    steps: { "wheel.saved": "step" },
    asks: ["session: read", "journal: read"],
  },
  context: ({ input }) => ({
    wheels: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    mint: input.mint ?? ulid,
    // Today's journal day, from the journal (13); null until it says, or on a page without it.
    today: null,
    // The stretch of rating still open (12, Undo): { step, id, before }, the step's id, the
    // wheel rated and how it was before the stretch; null when none is.
    stretch: null,
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
    "journal.changed": { actions: assign({ today: ({ context, event }) => todayFrom(event) ?? context.today }) },
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask, api: context.api }),
        onDone: {
          target: "checkingSession",
          actions: assign({
            wheels: ({ event }) =>
              new Map(event.output.wheels.filter((r) => isId(r?.id) && isDay(r?.day)).map((r) => [r.id, toRecord(r)])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
            today: ({ context, event }) => context.today ?? event.output.today,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "list?") message.reply({ wheels: [] });
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
          target: "ready.idle",
          actions: enqueueActions(({ context, event, enqueue }) => {
            context.userId = event.output?.userId ?? null;
            enqueue.assign({ userId: context.userId });
            ready(context, enqueue);
          }),
        },
        onError: {
          target: "ready.idle",
          actions: enqueueActions(({ context, enqueue }) => ready(context, enqueue)),
        },
      },
      on: QUEUED,
    },
    ready: {
      initial: "idle",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.payload.day, event.reply) },
        "wheel.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        // Signing in enqueues the whole cache, tombstones included, so what was made
        // signed out becomes the account's (5); a different user resets the cursor.
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
            for (const r of context.wheels.values()) {
              if (context.outbox.has(r.id)) continue;
              const row = outboxRow(r, r.version);
              context.outbox.set(r.id, row);
              enqueue(() => context.store.outboxPut(row).catch(() => {}));
            }
            enqueue.raise({ type: "_sync", pull: true });
          }),
        },
      },
      states: {
        // Leaving (12): what is left is uploaded at once, then the local copy is emptied.
        emptying: {
          invoke: {
            src: "empty",
            input: ({ context }) => ({ store: context.store, keep: context.keep, from: context.userId }),
            onDone: { target: "left" },
            onError: { target: "left" },
          },
        },
        // Emptied; a change made meanwhile is uploaded and emptied again. When the
        // change of account is called off, syncing goes on as before.
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
        "list?": { actions: ({ event }) => event.reply({ wheels: [] }) },
      },
    },
  },
});

// Adopt one record the server holds: its content and version.
// Announced as a change or, for a tombstone of a wheel this tab was showing, as gone.
function adopt(context, server, enqueue) {
  const held = context.wheels.get(server.id);
  const r = toRecord(server);
  context.wheels.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (r.deleted) {
    if (visible(held)) enqueue.emit({ type: "wheel.deleted", id: r.id, day: r.day });
  } else {
    enqueue.emit({ type: "wheel.changed", wheel: announce(context, r) });
  }
}

// Apply a sync's summary: adopt acknowledged and pulled records, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    const row = context.outbox.get(ack.id);
    const held = context.wheels.get(ack.id);
    // The server holds a tombstone (a delete always wins, 5): the wheel is gone here too.
    if (ack.deleted) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
      // This browser's own delete keeps the step that made it, so it can still be undone.
      if (held?.deleted && JSON.stringify(content(held)) === JSON.stringify(content(toRecord(ack)))) {
        const r = { ...held, version: ack.version };
        context.wheels.set(r.id, r);
        enqueue(() => context.store.put(r).catch(() => {}));
      } else adopt(context, ack, enqueue);
      continue;
    }
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    const drained = row && JSON.stringify(content(toRecord(row))) === JSON.stringify(content(toRecord(ack)));
    if (drained) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
    } else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    // Keep the latest local content (a mid-sync edit), take the server's version.
    const r = held ? { ...held, version: ack.version } : toRecord(ack);
    context.wheels.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    if (visible(r)) enqueue.emit({ type: "wheel.changed", wheel: announce(context, r) });
  }

  for (const server of pulled) {
    if (!isId(server?.id) || !isDay(server?.day)) continue;
    const current = context.wheels.get(server.id);
    if (current && server.version <= current.version) continue;
    // A local change not yet sent is the later write, so it wins (last write wins) and is
    // sent at the next drain; a delete there always wins (5). Otherwise a live copy of a
    // local tombstone at a higher version is a restore write made elsewhere (5).
    if (context.outbox.has(server.id) && !server.deleted) continue;
    if (server.deleted && context.outbox.has(server.id)) {
      context.outbox.delete(server.id);
      enqueue(() => context.store.outboxDelete(server.id).catch(() => {}));
    }
    if (server.deleted && !current) {
      const r = toRecord(server);
      context.wheels.set(r.id, r);
      enqueue(() => context.store.put(r).catch(() => {}));
      continue;
    }
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
