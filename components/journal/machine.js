import { setup, enqueueActions, fromPromise, and, assign } from "xstate";

// The fact component that owns the journal (3.1), replicated (5): its days. journal-entry,
// where the user writes, emits day.saved (4.3, fifth rule); this fact keeps it, stores
// each changed day, announces the whole journal as journal.changed and answers
// journal: read for the starting picture. The "today only" rule lives here, in how
// day.saved is handled, and nowhere else. While signed out it numbers versions itself,
// as notes does (5). Everything with a side effect (the store, the clock, the ask)
// arrives through `input`, so the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const HOUR = 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD: "today" is the user's day, not UTC's.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// The local midnight that ends `day`. Built from the calendar date, so a day that is 23
// or 25 hours long across a clock change still ends at its own midnight.
const endOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + 1).getTime();
};

// The day that can still be edited at `now`, or null: the one whose date is today, or
// that was edited less than an hour ago, so writing past midnight keeps going in the
// same entry. A new day is only started while none is open, so at most one qualifies;
// the latest edited wins should a clock change ever let two.
export const openDay = (days, now) =>
  days
    .filter((d) => !d.deleted && (d.day === dateOf(now) || now - d.editedAt < HOUR))
    .reduce((a, b) => (a && a.editedAt >= b.editedAt ? a : b), null);

// The earliest moment the open day can close. Only a schedule: whether it is open is
// always decided by openDay, so a clock set back merely re-checks early.
const closesAt = (day) => Math.max(endOf(day.day), day.editedAt + HOUR);

const version = (v) => (Number.isInteger(v) && v >= 1 ? v : 1);

// A day in its stored shape, or null when it has no valid id. `deleted` marks a
// tombstone (5): kept so a later sync tells other devices, never shown.
const dayRecord = (d) =>
  d && isId(d.id) && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
    ? {
        id: d.id,
        day: d.day,
        text: str(d.text),
        editedAt: Number.isInteger(d.editedAt) ? d.editedAt : 0,
        version: version(d.version),
        ...(d.deleted === true ? { deleted: true } : {}),
      }
    : null;

// --- Changes --------------------------------------------------------------------------

// A day as another device would be told it: the version is not part of it.
const content = (r) => JSON.stringify(r, (k, v) => (k === "version" ? undefined : v));

// The next list with versions minted locally (5, while signed out): a day whose content
// changed takes the next version; a new one starts at 1.
const mint = (old, next) => {
  const was = new Map(old.map((r) => [r.id, r]));
  return next.map((r) => {
    const o = was.get(r.id);
    if (!o) return { ...r, version: 1 };
    return { ...r, version: content(o) === content(r) ? o.version : o.version + 1 };
  });
};

// A save to the open day, or a new day while none is open. A new day takes today's date
// at its first character, so an empty new day is not a day yet. A save to any other day
// is refused: this is the one place the "today only" rule is kept.
const daySaved = (days, { id, text }, now) => {
  const open = openDay(days, now);
  const was = days.find((d) => d.id === id);
  if (was) {
    if (open?.id !== id || was.text === text) return null;
    return mint(days, days.map((d) => (d.id === id ? { ...d, text, editedAt: now } : d)));
  }
  if (open || text === "") return null;
  return [...days, { id, day: dateOf(now), text, editedAt: now, version: 1 }];
};

// --- The picture ----------------------------------------------------------------------

// journal.changed and journal: read keep the fields of the journal's detectors and Jev's
// answers, because contracts only grow (7.1); the journal holds none, so they are empty,
// and the reason Jev is not reading is that no detector is on.
const body = (c) => {
  const open = openDay(c.days, c.now());
  return {
    days: c.days
      .filter((d) => !d.deleted)
      .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id))
      .map(({ id, day, text, editedAt, version }) => ({ id, day, text, editedAt, version, waiting: [], unanswered: [] })),
    projects: [],
    detectors: [],
    answers: [],
    open: open?.id ?? null,
    reason: "no-detector",
  };
};

// --- The actor ------------------------------------------------------------------------

// A day's row in the outbox, keyed by kind and id; the kind is the server's route.
const TABLE = "days";
const rowKey = (r) => `${TABLE}\n${r.id}`;

// Stores every day that differs from what was held, so a keystroke writes one day, not
// the journal.
const persist = (store, held, next, enqueue) => {
  const was = new Map(held.map((r) => [r.id, r]));
  for (const r of next) if (!same(was.get(r.id), r)) enqueue(() => store.put(TABLE, r).catch(() => {}));
};

