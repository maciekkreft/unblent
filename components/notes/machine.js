import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The fact component that owns the notes (3.1), replicated (5): local-first, the
// single place a note lives in the browser, syncing to the per-user server when
// signed in. Anonymous, it mints versions locally and announces at once, the
// anonymous behaviour that keeps every no-server feature working. Signed
// in, an edit is cached pending and queued in the outbox; a sync drains the outbox
// and pulls what changed, so work continues across devices. Who is signed in comes
// from `session` (one query on start, session.changed after, 4.3). Everything with
// a side effect — the store, the clock, the network, the ask — arrives through
// input, so this stays a pure definition importable in Node.

const listRow = ({ id, title, updatedAt }) => ({ id, title, updatedAt });

function replyList(context, reply) {
  const notes = [...context.notes.values()]
    .map(listRow)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  reply({ notes });
}

function replyRead(context, id, reply) {
  const stored = context.notes.get(id);
  // pending reports the record has a local change the server has not acknowledged (5).
  reply(stored ? { note: { ...stored, pending: context.outbox.has(id) } } : { error: "not-found" });
}

// The user's gesture (4.3, fifth rule). Anonymous: local minting, announced with
// pending false (there is no server to wait for). Signed in: the held version is
// kept, the change is cached and queued in the outbox (coalesced by id, keeping the
// base the first unsynced edit was on), announced pending, and a sync is asked for.
function applySave(context, event, enqueue) {
  const { id, title, body, baseVersion } = event;
  const current = context.notes.get(id);

  if (context.userId == null) {
    if (current && baseVersion !== current.version) {
      enqueue.emit({
        type: "note.conflicted",
        id,
        mine: { title, body, baseVersion },
        theirs: { title: current.title, body: current.body, version: current.version, updatedAt: current.updatedAt },
      });
      return;
    }
    if (current && title === current.title && body === current.body) return;
    const version = current ? current.version + 1 : baseVersion === null ? 1 : baseVersion + 1;
    const record = { id, title, body, version, updatedAt: context.now() };
    context.notes.set(id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit({ type: "note.changed", ...record, pending: false });
    return;
  }

  // Signed in: nothing pending and the same text is not a change (5, idempotent).
  if (current && title === current.title && body === current.body && !context.outbox.has(id)) return;
  const version = current ? current.version : 1;
  const record = { id, title, body, version, updatedAt: context.now() };
  context.notes.set(id, record);
  enqueue(() => context.store.put(record).catch(() => {}));
  const existing = context.outbox.get(id);
  const row = { id, title, body, baseVersion: existing ? existing.baseVersion : current ? current.version : null };
  context.outbox.set(id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
  enqueue.emit({ type: "note.changed", ...record, pending: true });
  enqueue.raise({ type: "_sync" });
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "read?") replyRead(context, message.payload.id, message.reply);
  else if (message.type === "note.saved") applySave(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

// The window the network is coalesced over (4.3, third rule): a run of saves, a
// tab-focus and a sign-in all ask to sync, and one drain at the window's end
// carries the coalesced outbox instead of one PUT per throttled keystroke.
const SYNC_DEBOUNCE_MS = 500;

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store } = input;
      const [notes, outbox, cursor, userId] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      return { notes, outbox, cursor: cursor ?? 0, userId: userId ?? null };
    }),
    // Who is signed in, for the starting picture (4.3). Missing (no ask on the page,
    // or in a Node test) is treated as anonymous, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // One sync: drain the outbox in id order, then pull what changed since the
    // cursor. It returns a summary the machine applies; it never emits (only the
    // machine does, 4.3). A network error stops it with what it had; 401 reports the
    // session is gone. The store deletes happen here so a drained row is durably gone.
    sync: fromPromise(async ({ input }) => {
      const { api, store, rows, cursor } = input;
      const acks = [];
      const conflicts = [];
      for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        let result;
        try {
          result = await api.put(row);
        } catch {
          return { acks, conflicts, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, conflicts, authFailed: true };
        if (result.conflict) {
          conflicts.push({ id: row.id, mine: row, theirs: result.note });
          await store.outboxDelete(row.id).catch(() => {});
        } else {
          acks.push(result);
          await store.outboxDelete(row.id).catch(() => {});
        }
      }
      let pulled;
      try {
        pulled = await api.pull(cursor);
      } catch {
        return { acks, conflicts, networkError: true };
      }
      if (pulled.error === "unauthorized") return { acks, conflicts, authFailed: true };
      return { acks, conflicts, pulled: pulled.notes, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "notes",
  meta: {
    kind: "fact",
    shape: "replicated",
    emits: ["note.changed", "note.deleted", "note.conflicted"],
    owns: "the notes",
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    notes: new Map(),
    outbox: new Map(),
    store: input.store,
    now: input.now,
    api: input.api,
    ask: input.ask,
    userId: null,
    cursor: 0,
    queued: [],
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
            notes: ({ event }) => new Map(event.output.notes.map((row) => [row.id, row])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) {
              if (message.type === "list?") message.reply({ notes: [] });
              else if (message.type === "read?") message.reply({ error: "not-found" });
            }
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "note.saved": { actions: queue },
      },
    },
    // The store is loaded; confirm who is signed in before flushing, so an early
    // gesture is applied with the right anonymous-or-signed-in rule.
    checkingSession: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready.idle",
          actions: enqueueActions(({ context, event, enqueue }) => {
            const userId = event.output?.userId ?? null;
            enqueue.assign({ userId });
            for (const message of context.queued) flush(context, message, enqueue);
            enqueue.assign({ queued: [] });
            if (userId) enqueue.raise({ type: "_sync" });
          }),
        },
        onError: {
          target: "ready.idle",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) flush(context, message, enqueue);
            enqueue.assign({ queued: [] });
            if (context.userId) enqueue.raise({ type: "_sync" });
          }),
        },
      },
      on: {
        "list?": { actions: queue },
        "read?": { actions: queue },
        "note.saved": { actions: queue },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload.id, event.reply) },
        "note.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        // The fact's own news about who is signed in (4.3, fourth rule). A different
        // user resets the pull cursor (the cache is kept, to be pushed up); signing
        // in enqueues the cache so anonymous work becomes the account's, then syncs.
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const userId = event.userId;
            if (userId === context.userId) return;
            enqueue.assign({ userId });
            enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
            if (userId) {
              enqueue.assign({ cursor: 0 });
              enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
              for (const note of context.notes.values()) {
                if (!context.outbox.has(note.id)) {
                  const row = { id: note.id, title: note.title, body: note.body, baseVersion: note.version };
                  context.outbox.set(note.id, row);
                  enqueue(() => context.store.outboxPut(row).catch(() => {}));
                }
              }
              enqueue.raise({ type: "_sync" });
            }
          }),
        },
      },
      states: {
        idle: {
          on: {
            _sync: { guard: "syncable", target: "debouncing" },
          },
        },
        // The network debounce (4.3): a save, a tab-focus or a sign-in opens the
        // window; further _sync inside it are targetless so the window is bounded,
        // not restarted (the editor's throttle construction), and the one drain at
        // its end carries whatever the outbox coalesced. Signed out mid-window, the
        // fallback returns to idle rather than sync with no user.
        debouncing: {
          on: {
            _sync: {},
          },
          after: {
            [SYNC_DEBOUNCE_MS]: [{ guard: "syncable", target: "syncing" }, { target: "idle" }],
          },
        },
        syncing: {
          entry: assign({ resync: false }),
          invoke: {
            src: "sync",
            input: ({ context }) => ({
              api: context.api,
              store: context.store,
              rows: [...context.outbox.values()],
              cursor: context.cursor,
            }),
            onDone: {
              target: "idle",
              actions: [
                enqueueActions(({ context, event, enqueue }) => applySync(context, event.output, enqueue)),
                // A gesture that arrived mid-sync left a row, or a _sync was asked
                // for again: drain once more, unless the session went away or the
                // network failed (retry then waits for the next trigger).
                enqueueActions(({ context, event, enqueue }) => {
                  const { authFailed, networkError } = event.output;
                  if (authFailed || networkError) return;
                  if (context.resync || context.outbox.size > 0) enqueue.raise({ type: "_sync" });
                }),
              ],
            },
            onError: { target: "idle" },
          },
          on: {
            _sync: { actions: assign({ resync: true }) },
          },
        },
      },
    },
    failed: {
      on: {
        "list?": { actions: ({ event }) => event.reply({ notes: [] }) },
        "read?": { actions: ({ event }) => event.reply({ error: "not-found" }) },
      },
    },
  },
});

