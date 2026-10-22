import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the generators and what they write (3.1), replicated (5)
// the way `choice-points` is: local-first, cached in the browser, numbering versions
// itself while signed out and syncing to the per-user server when signed in. The last
// write wins and nothing is deleted (5). The view where the user acted emits
// generator.edited (4.3, fifth rule). Everything with a side effect (the store, the
// network, the ask) arrives through input, so this stays a pure definition importable in
// Node.

const IDS = ["chat-title", "journal-summary"];
const isGenerator = (v) => IDS.includes(v);
const HEX64 = /^[0-9a-f]{64}$/;
const isResultId = (v) => typeof v === "string" && IDS.some((g) => v.startsWith(`${g}:`) && v.length > g.length + 1);
const str = (v) => (typeof v === "string" ? v : "");
const version = (v) => (Number.isInteger(v) && v >= 1 ? v : 1);

// What a generator is when the account has stored nothing for it: the texts the owner
// approved.
const DEFAULTS = {
  "chat-title": {
    id: "chat-title",
    name: "Chat title",
    on: true,
    model: "claude-haiku-5-5",
    prompt:
      "Name this chat in 3 to 6 words from its first message and the first answer. The message " +
      "may be a question, a request or a note, so name the subject, not the kind of message. Use " +
      "the language of the message. No quotes and no full stop.",
    version: 1,
  },
  "journal-summary": {
    id: "journal-summary",
    name: "Journal summary",
    on: true,
    model: "claude-haiku-5-5",
    prompt:
      "Summarise this journal entry in one short paragraph of at most two sentences: what the day " +
      "was about, including what I was working on in its choice points. Keep my own words. No " +
      "advice and no judgement.",
    version: 1,
  },
};

// --- Records --------------------------------------------------------------------------

// One fixed shape and key order per kind, so two copies of the same content compare
// equal as text. A record's kind is read from its id: a result's id holds a colon, a
// generator's never does.
const generatorRecord = (r) => ({
  id: r.id,
  name: str(r.name),
  on: r.on !== false,
  model: typeof r.model === "string" && r.model !== "" ? r.model : DEFAULTS[r.id].model,
  prompt: str(r.prompt),
  version: version(r.version),
});
const resultRecord = (r) => ({
  id: r.id,
  generator: r.generator,
  item: r.item,
  text: str(r.text),
  source: r.source,
  version: version(r.version),
});
const validGenerator = (r) => isGenerator(r?.id);
const validResult = (r) =>
  isResultId(r?.id) && isGenerator(r.generator) && typeof r.item === "string" && r.id === `${r.generator}:${r.item}` && HEX64.test(r.source ?? "");
const record = (r) => (isResultId(r.id) ? resultRecord(r) : generatorRecord(r));
const valid = (r) => (isResultId(r?.id) ? validResult(r) : validGenerator(r));

// What a write carries, and what decides whether a change is a new version.
const content = (r) => {
  const { version: _, ...rest } = record(r);
  return rest;
};
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

const generatorOf = (context, id) => context.generators.get(id) ?? DEFAULTS[id];

const announce = (r) =>
  isResultId(r.id)
    ? { type: "generation.changed", result: resultRecord(r) }
    : { type: "generator.changed", generator: generatorRecord(r) };

const replyList = (context, reply) => reply({ generators: IDS.map((id) => generatorRecord(generatorOf(context, id))) });

function replyResults(context, generator, reply) {
  const results = [...context.results.values()]
    .filter((r) => r.generator === generator)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(resultRecord);
  reply({ results });
}

const table = (context, id) => (isResultId(id) ? context.results : context.generators);

// --- Changes --------------------------------------------------------------------------

// The one place a changed record is kept, stored and announced. A change of content is
// a new version: signed out it is minted here; signed in the record keeps the version
// it holds, is queued in the outbox (coalesced by id, keeping the first unsynced base)
// and a drain is asked for. A generator never stored stands at its default, so its first
// write has no base.
function commit(context, enqueue, next) {
  const current = table(context, next.id).get(next.id);
  const shown = current ?? (isResultId(next.id) ? undefined : DEFAULTS[next.id]);
  if (shown && same(shown, next)) return;
  let r = record(next);
  if (context.userId == null) r = { ...r, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...r, version: current.version };
  table(context, r.id).set(r.id, r);
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

// generator.edited carries only the fields the user changed.
function applyEdit(context, event, enqueue) {
  if (!isGenerator(event.id)) return;
  const next = { ...generatorOf(context, event.id) };
  for (const key of ["name", "prompt"]) if (typeof event[key] === "string") next[key] = event[key];
  if (typeof event.on === "boolean") next.on = event.on;
  if (typeof event.model === "string" && event.model !== "") next.model = event.model;
  commit(context, enqueue, next);
}

// A text a generator wrote for an item, sent as `_result` by the part that asks the
// model; the bus never routes it (7.2).
function applyResult(context, event, enqueue) {
  const next = { id: `${event.generator}:${event.item}`, generator: event.generator, item: event.item, text: event.text, source: event.source };
  if (!validResult(next) || typeof event.text !== "string") return;
  commit(context, enqueue, next);
}

// A query or message that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "results?") replyResults(context, message.payload.generator, message.reply);
  else if (message.type === "generator.edited") applyEdit(context, message, enqueue);
  else if (message.type === "_result") applyResult(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(["list?", "results?", "generator.edited", "_result"].map((t) => [t, { actions: queue }]));

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

const ready = (context, enqueue) => {
  for (const message of context.queued) flush(context, message, enqueue);
  enqueue.assign({ queued: [] });
  if (context.userId) enqueue.raise({ type: "_sync", pull: true });
};

// The browser changed account while this fact was not on the page (12): a copy kept for
// another account, with nothing of it left to upload, is emptied before it is read, so
// none of it is shown to the account now signed in or uploaded as its own.
// The copy is marked with the account it now follows, so the next account change finds it.
async function claim(store, ask) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, outbox] = await Promise.all([store.metaGet("userId"), store.outboxAll()]);
  if (kept && kept !== userId && outbox.length === 0) await store.empty();
  if (kept !== userId) await store.metaPut("userId", userId).catch(() => {});
}