// The open day closes by time alone, once its date has passed and an hour after its last
// edit, with nobody acting, so a timer wakes the fact then to re-check it and announce
// the closing. It is re-armed after every change, since an edit moves the moment.
const arm = (enqueue, days, now) => {
  enqueue.cancel("close");
  const open = openDay(days, now);
  // setTimeout fires at once past 2^31 ms, so a clock set far back would otherwise spin.
  if (open) enqueue.raise({ type: "_close" }, { id: "close", delay: Math.min(closesAt(open) - now, 2 ** 31 - 1) });
};

const announce = (enqueue, c) => {
  const picture = body(c);
  enqueue.assign({ open: picture.open });
  enqueue.emit({ type: "journal.changed", ...picture });
};

// --- The outbox (5) -------------------------------------------------------------------

// What the server keeps of a day: not its version (the server's to assign) or the
// tombstone flag (sent beside it).
const wire = ({ version: _, deleted: __, ...r }) => r;

// One row per day, so three offline edits become one write. The base stays the one the
// first unsynced change was on, which is what the server compares the write against.
const enqueueRow = (c, enqueue, r, base) => {
  const key = rowKey(r);
  const existing = c.outbox.get(key);
  const row = { key, table: TABLE, record: wire(r), baseVersion: existing ? existing.baseVersion : base };
  if (r.deleted) row.deleted = true;
  c.outbox.set(key, row);
  enqueue(() => c.store.outboxPut(row).catch(() => {}));
};

// Queues every day whose content changed between `held` and `next`.
const enqueueChanges = (c, enqueue, held, next) => {
  const was = new Map(held.map((r) => [r.id, r]));
  for (const r of next) {
    const old = was.get(r.id);
    if (!old || content(old) !== content(r)) enqueueRow(c, enqueue, r, old ? old.version : null);
  }
};

// Signing in makes the journal kept in this browser the account's (5): every day,
// tombstones too, goes up, and one the server has never seen goes on the version this
// browser numbered, so the server continues its history. A row pinned to a version the
// server gave keeps that base, so an edit made while signed out is still compared with
// what the server holds. The pull starts over for the new user.
const adopt = (c, enqueue, userId) => {
  enqueue.assign({ userId, cursor: 0 });
  enqueue(() => c.store.metaPut("userId", userId).catch(() => {}));
  enqueue(() => c.store.metaPut("cursor", 0).catch(() => {}));
  for (const r of c.days) {
    const row = c.outbox.get(rowKey(r));
    if (row?.baseVersion != null) continue;
    if (!row) {
      enqueueRow(c, enqueue, r, r.version);
      continue;
    }
    const adopted = { ...row, baseVersion: r.version };
    c.outbox.set(row.key, adopted);
    enqueue(() => c.store.outboxPut(adopted).catch(() => {}));
  }
  enqueue.raise({ type: "_sync", pull: true });
};

// Applies a candidate list of days. Only a day that changed is stored, and a changed day
// is queued in the outbox signed in or not, so its row keeps the last version the server
// gave as its base; only signed in is a drain asked for. Signed in, the versions are the
// server's: a change keeps the version it was made on until the server acknowledges it.
const update = (context, enqueue, next) => {
  if (same(next, context.days)) return;
  let days = next;
  if (context.userId) {
    const was = new Map(context.days.map((r) => [r.id, r]));
    days = days.map((r) => (was.has(r.id) ? { ...r, version: was.get(r.id).version } : r));
  }
  enqueueChanges(context, enqueue, context.days, days);
  if (context.userId) enqueue.raise({ type: "_drain" });
  persist(context.store, context.days, days, enqueue);
  arm(enqueue, days, context.now());
  enqueue.assign({ days });
  announce(enqueue, { ...context, days });
};

