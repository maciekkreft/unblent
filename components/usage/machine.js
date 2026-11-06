import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { ulid } from "ulid";

// A replicated fact component (3.1, 5) whose records relax the sync rules: each record
// is one device's running total for a day and a feature, so the last write wins and a
// write is never refused (5). It learns what the person did from `trace.recorded`, the
// record of every routing decision the bus made (3.3), and counts only a view's events
// from this tab: the name of the action and the view that announced it, never its
// payload. Everything with a side effect (the store, the network, the asks, the clock)
// arrives through input, so this stays a pure definition importable in Node.

// A pause longer than this between two actions is not counted.
const GAP_MS = 2 * 60 * 1000;
// The pause in activity the network waits for, so a run of actions drains once (5).
const SYNC_IDLE_MS = 60 * 1000;
// The days a summary covers, the most recent last (queries/summary.json).
const DAYS = 182;

const pad = (n) => String(n).padStart(2, "0");
// The browser's local date, which is the day the person lived the time in.
export const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const nextMidnight = (ms) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};
const firstDay = (now) => {
  const d = new Date(now);
  return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (DAYS - 1)).getTime());
};

// The component an address names: an instanced view's `#<id>` is the page's, not the
// component's (4.1).
const bare = (address) => String(address ?? "").split("#")[0];

// Only a view's event counts: a view announces what the person did (4.3, fifth rule);
// a refused emit never happened.
const isAction = (r) => r.kind === "event" && r.fromKind === "view" && r.outcome !== "refused";

const toRecord = (r) => ({ id: r.id, device: r.device, day: r.day, feature: r.feature, ms: r.ms });

// Adds `ms` of `feature` on the local day of `from`, split at each local midnight so a
// stretch across midnight counts on both days. Returns the records it changed.
function credit(context, from, to, feature) {
  const changed = [];
  for (let at = from; at < to; ) {
    const end = Math.min(to, nextMidnight(at));
    const day = dayOf(at);
    const id = `${context.device}:${day}:${feature}`;
    const held = context.records.get(id);
    const r = { id, device: context.device, day, feature, ms: (held?.ms ?? 0) + Math.round(end - at) };
    context.records.set(id, r);
    changed.push(r);
    at = end;
  }
  return changed;
}

// The answer from this device's own totals, when the account cannot be asked (offline).
function localSummary(records, now, features) {
  const from = firstDay(now);
  const sums = new Map();
  for (const r of records) {
    if (r.day < from || !(r.ms > 0)) continue;
    const key = `${r.day}\n${r.feature}`;
    sums.set(key, (sums.get(key) ?? 0) + r.ms);
  }
  const days = [...sums].map(([key, ms]) => {
    const [day, feature] = key.split("\n");
    return { day, feature, ms };
  });
  days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : features.indexOf(a.feature) - features.indexOf(b.feature)));
  return { days, accounts: 1 };
}

// Answers every summary waiting: the account's totals from the server, or this
// device's own when the server cannot be reached; all accounts need the server.
function answerAll(context, enqueue) {
  const waiting = context.waiting;
  if (!waiting.length) return;
  enqueue.assign({ waiting: [] });
  const { api, userId, now, features } = context;
  const records = [...context.records.values()];
  for (const { who, reply } of waiting) {
    if (!userId) {
      reply({ error: "signed-out" });
      continue;
    }
    const fallback = () => reply(who === "you" ? localSummary(records, now(), features) : { error: "unavailable" });
    enqueue(() => {
      if (!api) return fallback();
      api.summary(who).then(
        (answer) => {
          if (Array.isArray(answer?.days) && Number.isInteger(answer?.accounts)) reply({ days: answer.days, accounts: answer.accounts });
          else if (answer?.error === "signed-out" || answer?.error === "not-admin") reply({ error: answer.error });
          else fallback();
        },
        fallback,
      );
    });
  }
}

