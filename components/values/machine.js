import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the client's values (3.1), replicated (5) the way
// `choice-points` is: local-first, cached in the browser, numbering versions itself while
// signed out and syncing to the per-user server when signed in, the last write winning.
// A record is one day's version, keyed by its day, and nothing is ever deleted. The view
// where the user acted emits values.saved (4.3, fifth rule). Everything with a side
// effect (the store, the network, the ask, the clock) arrives through input, so this stays
// a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isDay = (v) => typeof v === "string" && DAY.test(v);
const str = (v) => (typeof v === "string" ? v : "");

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD: "today" is the user's day, not UTC's,
// the same day the journal calls today.
const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// --- Records --------------------------------------------------------------------------

const value = (v) => ({ id: v.id, name: str(v.name), meaning: str(v.meaning) });
const valuesOf = (list) => (Array.isArray(list) ? list.filter((v) => typeof v?.id === "string" && ULID.test(v.id)).map(value) : []);

// One fixed shape and key order, so two copies of the same content compare equal as
// text.
const record = (r) => ({
  day: r.day,
  values: valuesOf(r.values),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const byDay = (a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
const sorted = (context) => [...context.versions.values()].sort(byDay);

// The version in force on `day`: the latest one written on or before it, or the latest
// of all when no day is given.
const inForce = (context, day) => {
  const list = sorted(context).filter((r) => day === undefined || r.day <= day);
  return list.at(-1) ?? null;
};

function replyRead(context, day, reply) {
  const found = inForce(context, day);
  const changedSince = day !== undefined && [...context.versions.values()].some((r) => r.day > day);
  reply({ day: found ? found.day : null, values: found ? found.values : [], changedSince });
}

const replyVersions = (context, reply) => reply({ days: sorted(context).map((r) => r.day) });

const announce = (r) => ({ type: "values.changed", day: r.day, values: r.values });

// --- Changes --------------------------------------------------------------------------

const outboxRow = (r, baseVersion) => ({ day: r.day, values: r.values, baseVersion });

// The one place a changed version is kept, stored and announced. Signed out the next
// version is minted here; signed in it keeps the version it holds, is queued in the
// outbox (coalesced by day, keeping the first unsynced base) and a drain is asked for.
function commit(context, enqueue, next) {
  const current = context.versions.get(next.day);
  const r = context.userId == null ? { ...next, version: current ? current.version + 1 : 1 } : { ...next, version: current ? current.version : 1 };
  context.versions.set(r.day, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (context.userId != null) {
    const existing = context.outbox.get(r.day);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null);
    context.outbox.set(r.day, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  enqueue.emit(announce(r));
  if (context.userId != null) enqueue.raise({ type: "_drain" });
}

// Only today's version is written: a save naming any other day is ignored, also
// yesterday's in the hour after midnight while its journal text is still open, so a
// version never changes after its day. A save that leaves the values as they are in
// force today is no change, so opening the sheet and closing it writes no version.
function applySave(context, event, enqueue) {
  if (!isDay(event.day) || event.day !== dateOf(context.now())) return;
  const values = valuesOf(event.values);
  const held = inForce(context, event.day);
  if (same(held ? held.values : [], values)) return;
  commit(context, enqueue, { day: event.day, values, version: 1 });
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "read?") replyRead(context, message.payload.day, message.reply);
  else if (message.type === "versions?") replyVersions(context, message.reply);
  else if (message.type === "values.saved") applySave(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(["read?", "versions?", "values.saved"].map((t) => [t, { actions: queue }]));

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
async function claim(store, ask) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, outbox, from] = await Promise.all([store.metaGet("userId"), store.outboxAll(), store.metaGet("adopt")]);
  if (kept && kept !== userId && outbox.length === 0 && !from) await store.empty();
  if (kept !== userId) await store.metaPut("userId", userId).catch(() => {});
  await keepFor(store, from, userId);
}

// The browser joined an account keeping this copy (12, keep): every version is queued
// for the account on the version it holds, which the server adopts on first insert, and
// the cursor goes back to 0, so the pull then brings the account's own. The mark is
// cleared only once every row is stored in the outbox, so a reload midway sends the copy
// again (coalesced by day) rather than losing it. A mark left by a change of account that
// was called off names the account still signed in, and is only cleared.
async function keepFor(store, from, userId) {
  if (!from) return;
  if (from !== userId) {
    const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
    const queued = new Set(outbox.map((row) => row.day));
    for (const r of records.filter((r) => isDay(r?.day)).map(record)) {
      if (queued.has(r.day)) continue;
      await store.outboxPut(outboxRow(r, r.version));
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
      const { store, ask } = input;
      await claim(store, ask);
      const [versions, outbox, cursor, userId] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      return { versions, outbox, cursor: cursor ?? 0, userId: userId ?? null };
    }),
    // Missing (a Node test) is treated as signed out, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // Empties the local copy in one transaction, outbox and cache together (12).
    // With keep (12) the copy stays and is marked, under the account it came from, to be
    // added to the account the browser joins after the reload.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // One sync: drain the outbox in day order, then pull what changed since the cursor
    // when asked to. It returns a summary the machine applies; it never emits (4.3). A
    // network error stops it with what it had; 401 reports the session is gone.
    sync: fromPromise(async ({ input }) => {
      const { api, store, rows, cursor, pull } = input;
      const acks = [];
      for (const row of [...rows].sort(byDay)) {
        let result;
        try {
          result = await api.put(row);
        } catch {
          return { acks, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, authFailed: true };
        acks.push(result);
        await store.outboxDelete(row.day).catch(() => {});
      }
      if (!pull) return { acks };
      let pulled;
      try {
        pulled = await api.pull(cursor);
      } catch {
        return { acks, networkError: true };
      }
      if (pulled.error === "unauthorized") return { acks, authFailed: true };
      return { acks, pulled: pulled.versions, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "values",
  meta: {
    description:
      "Owns the client's values: one list per account, each value a short name and an " +
      "optional sentence saying what it means. Every version is kept by day: a day's version " +
      "is the list as it stood at the end of that day, and only today's is written, so an " +
      "edit made today replaces today's version and an earlier day's never changes; a save " +
      "naming any other day is ignored, also yesterday's in the hour after midnight while " +
      "its journal text is still open. A save that leaves the values as they stand is no " +
      "change and writes no version. A removed value is gone from today's version only; " +
      "earlier days keep theirs, so their marks stay as they were checked. " +
      "`values: read` answers the version in force on a day, the latest one on or before it, " +
      "or the current one when no day is given, and says whether the values changed after " +
      "it; the chat may use it as a lookup, Reading your values. `values: versions` answers " +
      "the days on which the values changed, oldest first. `values.changed` announces each " +
      "version written here or arriving from another device, with its day. It works signed " +
      "out, numbering versions itself, and syncs to the account when signed in (section 5); " +
      "signing in uploads every version. The last write wins, so two devices never conflict. " +
      "`evaluators` builds the evaluator Your values from a day's version, one question per " +
      "value, and every value counts toward its one mark; with no values it has no " +
      "questions, so a Towards line gets no values mark at all rather than a grey one.",
    kind: "fact",
    shape: "replicated",
    emits: ["values.changed"],
    owns: "the client's values and their versions by day",
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    versions: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    now: input.now ?? (() => Date.now()),
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
        input: ({ context }) => ({ store: context.store, ask: context.ask }),
        onDone: {
          target: "checkingSession",
          actions: assign({
            versions: ({ event }) => new Map(event.output.versions.filter((r) => isDay(r?.day)).map((r) => [r.day, record(r)])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.day, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) answerEmpty(message);
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: QUEUED,
    },
    // The store is loaded; confirm who is signed in before flushing, so a
    // change is made with the right signed-out or signed-in rule.
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
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload.day, event.reply) },
        "versions?": { actions: ({ context, event }) => replyVersions(context, event.reply) },
        "values.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        // Signing in enqueues every version, so what was written signed out becomes the
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
            for (const r of context.versions.values()) {
              if (context.outbox.has(r.day)) continue;
              const row = outboxRow(r, r.version);
              context.outbox.set(r.day, row);
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
        "read?": { actions: ({ event }) => answerEmpty(event) },
        "versions?": { actions: ({ event }) => answerEmpty(event) },
      },
    },
  },
});

// A fact whose store could not be read answers as one that holds no values.
function answerEmpty(message) {
  if (message.type === "read?") message.reply({ day: null, values: [], changedSince: false });
  else if (message.type === "versions?") message.reply({ days: [] });
}

// Apply a sync's summary: adopt acknowledged and pulled versions, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    if (!isDay(ack?.day)) continue;
    const row = context.outbox.get(ack.day);
    const held = context.versions.get(ack.day);
    const server = record(ack);
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    if (row && same(valuesOf(row.values), server.values)) {
      context.outbox.delete(ack.day);
      enqueue(() => context.store.outboxDelete(ack.day).catch(() => {}));
    } else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.day, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    // Keep the latest local content (a mid-sync edit), take the server's version.
    const r = held ? { ...held, version: server.version } : server;
    context.versions.set(r.day, r);
    enqueue(() => context.store.put(r).catch(() => {}));
  }

  for (const incoming of pulled ?? []) {
    if (!isDay(incoming?.day)) continue;
    const current = context.versions.get(incoming.day);
    const r = record(incoming);
    if (current && r.version <= current.version) continue;
    // A local change not yet sent is the later write, so it wins (last write wins) and is
    // sent at the next drain.
    if (context.outbox.has(r.day)) continue;
    context.versions.set(r.day, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    if (!current || !same(current.values, r.values)) enqueue.emit(announce(r));
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