// The part that asks the model is not built yet: the events it will follow are consumed
// and change nothing. XState lists only a transition that does
// something, so each key needs an action for the manifest reader to see it.
const later = { actions: () => {} };

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
      const [records, outbox, cursor, userId] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      return { records, outbox, cursor: cursor ?? 0, userId: userId ?? null };
    }),
    // Missing (a Node test) is treated as signed out, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // Empties the local copy in one transaction, outbox and cache together (12).
    empty: fromPromise(({ input }) => input.store.empty()),
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
      return { acks, pulled: [...(pulled.generators ?? []), ...(pulled.results ?? [])], newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "generators",
  meta: {
    description:
      "Owns the generators and what they write. A generator is an instruction the model runs " +
      "by itself at a fixed moment, whose short text lands in a fixed place; an evaluator judges " +
      "text, a generator writes it. There are two, with fixed ids: chat-title, for naming a chat " +
      "from its first message and answer, and journal-summary, for one short paragraph about a " +
      "past journal day. Each has a name, on or off, a model and a prompt; `generators: list` " +
      "answers both, with the approved defaults (Haiku 5.5, on) for one the account never " +
      "changed. A change made in the Generators tab (generator.edited) carries only the fields " +
      "changed; it is kept and announced as generator.changed. Each result is kept per generator " +
      "and item (a chat's id, a day's date) with the SHA-256 of the content it was made from, so " +
      "an item needs a new text only when its content changes, never because the prompt did; " +
      "`generators: results` answers one generator's results, and every result kept or pulled " +
      "is announced as generation.changed. Nothing on the page writes a result yet: the part " +
      "that asks the model is not built, so results arrive only from the account's server. " +
      "Replicated (5): it works signed out, numbering versions itself, and syncs to the account " +
      "when signed in, so generators and results are the same on every device; the last write " +
      "wins and nothing is deleted.",
    kind: "fact",
    shape: "replicated",
    owns: "the generators and the texts they wrote",
    emits: ["generator.changed", "generation.changed"],
    asks: ["session: read", "journal: read", "choice-points: list", "llm: generate"],
  },
  context: ({ input }) => ({
    generators: new Map(),
    results: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    userId: null,
    cursor: 0,
    queued: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    resync: false,
    pull: false,
  }),
  // While loading, only whether the browser is leaving is kept (12); the rest of the
  // news is read from session once the store is loaded.
  on: {
    "session.changed": { actions: assign({ leaving: ({ event }) => event.leaving === true }) },
    "generation.requested": later,
    "conversation.changed": later,
    "conversation.opened": later,
    "journal.changed": later,
    "choice-point.changed": later,
    "choice-point.deleted": later,
    "day.shown": later,
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask }),
        onDone: {
          target: "checkingSession",
          actions: assign(({ event }) => {
            const records = event.output.records.filter(valid).map(record);
            return {
              generators: new Map(records.filter((r) => !isResultId(r.id)).map((r) => [r.id, r])),
              results: new Map(records.filter((r) => isResultId(r.id)).map((r) => [r.id, r])),
              outbox: new Map(event.output.outbox.map((row) => [row.id, row])),
              cursor: event.output.cursor,
              userId: event.output.userId,
            };
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) {
              if (message.type === "list?") replyList(context, message.reply);
              else if (message.type === "results?") message.reply({ results: [] });
            }
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
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "results?": { actions: ({ context, event }) => replyResults(context, event.payload.generator, event.reply) },
        "generator.edited": { actions: enqueueActions(({ context, event, enqueue }) => applyEdit(context, event, enqueue)) },
        _result: { actions: enqueueActions(({ context, event, enqueue }) => applyResult(context, event, enqueue)) },
        // Signing in enqueues the whole cache, so what was made signed out becomes the
        // account's (5); a different user resets the cursor.
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
            const userId = event.userId;
            if (userId === context.userId) return;
            enqueue.assign({ userId });
            enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
            if (!userId) return;
            enqueue.assign({ cursor: 0 });
            enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
            for (const r of [...context.generators.values(), ...context.results.values()]) {
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
          entry: assign({ generators: () => new Map(), results: () => new Map() }),
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
        "results?": { actions: ({ event }) => event.reply({ results: [] }) },
      },
    },
  },
});

// Adopt one record the server holds, its content and version, and announce it.
function adopt(context, server, enqueue) {
  const r = record(server);
  table(context, r.id).set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  enqueue.emit(announce(r));
}

// Apply a sync's summary: adopt acknowledged and pulled records, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    if (!valid(ack)) continue;
    const row = context.outbox.get(ack.id);
    const held = table(context, ack.id).get(ack.id);
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
    table(context, r.id).set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    enqueue.emit(announce(r));
  }

  for (const server of pulled) {
    if (!valid(server)) continue;
    const current = table(context, server.id).get(server.id);
    if (current && server.version <= current.version) continue;
    // A local change not yet sent is the later write, so it wins (last write wins) and
    // is sent at the next drain.
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