// One trace record: first, whether it tells this fact which tab it is in; then, while
// counting, the time since the previous action is credited to that action's feature.
function onRecord(context, r, enqueue, self) {
  if (!context.tab) {
    // The trace stamps every record with its tab, and repeats the records of the other
    // tabs of this browser. The one way to tell this tab's apart is a record of this
    // fact's own ask: the bus taps it, and the trace announces it, before the ask
    // returns, so it lands while the probe is open, ahead of any record that crosses
    // from another tab, which arrives in a later task. Without a trace on the page
    // nothing comes; a probe that closed empty is tried again at the next record.
    if (context.probing) {
      if (bare(r.from) === "usage" && r.kind === "query" && r.name === "read" && r.to?.[0] === "settings")
        enqueue.assign({ tab: r.tab, probing: false });
    } else {
      enqueue.assign({ probing: true });
      enqueue(() => probe(context, self));
    }
    return;
  }
  if (r.tab !== context.tab || !isAction(r) || !Number.isFinite(r.at)) return;
  if (!(context.on && context.userId && context.device && !context.leaving)) return;
  const feature = featureOf(context.counts, r.name, bare(r.from));
  const last = context.last;
  enqueue.assign({ last: { at: r.at, feature } });
  if (!last || r.at <= last.at || r.at - last.at > GAP_MS) return;
  const changed = credit(context, last.at, r.at, last.feature);
  for (const rec of changed) {
    context.outbox.set(rec.id, rec);
    enqueue(() => {
      context.store.put(rec).catch(() => {});
      context.store.outboxPut(rec).catch(() => {});
    });
  }
  enqueue.raise({ type: "_drain" });
}

function featureOf(counts, name, from) {
  const entry = counts[name];
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && typeof entry[from] === "string") return entry[from];
  return "other";
}

// Reads the setting while the probe that learns this tab (onRecord) is open, and closes
// it once the current task's microtasks run: the record of this ask arrives before then.
function probe(context, self) {
  const asked = context.ask ? context.ask("settings", "read", {}) : Promise.resolve(null);
  Promise.resolve().then(() => self.send({ type: "_probed" }));
  Promise.resolve(asked).then(
    (value) => self.send({ type: "_settings", value }),
    () => {},
  );
}

