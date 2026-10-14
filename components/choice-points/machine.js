import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the choice points (3.1), replicated (5) the way
// `evaluators` is: local-first, cached in the browser, numbering versions itself while
// signed out and syncing to the per-user server when signed in. The last write wins and
// a delete is a tombstone that always wins (5). The view where the user acted emits
// choice-point.saved and removal.started; notice-stack emits removal.undone or
// removal.settled when the undo window ends (4.3, fifth rule). Everything with a side
// effect (the store, the network, the ask) arrives through input, so this stays a pure
// definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const isDay = (v) => typeof v === "string" && DAY.test(v);
const str = (v) => (typeof v === "string" ? v : "");

const TEXTS = ["situation", "thoughts", "away", "towards"];

// The id is a ULID the view minted when the user added the choice point, so its first ten
// characters are that moment; reading it from there needs no clock here and no column on
// the server.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const createdAt = (id) => new Date([...id.slice(0, 10)].reduce((ms, c) => ms * 32 + CROCKFORD.indexOf(c), 0)).toISOString();

// --- Records --------------------------------------------------------------------------

// One fixed shape and key order, so two copies of the same content compare equal as
// text. `removing` marks a choice point in this tab's undo window; it is kept in the
// cache (so a leftover mark settles at the next load) but never sent to the server.
const record = (r) => ({
  id: r.id,
  day: r.day,
  situation: str(r.situation),
  thoughts: str(r.thoughts),
  away: str(r.away),
  towards: str(r.towards),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  removing: r.removing === true,
  ...(r.deleted === true ? { deleted: true } : {}),
});

// What a write carries, and what decides whether a change is a new version. The mark
// belongs to this tab's undo window, so setting or clearing it is not a change.
const content = (r) => ({ day: r.day, situation: r.situation, thoughts: r.thoughts, away: r.away, towards: r.towards });
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

// A tombstone is kept for the sync (5) but never listed or announced as a change.
const visible = (r) => r && !r.deleted;

const announce = (context, r) => {
  const { deleted, version, removing, ...rest } = r;
  return { ...rest, createdAt: createdAt(r.id), version, pending: context.outbox.has(r.id), removing };
};

function replyList(context, day, reply) {
  const choicePoints = [...context.choicePoints.values()]
    .filter((r) => visible(r) && (day === undefined || r.day === day))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => announce(context, r));
  reply({ choicePoints });
}

// --- Changes --------------------------------------------------------------------------

// The one place a changed record is kept, stored and announced. A change of content is
// a new version: signed out it is minted here; signed in the record keeps the version
// it holds, is queued in the outbox (coalesced by id, keeping the first unsynced base)
// and a drain is asked for. A change of the mark only is stored and announced, not synced.
function commit(context, enqueue, next) {
  const current = context.choicePoints.get(next.id);
  const changed = !current || !same(current, next) || Boolean(next.deleted) !== Boolean(current.deleted);
  let r = next;
  if (changed && context.userId == null) r = { ...next, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...next, version: current.version };
  context.choicePoints.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (changed && context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null);
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  if (r.deleted) {
    if (visible(current)) enqueue.emit({ type: "choice-point.deleted", id: r.id, day: r.day });
  } else {
    enqueue.emit({ type: "choice-point.changed", choicePoint: announce(context, r) });
  }
  if (changed && context.userId != null) enqueue.raise({ type: "_drain" });
}

const outboxRow = (r, baseVersion) => ({ id: r.id, ...content(r), baseVersion, ...(r.deleted ? { deleted: true } : {}) });

// A new id adds a choice point to its day, unless all four texts are empty: the view may
// save a sheet the user opened and left blank, and that is not a choice point yet. A save
// to one already kept changes its texts and keeps its day and its mark. A deleted id
// stays deleted (5).
function applySave(context, event, enqueue) {
  if (!isId(event.id)) return;
  const was = context.choicePoints.get(event.id);
  if (was?.deleted) return;
  const texts = Object.fromEntries(TEXTS.map((k) => [k, str(event[k])]));
  if (!was) {
    if (!isDay(event.day) || TEXTS.every((k) => texts[k] === "")) return;
    return commit(context, enqueue, record({ id: event.id, day: event.day, ...texts }));
  }
  const next = { ...was, ...texts };
  if (same(was, next)) return;
  commit(context, enqueue, next);
}

// An id that is not one of the choice points' own matches nothing, so other facts'
// removals pass by.
function applyMark(context, { kind, id }, removing, enqueue) {
  if (kind !== "choice-point") return;
  const r = context.choicePoints.get(id);
  if (!visible(r) || r.removing === removing) return;
  commit(context, enqueue, { ...r, removing });
}

// Only a choice point still marked settles: one that was undone stays.
function applySettle(context, { kind, id }, enqueue) {
  if (kind !== "choice-point") return;
  const r = context.choicePoints.get(id);
  if (!visible(r) || !r.removing) return;
  commit(context, enqueue, { ...r, removing: false, deleted: true });
}

