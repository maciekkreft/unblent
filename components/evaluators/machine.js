import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the evaluators (3.1), replicated (5) the way `notes` is:
// local-first, cached in the browser, numbering versions itself while signed out and
// syncing to the per-user server when signed in. Unlike a note an evaluator never
// conflicts: the last write wins, as the journal's detectors did, and a delete is a
// tombstone that always wins (5). The view where the user acted emits evaluator.saved,
// evaluator.switched and removal.started; notice-stack emits removal.undone or
// removal.settled when the undo window ends (4.3, fifth rule). Everything with a side
// effect (the store, the network, the ask) arrives through input, so this stays a pure
// definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");

// --- Records --------------------------------------------------------------------------

// Each part in one fixed shape and key order, so two copies of the same content compare
// equal as text. `removing` marks an item in this tab's undo window; it is kept in the
// cache (so a leftover mark settles at the next load) but never sent to the server.
const option = (o) =>
  o && isId(o.id) ? { id: o.id, name: str(o.name), description: str(o.description), removing: o.removing === true } : null;

const question = (q) =>
  q && isId(q.id)
    ? {
        id: q.id,
        on: q.on !== false,
        kind: q.kind === "pick" ? "pick" : "yesno",
        text: str(q.text),
        yes: str(q.yes),
        no: str(q.no),
        options: (Array.isArray(q.options) ? q.options : []).map(option).filter(Boolean),
        removing: q.removing === true,
      }
    : null;

const questionsOf = (list) => (Array.isArray(list) ? list : []).map(question).filter(Boolean);

const record = (r) => ({
  id: r.id,
  book: r.book,
  name: str(r.name),
  on: r.on !== false,
  journal: r.journal === true,
  questions: questionsOf(r.questions),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  removing: r.removing === true,
  ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
  ...(r.deleted === true ? { deleted: true } : {}),
});

// The questions as another device is told them: every mark stripped.
const bare = (questions) =>
  questions.map(({ removing, options, ...q }) => ({ ...q, options: options.map(({ removing: _, ...o }) => o) }));

// What a write carries, and what decides whether a change is a new version. The marks
// belong to this tab's undo window, so setting or clearing one is not a change.
const content = (r) => ({ book: r.book, name: r.name, on: r.on, journal: r.journal, questions: bare(r.questions) });
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

// A tombstone is kept for the sync (5) but never listed or announced as a change.
const visible = (r) => r && !r.deleted;

const announce = (context, r) => {
  const { deleted, ...rest } = r;
  return { ...rest, pending: context.outbox.has(r.id) };
};

function replyList(context, book, reply) {
  const evaluators = [...context.evaluators.values()]
    .filter((r) => visible(r) && (book === undefined || r.book === book))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => announce(context, r));
  reply({ evaluators });
}

// The incoming list with every marked item of the old list that it left out put back
// after the nearest item before it that is still there, so a save never drops what is
// still in its undo window. An incoming item marked in the old list stays marked.
const keepMarked = (old, incoming) => {
  const marked = new Set(old.filter((x) => x.removing).map((x) => x.id));
  const out = incoming.map((x) => (marked.has(x.id) ? { ...x, removing: true } : x));
  old.forEach((x, i) => {
    if (!x.removing || out.some((y) => y.id === x.id)) return;
    const before = old.slice(0, i).reverse().find((p) => out.some((y) => y.id === p.id));
    out.splice(before ? out.findIndex((y) => y.id === before.id) + 1 : 0, 0, x);
  });
  return out;
};

// --- Changes --------------------------------------------------------------------------

// The one place a changed record is kept, stored and announced. A change of content is
// a new version: signed out it is minted here; signed in the record keeps the version
// it holds, is queued in the outbox (coalesced by id, keeping the first unsynced base)
// and a drain is asked for. A change of marks only is stored and announced, not synced.
function commit(context, enqueue, next) {
  const current = context.evaluators.get(next.id);
  const changed = !current || !same(current, next) || Boolean(next.deleted) !== Boolean(current.deleted);
  // A change of content is stamped here, signed in or out, so the editor can open a
  // book's most recently edited evaluator offline too; the server keeps the stamp.
  let r = changed ? { ...next, updatedAt: context.now() } : next;
  if (changed && context.userId == null) r = { ...r, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...r, version: current.version };
  context.evaluators.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (changed && context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null);
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  if (r.deleted) {
    if (visible(current)) enqueue.emit({ type: "evaluator.deleted", id: r.id, book: r.book });
  } else {
    enqueue.emit({ type: "evaluator.changed", evaluator: announce(context, r) });
  }
  if (changed && context.userId != null) enqueue.raise({ type: "_drain" });
}