// The browser changed account while this fact was not on the page (12). Totals belong
// to the account they were counted for, so a copy kept for another account is emptied,
// and the next device id starts fresh: a running total that restarted from nothing
// would otherwise overwrite the account's larger one (last write wins). A copy marked
// to join the account it now follows (12, keep) is sent there whole when that account
// holds no usage yet, and emptied when it holds some; a mark of a change that was
// called off names the account still signed in, and is only cleared.
async function claim(store, ask, api) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  const [kept, from] = await Promise.all([store.metaGet("userId"), store.metaGet("adopt")]);
  if (!userId) return kept ?? null;
  if (from && from !== userId) {
    let held;
    try {
      held = api ? await api.summary("you") : null;
    } catch {
      held = null;
    }
    if (Array.isArray(held?.days) && held.days.length === 0) {
      const device = await store.metaGet("device");
      for (const r of await store.all()) if (r?.device === device) await store.outboxPut(toRecord(r));
    } else await store.empty();
  } else if (!from && kept && kept !== userId) await store.empty();
  if (from) await store.metaPut("adopt", null);
  if (kept !== userId) await store.metaPut("userId", userId);
  return userId;
}

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    // The server is contacted only when there is something new to send.
    hasRows: ({ context }) => context.outbox.size > 0,
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
    drainFirst: ({ context, event }) =>
      !event.drained && context.waiting.length > 0 && Boolean(context.userId) && context.api != null && context.outbox.size > 0,
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store, ask, api, mint } = input;
      const owner = await claim(store, ask, api);
      let device = await store.metaGet("device");
      if (typeof device !== "string") {
        device = mint();
        await store.metaPut("device", device);
      }
      const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
      const mine = (r) => r?.device === device && typeof r.id === "string" && Number.isInteger(r.ms);
      return { device, owner, records: records.filter(mine).map(toRecord), outbox: outbox.filter(mine).map(toRecord) };
    }),
    // Missing (a Node test) is treated as signed out, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // Leaving (12): the local copy goes, outbox and totals together; with keep it stays,
    // marked with the account it came from, to be decided after the reload (claim).
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // One batch of every total in the outbox. It never emits (4.3). A network error
    // keeps the rows for the next trigger; 401 reports the session is gone.
    sync: fromPromise(async ({ input }) => {
      const { api, rows } = input;
      if (!rows.length) return { sent: [] };
      let result;
      try {
        result = await api.put(rows);
      } catch {
        return { sent: [], networkError: true };
      }
      if (result?.error === "unauthorized") return { sent: [], authFailed: true };
      return { sent: rows };
    }),
  },
}).createMachine({
  id: "usage",
  meta: {
    description:
      "Owns how long this account spends in each feature, by day: Journal, Reading, " +
      "Highlights, Notes, Chats, Evaluators, Choice Points, Values and Other. It counts only " +
      "on a device where the person turned on Share usage statistics in Settings, and only " +
      "while someone is signed in. It learns what the person did from the trace of this tab: " +
      "each action a view announced, by its name and the view that announced it, never what " +
      "was written or read. The time between two actions is counted for the feature of the " +
      "first, and an action that opens something on the stage, such as a book from a chat, " +
      "counts for what it opens; a pause of more than two minutes is not counted. Totals are kept per device, " +
      "day and feature in the browser and sent to the account when there is something new, " +
      "also later when the device was offline; the last write wins (5). Summary answers the " +
      "last 182 days for this account, or, for the admin only, added up across all accounts, " +
      "as totals with no breakdown per account (12). Offline it answers with this device's " +
      "own totals.",
    kind: "fact",
    shape: "replicated",
    owns: "how long the account spends in each feature, per device and day",
    emits: [],
    asks: ["session: read", "settings: read"],
    steps: {},
    // Which feature the time after each action a view announces belongs to (7.3); the
    // counts check fails on an action left out. An action that opens something on the
    // stage counts for what it opens, since the time after it is spent there.
    features: ["journal", "reading", "highlights", "notes", "chats", "evaluators", "choice", "values", "other"],
    counts: {
      "day.saved": "journal",
      "day.shown": "journal",
      "day.selected": "journal",
      "book.picked": "reading",
      "book.selected": "reading",
      "book.progressed": "reading",
      "book.renamed": "reading",
      "book.discarded": "reading",
      "book.restored": "reading",
      "book.switched": "reading",
      "book.closed": { "book-reader": "reading", "journal-entry": "journal" },
      "chapter.selected": "reading",
      "tabs.shown": "reading",
      "passage.selected": "highlights",
      "passage.added": "highlights",
      "highlights.edited": "highlights",
      "text.copied": "highlights",
      "link.copied": "highlights",
      "note.saved": { "book-reader": "highlights", "journal-entry": "highlights", "note-editor": "notes", "notice-stack": "notes" },
      "note.discarded": { "book-reader": "highlights", "journal-entry": "highlights", "note-list": "notes" },
      "note.opened": "notes",
      "note.selected": "notes",
      "note.moved": "notes",
      "note.staged": "notes",
      "note.closed": "notes",
      "turn.submitted": "chats",
      "turn.steered": "chats",
      "conversation.selected": "chats",
      "conversation.renamed": "chats",
      "conversation.moved": "chats",
      "conversation.discarded": "chats",
      "conversation.relinked": "chats",
      "conversation.staged": "chats",
      "conversation.closed": "chats",
      "expert.edited": "chats",
      "expert.picked": "chats",
      "lookup.followed": "chats",
      "evaluator.saved": "evaluators",
      "evaluator.opened": "evaluators",
      "evaluator.selected": "evaluators",
      "evaluator.switched": "evaluators",
      "evaluator.moved": "evaluators",
      "evaluator.discarded": "evaluators",
      "marks.edited": "evaluators",
      "starter.ticked": "evaluators",
      "choice-point.saved": "choice",
      "values.saved": "values",
      "values.placed": "values",
      "settings.edited": "other",
      "llm.edited": "other",
      "tools.edited": "other",
      "checks.edited": "other",
      "value-checks.edited": "other",
      "updates.edited": "other",
      "voice.edited": "other",
      "generator.edited": "other",
      "generation.requested": "other",
      "flag.switched": "other",
      "tab.picked": "other",
      "tab.moved": "other",
      "tab.closed": "other",
      "dock.arranged": "other",
      "layout.switched": "other",
      "viewport.selected": "other",
      "profile.switched": "other",
      "step.requested": "other",
      "redline.saved": "other",
      "trial.restarted": "other",
      "signin.requested": "other",
      "signout.requested": "other",
      "connect.requested": "other",
      "connect.confirmed": "other",
      "disconnect.requested": "other",
      "viewas.requested": "other",
      "guest.blocked": "other",
      "guestkeys.edited": "other",
      "limits.edited": "other",
      "removal.settled": "other",
      "sync.allowed": "other",
      "use.reset": "other",
    },
  },
  context: ({ input }) => ({
    store: input.store,
    api: input.api,
    ask: input.ask,
    mint: input.mint ?? ulid,
    now: input.now ?? Date.now,
    counts: machine.config.meta.counts,
    features: machine.config.meta.features,
    // This tab's id, as the trace stamps it; null until a probe found it.
    tab: null,
    probing: false,
    // Share usage statistics (settings), off until settings says otherwise.
    on: false,
    userId: null,
    // The account the totals here were counted for (meta userId).
    owner: null,
    device: null,
    // Every total of this device, by id `device:day:feature`, and those not yet sent.
    records: new Map(),
    outbox: new Map(),
    // The last counted action: { at, feature }; null after a pause in counting.
    last: null,
    // Summaries asked and not yet answered: { who, reply }.
    waiting: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    keep: false,
    resync: false,
  }),
  entry: [assign({ probing: true }), ({ context, self }) => probe(context, self)],
  on: {
    "trace.recorded": { actions: enqueueActions(({ context, event, enqueue, self }) => onRecord(context, event, enqueue, self)) },
    "settings.changed": {
      actions: assign({
        on: ({ event }) => event.usageCounting === true,
        last: ({ context, event }) => (event.usageCounting === true ? context.last : null),
      }),
    },
    _settings: {
      guard: ({ event }) => event.value != null && typeof event.value === "object" && !("error" in event.value),
      actions: assign({
        on: ({ event }) => event.value.usageCounting === true,
        last: ({ context, event }) => (event.value.usageCounting === true ? context.last : null),
      }),
    },
    _probed: { actions: assign({ probing: false }) },
    // While loading, only whether the browser is leaving is kept (12); who is signed in
    // is read from session once the store is loaded.
    "session.changed": {
      actions: assign({
        leaving: ({ event }) => event.leaving === true,
        keep: ({ event }) => event.leaving === true && event.keep === true,
        last: null,
      }),
    },
    "summary?": { actions: assign({ waiting: ({ context, event }) => [...context.waiting, { who: event.payload.who, reply: event.reply }] }) },
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask, api: context.api, mint: context.mint }),
        onDone: {
          target: "checkingSession",
          actions: assign({
            device: ({ event }) => event.output.device,
            owner: ({ event }) => event.output.owner,
            records: ({ event }) => new Map(event.output.records.map((r) => [r.id, r])),
            outbox: ({ event }) => new Map(event.output.outbox.map((r) => [r.id, r])),
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const { reply } of context.waiting) reply({ error: "unavailable" });
            enqueue.assign({ waiting: [] });
          }),
        },
      },
    },
    // The store is loaded; confirm who is signed in before counting or sending.
    checkingSession: {
      invoke: {
        src: "session",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          target: "ready.idle",
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.assign({ userId: typeof event.output?.userId === "string" ? event.output.userId : null });
            enqueue.raise({ type: "_sync" });
            enqueue.raise({ type: "_answer" });
          }),
        },
        onError: { target: "ready.idle", actions: enqueueActions(({ enqueue }) => enqueue.raise({ type: "_answer" })) },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "summary?": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            enqueue.assign({ waiting: [...context.waiting, { who: event.payload.who, reply: event.reply }] });
            enqueue.raise({ type: "_answer" });
          }),
        },
        _answer: { actions: enqueueActions(({ context, enqueue }) => answerAll(context, enqueue)) },
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            enqueue.assign({ last: null });
            // The browser is changing account (12): counting stops, what is left is sent,
            // then the local copy is emptied. Any other news ends it.
            if (event.leaving) {
              enqueue.assign({ leaving: true, keep: event.keep === true });
              enqueue.raise({ type: "_leave" });
              return;
            }
            if (context.leaving) {
              enqueue.assign({ leaving: false, keep: false });
              // Called off: the copy stays this account's, under the same device, so the
              // marks the emptying took are written back.
              const { store, device, owner } = context;
              enqueue(() => {
                store.metaPut("adopt", null).catch(() => {});
                store.metaPut("device", device).catch(() => {});
                store.metaPut("userId", owner).catch(() => {});
              });
            }
            const userId = typeof event.userId === "string" ? event.userId : null;
            if (userId === context.userId) return;
            enqueue.assign({ userId });
            if (!userId) return;
            if (context.owner && context.owner !== userId) {
              // Another account signed in: what was counted belongs to the one before
              // (claim), and the next totals start under a new device id.
              const device = context.mint();
              const { store } = context;
              enqueue.assign({ owner: userId, device, records: new Map(), outbox: new Map() });
              enqueue(() =>
                store
                  .empty()
                  .then(() => Promise.all([store.metaPut("device", device), store.metaPut("userId", userId)]))
                  .catch(() => {}),
              );
              return;
            }
            if (!context.owner) {
              enqueue.assign({ owner: userId });
              enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
            }
            enqueue.raise({ type: "_sync" });
          }),
        },
      },
      states: {
        idle: {
          always: { guard: "leftover", target: "emptying" },
          on: {
            _drain: { guard: "syncable", target: "debouncing" },
            _sync: { guard: and(["syncable", "hasRows"]), target: "syncing" },
            _leave: { guard: and(["syncable", "hasRows"]), target: "syncing" },
            _answer: [{ guard: "drainFirst", target: "syncing" }, { actions: enqueueActions(({ context, enqueue }) => answerAll(context, enqueue)) }],
          },
        },
        // A _drain reenters, which restarts the pause; a focus, a hidden tab, a
        // sign-in or a summary (_sync, _answer) does not wait.
        debouncing: {
          always: { guard: "leftover", target: "emptying" },
          on: {
            _drain: { target: "debouncing", reenter: true },
            _sync: { guard: and(["syncable", "hasRows"]), target: "syncing" },
            _leave: [{ guard: and(["syncable", "hasRows"]), target: "syncing" }, { target: "idle" }],
            _answer: [{ guard: "drainFirst", target: "syncing" }, { actions: enqueueActions(({ context, enqueue }) => answerAll(context, enqueue)) }],
          },
          after: {
            [SYNC_IDLE_MS]: [{ guard: and(["syncable", "hasRows"]), target: "syncing" }, { target: "idle" }],
          },
        },
        syncing: {
          entry: assign({ resync: false }),
          invoke: {
            src: "sync",
            input: ({ context }) => ({ api: context.api, rows: [...context.outbox.values()] }),
            onDone: {
              target: "idle",
              actions: enqueueActions(({ context, event, enqueue }) => {
                const { sent, authFailed, networkError } = event.output;
                for (const row of sent) {
                  // A total that grew while it was on its way stays, to be sent again.
                  if (context.outbox.get(row.id)?.ms !== row.ms) continue;
                  context.outbox.delete(row.id);
                  enqueue(() => context.store.outboxDelete(row.id).catch(() => {}));
                }
                if (authFailed) enqueue.assign({ userId: null, last: null });
                enqueue.raise({ type: "_answer", drained: true });
                if (authFailed || networkError) return;
                if (context.resync || (context.leaving && context.outbox.size > 0)) enqueue.raise({ type: "_sync" });
                else if (context.outbox.size > 0) enqueue.raise({ type: "_drain" });
              }),
            },
            onError: { target: "idle", actions: enqueueActions(({ enqueue }) => enqueue.raise({ type: "_answer", drained: true })) },
          },
          on: {
            _sync: { actions: assign({ resync: true }) },
            _leave: { actions: assign({ resync: true }) },
            _answer: { actions: [] },
          },
        },
        // Leaving (12): nothing is left to send, so the local copy goes.
        emptying: {
          invoke: {
            src: "empty",
            input: ({ context }) => ({ store: context.store, keep: context.keep, from: context.owner }),
            onDone: { target: "left" },
            onError: { target: "left" },
          },
          on: { _answer: { actions: [] } },
        },
        // Emptied; when the change of account is called off, counting and sending go on.
        left: {
          always: { guard: ({ context }) => !context.leaving, target: "idle" },
          entry: enqueueActions(({ enqueue }) => enqueue.raise({ type: "_answer" })),
        },
      },
    },
    // The store could not be opened: nothing is counted, and a summary says so.
    failed: {
      on: {
        "summary?": { actions: ({ event }) => event.reply({ error: "unavailable" }) },
      },
    },
  },
});