// Apply a sync's summary: adopt acknowledged and pulled records, surface conflicts,
// advance the cursor, and drop the session on a 401. Kept out of the machine body
// so the state chart stays readable.
function applySync(context, output, enqueue) {
  const { acks = [], conflicts = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    const row = context.outbox.get(ack.id);
    // The row is fully drained when it still holds the text the server acknowledged;
    // a newer edit during the sync leaves a newer row, so it stays pending and the
    // outbox base advances to the version just assigned.
    const drained = row && row.title === ack.title && row.body === ack.body;
    if (drained) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
    } else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    const held = context.notes.get(ack.id);
    // Keep the latest local text (a mid-sync edit), take the server's version.
    const record = {
      id: ack.id,
      title: held ? held.title : ack.title,
      body: held ? held.body : ack.body,
      version: ack.version,
      updatedAt: ack.updatedAt,
    };
    context.notes.set(ack.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit({ type: "note.changed", ...record, pending: !drained });
  }

  for (const conflict of conflicts) {
    context.outbox.delete(conflict.id);
    enqueue(() => context.store.outboxDelete(conflict.id).catch(() => {}));
    const theirs = conflict.theirs;
    const record = { id: conflict.id, title: theirs.title, body: theirs.body, version: theirs.version, updatedAt: theirs.updatedAt };
    context.notes.set(conflict.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit({
      type: "note.conflicted",
      id: conflict.id,
      mine: { title: conflict.mine.title, body: conflict.mine.body, baseVersion: conflict.mine.baseVersion },
      theirs: { title: theirs.title, body: theirs.body, version: theirs.version, updatedAt: theirs.updatedAt },
    });
    enqueue.emit({ type: "note.changed", ...record, pending: false });
  }

  for (const note of pulled) {
    const current = context.notes.get(note.id);
    if (current && note.version <= current.version) continue;
    const record = { id: note.id, title: note.title, body: note.body, version: note.version, updatedAt: note.updatedAt };
    context.notes.set(note.id, record);
    enqueue(() => context.store.put(record).catch(() => {}));
    enqueue.emit({ type: "note.changed", ...record, pending: context.outbox.has(note.id) });
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