const outboxRow = (r, baseVersion) => ({
  id: r.id,
  ...content(r),
  baseVersion,
  ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
  ...(r.deleted ? { deleted: true } : {}),
});

const live = (context, id) => {
  const r = context.evaluators.get(id);
  return visible(r) ? r : null;
};

// A new id adds an evaluator to its book, switched on; a save to one already kept
// changes its name, its questions and, when the save says, whether it shows in the
// journal, keeps its book and its tick, and keeps whatever of it is still in its undo
// window. A save that leaves `journal` out keeps it, so a tab running an older editor
// cannot clear it. A deleted id stays deleted (5).
function applySave(context, event, enqueue) {
  if (!isId(event.id) || context.evaluators.get(event.id)?.deleted) return;
  const was = live(context, event.id);
  if (!was) {
    if (!isId(event.book)) return;
    return commit(context, enqueue, record({ id: event.id, book: event.book, name: event.name, on: true, journal: event.journal, questions: event.questions }));
  }
  const questions = keepMarked(
    was.questions,
    questionsOf(event.questions).map((q) => {
      const old = was.questions.find((x) => x.id === q.id);
      return { ...q, options: keepMarked(old ? old.options : [], q.options) };
    }),
  );
  const journal = typeof event.journal === "boolean" ? event.journal : was.journal;
  const next = { ...was, name: str(event.name), journal, questions };
  if (same(was, next)) return;
  commit(context, enqueue, next);
}

function applySwitch(context, { id, on }, enqueue) {
  const was = live(context, id);
  if (!was || was.on === on) return;
  commit(context, enqueue, { ...was, on });
}

// Sets `removing` on the one item of `kind` named by `id`, wherever it sits. An id that
// is not one of the evaluators' own matches nothing, so other facts' removals pass by.
function applyMark(context, { kind, id }, removing, enqueue) {
  const set = (x) => (x.id === id ? { ...x, removing } : x);
  for (const r of [...context.evaluators.values()].filter(visible)) {
    let next = null;
    if (kind === "evaluator" && r.id === id) next = set(r);
    else if (kind === "question" && r.questions.some((q) => q.id === id)) next = { ...r, questions: r.questions.map(set) };
    else if (kind === "option" && r.questions.some((q) => q.options.some((o) => o.id === id)))
      next = { ...r, questions: r.questions.map((q) => ({ ...q, options: q.options.map(set) })) };
    if (next && JSON.stringify(next) !== JSON.stringify(r)) commit(context, enqueue, next);
  }
}

// A settled removal makes a tombstone of an evaluator, and drops a question or an option
// from its evaluator. Only an item still marked settles: one that was undone stays.
function applySettle(context, { kind, id }, enqueue) {
  const marked = (x) => x.id === id && x.removing;
  const keep = (x) => !marked(x);
  for (const r of [...context.evaluators.values()].filter(visible)) {
    if (kind === "evaluator" && marked(r)) commit(context, enqueue, { ...r, removing: false, deleted: true });
    else if (kind === "question" && r.questions.some(marked)) commit(context, enqueue, { ...r, questions: r.questions.filter(keep) });
    else if (kind === "option" && r.questions.some((q) => q.options.some(marked)))
      commit(context, enqueue, { ...r, questions: r.questions.map((q) => ({ ...q, options: q.options.filter(keep) })) });
  }
}