// Applies a sync's summary: the acknowledged days, the conflicts, what was pulled, the
// cursor, and a session the server no longer knows.
const applySync = (context, output, enqueue) => {
  const { acks = [], conflicts = [], pulled = {}, newCursor, authFailed } = output;
  const days = [...context.days];
  const held = (id) => days.find((r) => r.id === id);
  const keep = (r) => {
    const i = days.findIndex((x) => x.id === r.id);
    if (i < 0) days.push(r);
    else days[i] = r;
  };
  const dropRow = (key) => {
    context.outbox.delete(key);
    enqueue(() => context.store.outboxDelete(key).catch(() => {}));
  };

  for (const { row, record } of acks) {
    const r = dayRecord(record);
    if (!r) continue;
    const current = context.outbox.get(row.key);
    // Drained when the server holds what is pending now; a change made during the sync
    // leaves a newer row, which stays and moves its base to the acknowledged version.
    // A day the server holds as a tombstone is gone whatever was pending (5).
    const drained =
      current && (r.deleted || (same(current.record, row.record) && Boolean(current.deleted) === Boolean(row.deleted)));
    if (drained) dropRow(row.key);
    else if (current) {
      const advanced = { ...current, baseVersion: r.version };
      context.outbox.set(row.key, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    const was = held(r.id);
    keep(drained || !was ? r : { ...was, version: r.version });
  }

  // A day's text was written on a version another device had moved past. The server's
  // copy is kept and both copies are announced, so a view can show the user what they
  // wrote rather than lose it.
  for (const { row, record } of conflicts) {
    const theirs = dayRecord(record);
    if (!theirs) continue;
    const mine = context.outbox.get(row.key) ?? row;
    dropRow(row.key);
    keep(theirs);
    enqueue.emit({
      type: "journal.conflicted",
      id: theirs.id,
      mine: { text: mine.record.text, baseVersion: mine.baseVersion },
      theirs: { text: theirs.text, version: theirs.version, editedAt: theirs.editedAt },
    });
  }

  for (const record of pulled.days ?? []) {
    const r = dayRecord(record);
    if (!r) continue;
    const was = held(r.id);
    if (was && r.version <= was.version) continue;
    // A delete always wins (5): a live copy never brings back a local tombstone.
    if (was?.deleted && !r.deleted) continue;
    // A change still in the outbox goes up next and comes back as a conflict carrying
    // this copy.
    if (context.outbox.has(rowKey(r))) continue;
    keep(r);
  }

  if (!same(days, context.days)) {
    persist(context.store, context.days, days, enqueue);
    enqueue.assign({ days });
    announce(enqueue, { ...context, days });
    arm(enqueue, days, context.now());
  }
  if (newCursor !== undefined) {
    enqueue.assign({ cursor: newCursor });
    enqueue(() => context.store.metaPut("cursor", newCursor).catch(() => {}));
  }
  if (authFailed) {
    enqueue.assign({ userId: null });
    enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
  }
};

const saved = enqueueActions(({ context, event, enqueue }) => {
  const days = daySaved(context.days, event, context.now());
  if (days) update(context, enqueue, days);
});

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

// What arrived while the store loaded, replayed in order once it is ready.
const replay = (context, enqueue) => {
  for (const message of context.queued) enqueue.raise(message);
  enqueue.assign({ queued: [] });
};

// The pause in typing the network waits for (5): a save restarts the window, so a run of
// saves drains once, as one coalesced write per day, after the typing stops. A load, a
// sign-in, a tab regaining focus or going to the background does not wait.
const SYNC_IDLE_MS = 2000;

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    // A pull is always worth the round trip; a bare drain only when the outbox holds something.
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0 || context.leaving,
    // The browser is changing account (12): empty the local copy once nothing is left
    // to upload.
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
  },
  actors: {
    load: fromPromise(async ({ input: { store, ask } }) => {
      const [days, outbox, cursor, userId, session] = await Promise.all([
        store.all("days"),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
        // Who is signed in now. Without an answer (no session on the page, or a Node
        // test without one) the user this browser last synced for is assumed.
        ask ? ask("session", "read", {}).catch(() => null) : null,
      ]);
      const known = session && typeof session === "object" && "userId" in session;
      return {
        days,
        outbox,
        cursor: Number.isInteger(cursor) ? cursor : 0,
        stored: userId ?? null,
        userId: known ? session.userId : userId ?? null,
      };
    }),
    // Empties the local copy in one transaction, outbox and cache together (12).
    empty: fromPromise(({ input }) => input.store.empty()),
    // One sync: drain the outbox, then pull what changed since the cursor. It returns a
    // summary the machine applies and never emits (4.3). A network error stops it with
    // what it had; 401 reports the session is gone. A drained row is deleted from the
    // store here, so it is durably gone; one changed during the sync is put back.
    sync: fromPromise(async ({ input: { api, store, rows, cursor, pull } }) => {
      const acks = [];
      const conflicts = [];
      for (const row of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
        let result;
        try {
          result = await api.put(row);
        } catch {
          return { acks, conflicts, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, conflicts, authFailed: true };
        await store.outboxDelete(row.key).catch(() => {});
        (result.conflict ? conflicts : acks).push({ row, record: result.record });
      }
      // A save-triggered drain does not pull: nothing this device needs changed on the
      // server, and a pull per pause in typing would be a poll (5).
      if (!pull) return { acks, conflicts };
      let pulled;
      try {
        pulled = await api.pull(cursor);
      } catch {
        return { acks, conflicts, networkError: true };
      }
      if (pulled.error === "unauthorized") return { acks, conflicts, authFailed: true };
      const { cursor: newCursor, ...records } = pulled;
      return { acks, conflicts, pulled: records, newCursor };
    }),
  },
}).createMachine({
  id: "journal",
  meta: {
    description:
      "Owns the journal: one entry per day. It works offline and syncs to the account when " +
      "signed in, the same way notes do; signed out it is kept in this browser, and signing in " +
      "moves it to the account. A day's date is the local date when its first character was " +
      "typed and never changes. Only one day can be edited: the one whose date is today, or " +
      "that was edited less than an hour ago, so writing past midnight keeps going in the same " +
      "entry; a save to any other day is refused. When no day can be edited, the journal opens " +
      "an empty page for today.",
    kind: "fact",
    shape: "replicated",
    owns: "the journal's days",
    emits: ["journal.changed", "journal.conflicted"],
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    days: [],
    open: null,
    userId: null,
    cursor: 0,
    outbox: new Map(),
    queued: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    // What a trigger that arrives mid-sync is owed: resync means sync again, pull
    // whether that next sync must also pull.
    resync: false,
    pull: false,
    store: input.store,
    now: input.now,
    ask: input.ask,
    api: input.api,
  }),
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            const { output } = event;
            const days = output.days.map(dayRecord).filter(Boolean);
            // Only days go to the server; a row of another kind an older journal queued
            // would be refused on every sync and hold back the days behind it.
            const rows = output.outbox.filter((row) => row.table === TABLE);
            for (const row of output.outbox) {
              if (row.table !== TABLE) enqueue(() => context.store.outboxDelete(row.key).catch(() => {}));
            }
            const outbox = new Map(rows.map((row) => [row.key, row]));
            const c = { ...context, days, outbox };
            const { userId } = output;
            const now = context.now();
            enqueue.assign({ days, outbox, userId, cursor: output.cursor, open: openDay(days, now)?.id ?? null });
            arm(enqueue, days, now);
            // Signed in since this browser last synced, perhaps in another tab, is a
            // sign-in like any other.
            if (userId && userId !== output.stored) adopt(c, enqueue, userId);
            else if (userId) enqueue.raise({ type: "_sync", pull: true });
            replay(context, enqueue);
          }),
        },
        // A store that cannot open still takes writing for this page, rather than
        // refusing every keystroke.
        onError: {
          target: "ready",
          actions: enqueueActions(({ context, enqueue }) => replay(context, enqueue)),
        },
      },
      on: {
        "day.saved": { actions: queue },
        "session.changed": { actions: queue },
        "read?": { actions: queue },
      },
    },
    ready: {
      on: {
        "day.saved": { actions: saved },
        // The outbox drains only while someone is signed in (5); signing out keeps it,
        // to go up at the next sign-in.
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            // The browser is changing account (12): upload what is left, then empty the local
            // copy. Any other news ends it, and syncing goes on as before.
            if (event.leaving) {
              enqueue.assign({ leaving: true });
              enqueue.raise({ type: "_leave" });
              return;
            }
            if (context.leaving) enqueue.assign({ leaving: false });
            if (event.userId === context.userId) return;
            if (event.userId) return adopt(context, enqueue, event.userId);
            enqueue.assign({ userId: null });
            enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
          }),
        },
        _close: {
          actions: enqueueActions(({ context, enqueue }) => {
            const now = context.now();
            if ((openDay(context.days, now)?.id ?? null) !== context.open) announce(enqueue, context);
            arm(enqueue, context.days, now);
          }),
        },
        "read?": { actions: ({ context, event }) => event.reply(body(context)) },
      },
      initial: "idle",
      states: {
        // Leaving (12): what is left is uploaded at once, then the local copy is emptied.
        emptying: {
          invoke: {
            src: "empty",
            input: ({ context }) => ({ store: context.store }),
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
        // A _drain re-enters this state, which restarts the window, so the drain waits
        // until typing has paused for all of it. Signed out mid-window, it returns to
        // idle rather than sync with no user.
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
            // pull comes from the triggering event: the entry assign above runs before
            // the input is read and would otherwise wipe it from context.
            input: ({ context, event }) => ({
              api: context.api,
              store: context.store,
              rows: [...context.outbox.values()],
              cursor: context.cursor,
              pull: Boolean(event.pull) && !context.leaving,
            }),
            onDone: {
              target: "idle",
              actions: [
                enqueueActions(({ context, event, enqueue }) => applySync(context, event.output, enqueue)),
                // A trigger that arrived mid-sync is owed a follow-up, unless the session
                // went away or the network failed, when the next trigger retries. A focus
                // mid-sync syncs at once with its pull; a save mid-sync waits out the window.
                enqueueActions(({ context, event, enqueue }) => {
                  const { authFailed, networkError } = event.output;
                  if (authFailed || networkError) return;
                  if (context.resync) enqueue.raise({ type: "_sync", pull: context.pull });
                  else if (context.outbox.size > 0) enqueue.raise({ type: "_drain" });
                }),
              ],
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
  },
});
