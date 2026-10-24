import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { chatTitle, firstRound } from "./strategies/chat-title.js";
import { journalSummary, daySource } from "./strategies/journal-summary.js";

// The engine tests reach the strategies through the machine, their one importer (11.1).
export { chatTitle, firstRound, journalSummary, daySource };

// The fact component that owns the generators and what they write (3.1), replicated (5)
// the way `choice-points` is: local-first, cached in the browser, numbering versions
// itself while signed out and syncing to the per-user server when signed in. The last
// write wins and nothing is deleted (5). The view where the user acted emits
// generator.edited (4.3, fifth rule). Everything with a side effect (the store, the
// network, the ask) arrives through input, so this stays a pure definition importable in
// Node. It also runs the generators: the Strategies and Engine sections below.

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
      "Name this chat in 3 to 6 words from its first message, what was looked up for it and the " +
      "first answer. The message may be a question, a request or a note, so name the subject, not " +
      "the kind of message. When the message points at something (\"my open note\", \"this " +
      "chapter\"), name what that note, passage or book is about, and never use the words " +
      "\"note\" or \"open note\". Use the language of the message. No quotes and no full stop.",
    version: 1,
  },
  "journal-summary": {
    id: "journal-summary",
    name: "Journal summary",
    on: true,
    model: "claude-haiku-5-5",
    prompt:
      "Summarise this journal entry in one sentence of at most 25 words: what the day was about, " +
      "including what I was working on in its choice points. Keep my own words. No advice and no " +
      "judgement.",
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
  resume(r, enqueue);
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

// The SHA-256 of no content: the source of a title the user typed for a chat the
// generator has not named yet. chat-title names a chat only while it has no result
// (strategies/chat-title.js done), so the typed title is never replaced.
const TYPED = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// A title the user typed for a chat (conversation.renamed) is kept as that chat's
// chat-title result, so a device that pulls the results later shows what the user last
// set, not an older generated title. The text is kept as typed, trimmed: an empty one
// tells conversations to give the chat back its first line, on every device alike. The
// source stays the one the result has, so the chat still counts as named.
function applyRename(context, event, enqueue) {
  const id = `chat-title:${event.id}`;
  const current = context.results.get(id);
  commit(context, enqueue, { id, generator: "chat-title", item: event.id, text: event.title.trim(), source: current?.source ?? TYPED });
}

// A query or message that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "results?") replyResults(context, message.payload.generator, message.reply);
  else if (message.type === "generator.edited") applyEdit(context, message, enqueue);
  else if (message.type === "_result") applyResult(context, message, enqueue);
  else if (message.type === "conversation.renamed") applyRename(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(["list?", "results?", "generator.edited", "_result", "conversation.renamed"].map((t) => [t, { actions: queue }]));

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
// everything it holds first: when it already holds a result, this copy is emptied,
// outbox included, and the pull from 0 brings the account's. When it holds none, every
// result is queued for it on the version it holds, and the cursor goes back to 0. A
// generator is not sent: each has a fixed id the account already knows, and its settings
// there are the account's, which a copy from this browser would overwrite, since the last
// write wins (5). The mark is cleared only once every row is stored in the outbox, so a reload midway
// sends the copy again (coalesced by id) rather than losing it; when the account cannot
// be asked (offline), the mark stays and the next load decides. A mark left by a change
// of account that was called off names the account still signed in, and is only cleared.
async function keepFor(store, from, userId, api) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!Array.isArray(held?.results)) return;
    if (held.results.some(validResult)) {
      await store.empty();
      await store.metaPut("userId", userId);
    } else {
      const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      for (const r of records.filter(valid).map(record)) {
        if (!isResultId(r.id) || queued.has(r.id)) continue;
        const row = outboxRow(r, r.version);
        await store.outboxPut(row);
      }
    }
    await store.metaPut("cursor", 0);
  }
  await store.metaPut("adopt", null);
}

// --- Strategies -----------------------------------------------------------------------