// At load no tab can undo anything any more, because the tab that showed the undo
// notice is gone, so every leftover mark settles.
function settleAll(context, enqueue) {
  const all = [...context.evaluators.values()].filter(visible);
  for (const r of all) {
    for (const q of r.questions) {
      for (const o of q.options) if (o.removing) applySettle(context, { kind: "option", id: o.id }, enqueue);
      if (q.removing) applySettle(context, { kind: "question", id: q.id }, enqueue);
    }
    if (r.removing) applySettle(context, { kind: "evaluator", id: r.id }, enqueue);
  }
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.payload.book, message.reply);
  else if (message.type === "evaluator.saved") applySave(context, message, enqueue);
  else if (message.type === "evaluator.switched") applySwitch(context, message, enqueue);
  else if (message.type === "removal.started") applyMark(context, message, true, enqueue);
  else if (message.type === "removal.undone") applyMark(context, message, false, enqueue);
  else if (message.type === "removal.settled") applySettle(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(
  ["list?", "evaluator.saved", "evaluator.switched", "removal.started", "removal.undone", "removal.settled"].map((t) => [t, { actions: queue }]),
);

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0,
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store } = input;
      const [evaluators, outbox, cursor, userId] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      return { evaluators, outbox, cursor: cursor ?? 0, userId: userId ?? null };
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
      return { acks, pulled: pulled.evaluators, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "evaluators",
  meta: {
    description:
      "Owns the evaluators kept with each book: an evaluator is a name and a list of questions, " +
      "each a yes / no question with what yes and no mean, or a pick-one question with its " +
      "options, and it is switched on or off. Each question is switched on or off too: one " +
      "switched off is kept, with its wording, but not asked, and a question without the " +
      "switch counts as on. An evaluator marked \"Show in journal\" is " +
      "listed in the Journal's Evaluators tab as well as its own book's. `evaluators: list` answers one book's evaluators, " +
      "or every book's when no book is given, oldest first, each with when its content last " +
      "changed (`updatedAt`, absent on one kept from before it was recorded). A new evaluator starts switched on. It works signed out, numbering versions " +
      "itself, and syncs to the account when signed in (section 5); signing in uploads every " +
      "evaluator with its history. The last write wins, so two devices never conflict, and a " +
      "deleted evaluator is kept as a tombstone, which always wins. A removed evaluator, question " +
      "or option is marked while its undo window runs and goes only when the window ends; a mark " +
      "left by a closed tab ends at the next load. An evaluator reads what it is given: the " +
      "book's Run box asks the switched-on evaluators about a typed text, and " +
      "choice-point-checks asks the one chosen for a choice point box about each of its " +
      "lines, whether it is switched on or not.",
    kind: "fact",
    shape: "replicated",
    emits: ["evaluator.changed", "evaluator.deleted"],
    owns: "the evaluators kept with each book",
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    evaluators: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    now: input.now ?? (() => new Date().toISOString()),
    userId: null,
    cursor: 0,
    queued: [],
    resync: false,
    pull: false,
  }),
  initial: "loading",
  on: {
    // Planned (9, step 1): the try-links contracts, which do nothing until they are built.
    "starter.ticked": { actions: () => {} },
  },
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store }),
        onDone: {
          target: "checkingSession",
          actions: assign({
            evaluators: ({ event }) => new Map(event.output.evaluators.filter((r) => isId(r?.id)).map((r) => [r.id, record(r)])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "list?") message.reply({ evaluators: [] });
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
            settleAll(context, enqueue);
            for (const message of context.queued) flush(context, message, enqueue);
            enqueue.assign({ queued: [] });
            if (context.userId) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
        onError: {
          target: "ready.idle",
          actions: enqueueActions(({ context, enqueue }) => {
            settleAll(context, enqueue);
            for (const message of context.queued) flush(context, message, enqueue);
            enqueue.assign({ queued: [] });
            if (context.userId) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
      },
      on: QUEUED,
    },
    ready: {
      initial: "idle",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.payload.book, event.reply) },
        "evaluator.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        "evaluator.switched": { actions: enqueueActions(({ context, event, enqueue }) => applySwitch(context, event, enqueue)) },
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
            for (const r of context.evaluators.values()) {
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
        "list?": { actions: ({ event }) => event.reply({ evaluators: [] }) },
      },
    },
  },
});

// Adopt one record the server holds: its content and version, with this tab's marks
// kept on what is still there. Announced as a change or, for a tombstone of an
// evaluator this tab was showing, as gone.
function adopt(context, server, enqueue) {
  const held = context.evaluators.get(server.id);
  let r = record({ ...server, removing: held?.removing });
  if (held && !held.deleted && !r.deleted) {
    const marks = new Map(held.questions.map((q) => [q.id, q]));
    r = {
      ...r,
      questions: r.questions.map((q) => {
        const old = marks.get(q.id);
        if (!old) return q;
        const opts = new Set(old.options.filter((o) => o.removing).map((o) => o.id));
        return { ...q, removing: old.removing, options: q.options.map((o) => (opts.has(o.id) ? { ...o, removing: true } : o)) };
      }),
    };
  }
  if (r.deleted) r.removing = false;
  context.evaluators.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (r.deleted) {
    if (visible(held)) enqueue.emit({ type: "evaluator.deleted", id: r.id, book: r.book });
  } else {
    enqueue.emit({ type: "evaluator.changed", evaluator: announce(context, r) });
  }
}

// Apply a sync's summary: adopt acknowledged and pulled records, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    const row = context.outbox.get(ack.id);
    const held = context.evaluators.get(ack.id);
    // The server holds a tombstone (a delete always wins, 5): the evaluator is gone here too.
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
    context.evaluators.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    if (visible(r)) enqueue.emit({ type: "evaluator.changed", evaluator: announce(context, r) });
  }

  for (const server of pulled) {
    const current = context.evaluators.get(server.id);
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
      context.evaluators.set(r.id, r);
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