// At load no tab can undo anything any more, because the tab that showed the undo
// notice is gone, so every leftover mark settles.
function settleAll(context, enqueue) {
  for (const r of [...context.choicePoints.values()].filter(visible)) {
    if (r.removing) applySettle(context, { kind: "choice-point", id: r.id }, enqueue);
  }
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.payload.day, message.reply);
  else if (message.type === "choice-point.saved") applySave(context, message, enqueue);
  else if (message.type === "removal.started") applyMark(context, message, true, enqueue);
  else if (message.type === "removal.undone") applyMark(context, message, false, enqueue);
  else if (message.type === "removal.settled") applySettle(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(
  ["list?", "choice-point.saved", "removal.started", "removal.undone", "removal.settled"].map((t) => [t, { actions: queue }]),
);

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

const ready = (context, enqueue) => {
  settleAll(context, enqueue);
  for (const message of context.queued) flush(context, message, enqueue);
  enqueue.assign({ queued: [] });
  if (context.userId) enqueue.raise({ type: "_sync", pull: true });
};

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0,
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store } = input;
      const [choicePoints, outbox, cursor, userId] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      return { choicePoints, outbox, cursor: cursor ?? 0, userId: userId ?? null };
    }),
    // Missing (a Node test) is treated as signed out, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
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
      return { acks, pulled: pulled.choicePoints, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "choice-points",
  meta: {
    description:
      "Owns the choice points kept with the journal's days. A choice point is one worksheet " +
      "from acceptance and commitment therapy: the situation, the thoughts and feelings it " +
      "brought, what the user did or would do when hooked (away) and when unhooked (towards). " +
      "Each one names its journal day by date and keeps that day for good. `choice-points: list` " +
      "answers one day's choice points, or every day's when no day is given, oldest first. A " +
      "choice point the user opened and left with all four boxes empty is not kept. It works " +
      "signed out, numbering versions itself, and syncs to the account when signed in " +
      "(section 5); signing in uploads every choice point with its history. The last write " +
      "wins, so two devices never conflict, and a deleted choice point is kept as a tombstone, " +
      "which always wins. A removed choice point is marked while its undo window runs and goes " +
      "only when the window ends; a mark left by a closed tab ends at the next load.",
    kind: "fact",
    shape: "replicated",
    emits: ["choice-point.changed", "choice-point.deleted"],
    owns: "the choice points kept with each journal day",
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    choicePoints: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    userId: null,
    cursor: 0,
    queued: [],
    resync: false,
    pull: false,
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store }),
        onDone: {
          target: "checkingSession",
          actions: assign({
            choicePoints: ({ event }) =>
              new Map(event.output.choicePoints.filter((r) => isId(r?.id) && isDay(r?.day)).map((r) => [r.id, record(r)])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "list?") message.reply({ choicePoints: [] });
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: QUEUED,
    },
    // The store is loaded; confirm who is signed in before settling and flushing, so a
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
        "list?": { actions: ({ context, event }) => replyList(context, event.payload.day, event.reply) },
        "choice-point.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        "removal.started": { actions: enqueueActions(({ context, event, enqueue }) => applyMark(context, event, true, enqueue)) },
        "removal.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyMark(context, event, false, enqueue)) },
        "removal.settled": { actions: enqueueActions(({ context, event, enqueue }) => applySettle(context, event, enqueue)) },
        // Signing in enqueues the whole cache, tombstones included, so what was made
        // signed out becomes the account's (5); a different user resets the cursor.
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const userId = event.userId;
            if (userId === context.userId) return;
            enqueue.assign({ userId });
            enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
            if (!userId) return;
            enqueue.assign({ cursor: 0 });
            enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
            for (const r of context.choicePoints.values()) {
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
        idle: {
          on: {
            _drain: { guard: "syncable", target: "debouncing" },
            _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
          },
        },
        // A _drain reenters, which restarts the window; a focus, sign-in or hidden tab
        // (_sync) does not wait.
        debouncing: {
          on: {
            _drain: { target: "debouncing", reenter: true },
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
              pull: Boolean(event.pull),
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
            _sync: { actions: assign({ resync: true, pull: ({ context, event }) => context.pull || Boolean(event.pull) }) },
          },
        },
      },
    },
    failed: {
      on: {
        "list?": { actions: ({ event }) => event.reply({ choicePoints: [] }) },
      },
    },
  },
});

// Adopt one record the server holds: its content and version, with this tab's mark kept.
// Announced as a change or, for a tombstone of a choice point this tab was showing, as gone.
function adopt(context, server, enqueue) {
  const held = context.choicePoints.get(server.id);
  const r = record({ ...server, removing: !server.deleted && held?.removing });
  context.choicePoints.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (r.deleted) {
    if (visible(held)) enqueue.emit({ type: "choice-point.deleted", id: r.id, day: r.day });
  } else {
    enqueue.emit({ type: "choice-point.changed", choicePoint: announce(context, r) });
  }
}

// Apply a sync's summary: adopt acknowledged and pulled records, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    const row = context.outbox.get(ack.id);
    const held = context.choicePoints.get(ack.id);
    // The server holds a tombstone (a delete always wins, 5): the choice point is gone here too.
    if (ack.deleted) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
      adopt(context, ack, enqueue);
      continue;
    }
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    const drained = row && JSON.stringify(content(record(row))) === JSON.stringify(content(record(ack)));
    if (drained) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
    } else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    // Keep the latest local content (a mid-sync edit), take the server's version.
    const r = held ? { ...held, version: ack.version } : record(ack);
    context.choicePoints.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    if (visible(r)) enqueue.emit({ type: "choice-point.changed", choicePoint: announce(context, r) });
  }

  for (const server of pulled) {
    if (!isId(server?.id) || !isDay(server?.day)) continue;
    const current = context.choicePoints.get(server.id);
    if (current && server.version <= current.version) continue;
    // A local tombstone is never revived, and a local change not yet sent is the later
    // write, so it wins (last write wins) and is sent at the next drain.
    if (current && current.deleted) continue;
    if (context.outbox.has(server.id) && !server.deleted) continue;
    if (server.deleted && context.outbox.has(server.id)) {
      context.outbox.delete(server.id);
      enqueue(() => context.store.outboxDelete(server.id).catch(() => {}));
    }
    if (server.deleted && !current) {
      const r = record(server);
      context.choicePoints.set(r.id, r);
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