// One strategy per kind of generator (13), a plain object in strategies/: the events it
// follows, what makes an item ready, the content a text is made from (its `source`
// object, keys in the order the backfill script writes them) and the text the model
// reads. Nothing about where the result shows: the result is announced and the place
// that shows it follows that.

const STRATEGIES = [chatTitle, journalSummary];
const strategyOf = (generator) => STRATEGIES.find((s) => s.generator === generator);

// --- The engine -----------------------------------------------------------------------

// The bytes a source is hashed from: keys in the order the strategy wrote them and no
// spaces, the same bytes as Python's json.dumps(obj, separators=(",", ":"),
// ensure_ascii=False), so the backfill script computes the same `source`.
export const canonical = (source) => JSON.stringify(source);

// SHA-256 hex of the UTF-8 of a text, through Web Crypto, which the browser and Node both
// have; a test may pass its own as input.sha256.
async function sha256(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const candidateKeys = (strategy, seen) =>
  new Set(strategy.items(seen).map((c) => `${c.item}\u0000${canonical(c.source)}`));

// A strategy hears one of its events. Only an item that is ready with content not seen
// before is news: it wakes the engine, and resumes it after an error.
function follow(context, strategy, event, enqueue) {
  const seen = context.seen[strategy.generator];
  const before = candidateKeys(strategy, seen);
  strategy.follow(seen, event);
  const after = candidateKeys(strategy, seen);
  if ([...after].some((k) => !before.has(k))) enqueue.assign({ dirty: true, stopped: false });
}

const FOLLOWING = Object.fromEntries(
  STRATEGIES.flatMap((strategy) =>
    strategy.follows.map((type) => [type, { actions: enqueueActions(({ context, event, enqueue }) => follow(context, strategy, event, enqueue)) }]),
  ),
);

// Run (generation.requested): the item in front goes first and is made even when a text
// from the same content exists.
function request(context, event, enqueue) {
  const strategy = strategyOf(event.generator);
  const target = strategy?.target(context.seen[strategy.generator]);
  if (!target) return;
  const job = { generator: strategy.generator, ...target, force: true };
  const others = context.forced.filter((f) => !(f.generator === job.generator && f.item === job.item));
  enqueue.assign({ forced: [job, ...others], dirty: true });
}

// What may be made, in order: Run's items first, then every ready item of a generator
// that is on, newest first. After an error only Run's items are left.
function jobs(context) {
  const background = context.stopped
    ? []
    : STRATEGIES.flatMap((strategy) => {
        const g = generatorOf(context, strategy.generator);
        if (!g.on || g.prompt === "") return [];
        return strategy.items(context.seen[strategy.generator]).map((c) => ({ generator: strategy.generator, ...c, force: false }));
      }).sort((a, b) => b.at - a.at);
  return [...context.forced, ...background].map((job) => {
    const g = generatorOf(context, job.generator);
    return { ...job, model: g.model, prompt: g.prompt };
  });
}

// A generator changed here or on another device: what it skipped or stopped on may run now.
const resume = (r, enqueue) => {
  if (!isResultId(r.id)) enqueue.assign({ dirty: true, stopped: false });
};

// The model's reply to the job in flight: a text is kept as the item's result, unless
// the item got one while the model worked (a title the user typed) and only Run may
// replace it; an error stops the engine until the page loads again, a generator changes
// or a new item is ready.
function settle(context, output, enqueue) {
  const job = context.current;
  const forced = context.forced.filter((f) => !(f.generator === job.generator && f.item === job.item));
  enqueue.assign({ current: null, forced });
  const held = context.results.get(`${job.generator}:${job.item}`);
  if (!job.force && strategyOf(job.generator).done(held, job.source)) enqueue.assign({ dirty: true });
  else if (typeof output?.text === "string") {
    applyResult(context, { generator: job.generator, item: job.item, text: output.text.trim(), source: job.source }, enqueue);
    enqueue.assign({ dirty: true });
  } else enqueue.assign({ stopped: true, dirty: forced.length > 0 });
}

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0 || context.leaving,
    // The browser is changing account (12): empty the local copy once nothing is left
    // to upload.
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
    // The engine works only for an account signed in with a passkey, never on a try
    // page, and not while the browser changes account (12).
    work: ({ context }) =>
      Boolean(context.userId) &&
      !context.guest &&
      !context.tryPage &&
      !context.leaving &&
      context.dirty &&
      (context.forced.length > 0 || !context.stopped),
  },
  actors: {
    // The starting picture of each strategy that reads one (journal: read, choice-points: list).
    scan: fromPromise(async ({ input }) => {
      const out = {};
      for (const strategy of STRATEGIES) if (strategy.load && input.ask) out[strategy.generator] = await strategy.load(input.ask);
      return out;
    }),
    // The first job whose item has no text from its current content (Run's always has
    // none), with its source hashed; null when nothing is left.
    pick: fromPromise(async ({ input }) => {
      for (const job of input.jobs) {
        const text = canonical(job.source);
        let hex = input.cache.get(text);
        if (!hex) {
          hex = await input.hash(text);
          input.cache.set(text, hex);
        }
        const strategy = strategyOf(job.generator);
        if (!job.force && strategy.done(input.results.get(`${job.generator}:${job.item}`), hex)) continue;
        return { generator: job.generator, item: job.item, source: hex, force: job.force, model: job.model, prompt: job.prompt, text: strategy.input(job.source) };
      }
      return null;
    }),
    generate: fromPromise(({ input }) =>
      input.ask ? input.ask("llm", "generate", input.payload) : Promise.resolve({ error: "unavailable" }),
    ),
    load: fromPromise(async ({ input }) => {
      const { store, ask, api } = input;
      await claim(store, ask, api);
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
      return { acks, pulled: [...(pulled.generators ?? []), ...(pulled.results ?? [])], newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "generators",
  meta: {
    description:
      "Owns the generators and what they write, and runs them. A generator is an instruction " +
      "the model runs by itself at a fixed moment, whose short text lands in a fixed place; an " +
      "evaluator judges text, a generator writes it. There are two, with fixed ids: chat-title " +
      "names a chat from its first message, what was looked up for it and the first answer; " +
      "journal-summary writes one sentence about a past journal day and its choice points. Each " +
      "has a name, on or off, a model and a prompt; `generators: list` answers both, with the " +
      "approved defaults (Haiku 5.5, on) for one the account never changed. A change made in the " +
      "Generators tab (generator.edited) carries only the fields changed; it is kept and announced " +
      "as generator.changed. While an account signed in with a passkey has a page open (never a " +
      "guest, never on a try page), it finds the items that are ready and have no text from their " +
      "current content: a chat whose first answer has just finished and that has no title from " +
      "here yet, heard through conversation.changed; and every day `journal: read` lists that can " +
      "no longer be written and has text or choice points (`choice-points: list`). It asks " +
      "`llm: generate` for one text at a time, newest item first, skipping a generator that is " +
      "off. Each result is kept per generator and item (a chat's id, a day's date) with the " +
      "SHA-256 of the content it was made from, so an item needs a new text only when its content " +
      "changes, never because the prompt did; the content is hashed as compact JSON with keys in " +
      "a fixed order, the same bytes Python writes, so a script can compute the same value. It " +
      "looks again when the page loads, when a day closes or its choice points change, and when " +
      "a chat's first answer finishes. An error from the model stops it until the page loads " +
      "again, a generator changes or a new item is ready. Run (generation.requested) makes the " +
      "text again now, with the current prompt, for the chat last opened (conversation.opened) " +
      "or the day last shown (day.shown), first in the queue. A chat whose first round looked " +
      "something up is not named yet, because conversation.changed carries a lookup's size, not " +
      "its content. `generators: results` answers one generator's results, and every result kept " +
      "or pulled is announced as generation.changed. A title the user types for a chat in the list " +
      "(conversation.renamed) is kept as that chat's chat-title result, trimmed, so every device " +
      "shows the title the user set last and an older generated one never comes back; an empty " +
      "one is kept empty, which gives the chat back its first line everywhere. It keeps the " +
      "result's source, so the chat stays named, and a text the model was still writing for that " +
      "chat is dropped; only Run names it again. Replicated (5): it works signed out, " +
      "numbering versions itself, and syncs to the account when signed in, so generators and " +
      "results are the same on every device; the last write wins and nothing is deleted.",
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
    // The browser joins the next account keeping this copy (12, keep).
    keep: false,
    resync: false,
    pull: false,
    // The engine: what each strategy has heard, Run's items, whether an error stopped it,
    // whether something may have become work, the job in flight, and hashes already made.
    seen: Object.fromEntries(STRATEGIES.map((r) => [r.generator, r.start()])),
    forced: [],
    stopped: false,
    dirty: false,
    current: null,
    hashes: new Map(),
    sha256: input.sha256 ?? sha256,
    tryPage: input.tryPage === true,
    guest: false,
  }),
  // While loading, only whether the browser is leaving is kept (12); the rest of the
  // news is read from session once the store is loaded.
  on: {
    "session.changed": {
      actions: assign({ leaving: ({ event }) => event.leaving === true, keep: ({ event }) => event.leaving === true && event.keep === true }),
    },
    "generation.requested": { actions: enqueueActions(({ context, event, enqueue }) => request(context, event, enqueue)) },
    ...FOLLOWING,
  },
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask, api: context.api }),
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
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            context.userId = event.output?.userId ?? null;
            enqueue.assign({ userId: context.userId, guest: event.output?.guest === true });
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
      type: "parallel",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "results?": { actions: ({ context, event }) => replyResults(context, event.payload.generator, event.reply) },
        "generator.edited": { actions: enqueueActions(({ context, event, enqueue }) => applyEdit(context, event, enqueue)) },
        _result: { actions: enqueueActions(({ context, event, enqueue }) => applyResult(context, event, enqueue)) },
        "conversation.renamed": { actions: enqueueActions(({ context, event, enqueue }) => applyRename(context, event, enqueue)) },
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
            enqueue.assign({ guest: event.guest === true });
            const userId = event.userId;
            if (userId === context.userId) return;
            enqueue.assign({ userId, dirty: true, stopped: false });
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
        sync: {
          initial: "idle",
          states: {
            // Leaving (12): what is left is uploaded at once, then the local copy is emptied.
            emptying: {
              entry: assign({ generators: () => new Map(), results: () => new Map() }),
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
        // One request to the model at a time (see the Engine section above).
        engine: {
          initial: "scanning",
          states: {
            scanning: {
              invoke: {
                src: "scan",
                input: ({ context }) => ({ ask: context.ask }),
                onDone: {
                  target: "idle",
                  actions: enqueueActions(({ context, event, enqueue }) => {
                    for (const strategy of STRATEGIES) if (event.output[strategy.generator]) strategy.loaded(context.seen[strategy.generator], event.output[strategy.generator]);
                    enqueue.assign({ dirty: true });
                  }),
                },
                onError: { target: "idle", actions: assign({ dirty: true }) },
              },
            },
            idle: { always: { guard: "work", target: "picking" } },
            picking: {
              entry: assign({ dirty: false }),
              invoke: {
                src: "pick",
                input: ({ context }) => ({ jobs: jobs(context), results: context.results, cache: context.hashes, hash: context.sha256 }),
                onDone: [
                  { guard: ({ event }) => event.output != null, target: "asking", actions: assign({ current: ({ event }) => event.output }) },
                  { target: "idle" },
                ],
                onError: { target: "idle" },
              },
            },
            asking: {
              invoke: {
                src: "generate",
                input: ({ context }) => {
                  const { model, prompt, text } = context.current;
                  return { ask: context.ask, payload: { model, prompt, text } };
                },
                onDone: { target: "idle", actions: enqueueActions(({ context, event, enqueue }) => settle(context, event.output, enqueue)) },
                onError: { target: "idle", actions: enqueueActions(({ context, enqueue }) => settle(context, null, enqueue)) },
              },
            },
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
  resume(r, enqueue);
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
    resume(r, enqueue);
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
