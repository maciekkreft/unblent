import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { ulid } from "ulid";

// The fact component that owns the prompt sets (3.1), replicated (5) the way
// `choice-points` is: local-first, cached in the browser, numbering versions itself while
// signed out and syncing to the per-user server when signed in. The last write wins and
// a delete is a tombstone that always wins (5). The view where the user acted emits
// prompt-set.saved (4.3, fifth rule). Everything with a side effect (the store, the
// network, the ask) arrives through input, so this stays a pure definition importable in
// Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const prompts = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === "string") : []);

const TEXTS = ["name", "occasion", "basedOn", "position"];

// --- Starter sets -----------------------------------------------------------------------

// Our own wording, crediting the book and never quoting it. Each id is fixed, so every
// device writes the same records and the server keeps one of each; the time part is
// zero, so they sort before every id a view mints. The positions leave room between
// them for a set placed among them.
const starterId = (n) => `0000000000PRMPTSET${String(n).padStart(8, "0")}`;
export const STARTERS = [
  ["Small truths", "Relationship", "The Seven Principles for Making Marriage Work, John Gottman", [
    "What did I feel today that I didn't say?",
    "When did my partner reach out to me, and how did I respond?",
    "When did I reach out, and what happened?",
    "What one small thing could I share tonight?",
  ]],
  ["Morning intention", "Morning", "Meditations, Marcus Aurelius", [
    "What is likely to test me today?",
    "How do I want to meet it?",
    "What one thing matters most today?",
  ]],
  ["Evening review", "Evening", "On Anger, Seneca", [
    "What did I do well today?",
    "Where did I fall short?",
    "What would I do differently tomorrow?",
  ]],
  ["Three good things", "Evening", "Flourish, Martin Seligman", [
    "What three things went well today?",
    "Why did each one happen?",
  ]],
  ["Unhooking", "Hard moment", "The Happiness Trap, Russ Harris", [
    "What thought hooked me?",
    "What did I do when it hooked me?",
    "Which value did I move toward or away from?",
    "What small step toward it can I take next?",
  ]],
  ["Being kind to myself", "Hard moment", "Self-Compassion, Kristin Neff", [
    "What is hard right now?",
    "How would a good friend speak to me about it?",
    "How is this part of being human?",
    "What kind words can I give myself now?",
  ]],
  ["Writing it out", "Hard moment", "Opening Up by Writing It Down, James Pennebaker", [
    "What is weighing on me that I haven't told anyone?",
    "What do I feel about it, as honestly as I can?",
    "How does it connect to my past, my relationships, or who I want to be?",
  ]],
  ["Balanced thinking", "Hard moment", "Feeling Good, David Burns", [
    "What happened?",
    "What did I feel, and how strongly, from 0 to 100?",
    "What did I tell myself?",
    "What is a more balanced way to see it?",
  ]],
  ["Meeting a part", "Hard moment", "No Bad Parts, Richard Schwartz", [
    "Which part of me was loud today?",
    "What is it afraid would happen if it stopped?",
    "What does it need from me?",
  ]],
  ["Habit check", "Evening", "Atomic Habits, James Clear", [
    "Which habit did I keep today?",
    "What made it easy or hard?",
    "How could I make it easier tomorrow?",
  ]],
].map(([name, occasion, basedOn, list], i) => ({
  id: starterId(i + 1),
  name,
  occasion,
  basedOn,
  prompts: list,
  position: "2468ACEGIK"[i],
}));
const STARTER = new Map(STARTERS.map((s) => [s.id, s]));

// --- Records --------------------------------------------------------------------------

// One fixed shape and key order, so two copies of the same content compare equal as
// text.
const toRecord = (r) => ({
  id: r.id,
  name: str(r.name),
  occasion: str(r.occasion),
  basedOn: str(r.basedOn),
  prompts: prompts(r.prompts),
  position: str(r.position),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  ...(r.deleted === true ? { deleted: true } : {}),
  // The step that last wrote it in this browser (12, Undo); the server never has it.
  ...(typeof r.step === "string" ? { step: r.step } : {}),
});

// What a write carries, and what decides whether a change is a new version.
const content = (r) => ({ name: r.name, occasion: r.occasion, basedOn: r.basedOn, prompts: r.prompts, position: r.position });
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

// A starter set as it came with the app, never changed or deleted.
const untouched = (r) => !r.deleted && STARTER.has(r.id) && same(r, STARTER.get(r.id));

// A tombstone is kept for the sync (5) but never listed or announced as a change.
const visible = (r) => r && !r.deleted;

const announce = (context, r) => {
  const { deleted, version, step, ...rest } = r;
  return { ...rest, version, pending: context.outbox.has(r.id) };
};

const byPosition = (a, b) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function replyList(context, reply) {
  const sets = [...context.sets.values()].filter(visible).sort(byPosition).map((r) => announce(context, r));
  reply({ sets });
}

// --- Changes --------------------------------------------------------------------------

// A `starter` row asks the server to add the set only when it holds no record of that id,
// live or deleted, so writing the starters again never undoes what another device did to
// them (a deleted starter stays deleted, an edited one keeps its edit).
const outboxRow = (r, baseVersion, starter = false) => ({
  id: r.id,
  ...content(r),
  baseVersion,
  ...(r.deleted ? { deleted: true } : {}),
  ...(starter ? { starter: true } : {}),
});

// The one place a changed record is kept, stored and announced. A change of content is
// a new version: signed out it is minted here; signed in the record keeps the version
// it holds, is queued in the outbox (coalesced by id, keeping the first unsynced base)
// and a drain is asked for.
function commit(context, enqueue, next, starter = false) {
  const current = context.sets.get(next.id);
  const changed = !current || !same(current, next) || Boolean(next.deleted) !== Boolean(current.deleted);
  let r = next;
  if (changed && context.userId == null) r = { ...next, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...next, version: current.version };
  context.sets.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (changed && context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null, starter);
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  if (r.deleted) {
    if (visible(current)) enqueue.emit({ type: "prompt-set.deleted", id: r.id });
  } else {
    enqueue.emit({ type: "prompt-set.changed", set: announce(context, r) });
  }
  if (changed && context.userId != null) enqueue.raise({ type: "_drain" });
}

// The starter sets are written the first time this browser knows no set of the account
// at all, tombstones included, so a starter the user deleted is never written again. It
// is not a step (12): the user did nothing.
function seed(context, enqueue) {
  if (context.sets.size > 0) return;
  for (const s of STARTERS) commit(context, enqueue, toRecord(s), true);
}

// --- Steps (12, Undo) -------------------------------------------------------------------

// A set as a step names it: its content, whether it is deleted, and `prior`, the step
// that wrote it before this one, so an Undo leaves it as that step left it and the step
// before can be undone next.
const entry = (r, prior = r.step) => ({
  kind: "prompt-set",
  id: r.id,
  ...content(r),
  deleted: Boolean(r.deleted),
  ...(prior ? { prior } : {}),
});

// What a set undone back past every step this browser knows of is stamped with.
const before = (e, step) => e.prior ?? `^${step}`;

const NAME_MAX = 40;
function nameOf(r) {
  const name = str(r.name).trim();
  if (!name) return "a prompt set";
  return `prompt set ${name.length > NAME_MAX ? `${name.slice(0, NAME_MAX).trimEnd()}…` : name}`;
}

// Every save that changes a set is one step; adding one is a step whose Undo deletes it
// again, and a delete is a step that asks for the notice.
function recordStep(context, enqueue, was, next) {
  const removing = Boolean(next.deleted);
  const step = context.mint();
  const first = was ? entry(was) : entry({ ...next, deleted: true }, null);
  commit(context, enqueue, { ...next, step });
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "prompt-sets",
    label: `${removing ? "delete" : first.deleted ? "add" : "edit"} ${nameOf(removing ? was : next)}`,
    undo: first,
    redo: entry({ ...next, step }, first.prior ?? null),
    ...(removing ? { notice: true } : {}),
  });
}

// An Undo or Redo of one of this fact's steps. It is applied only while the set is as the
// step left it, last written in this browser by that step; anything written since, here,
// in another tab or on another device, refuses it. A deleted set comes back with a
// restore write (5).
function applyStep(context, event, enqueue) {
  if (event.owner !== "prompt-sets") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "prompt-sets", outcome, ...(reason ? { reason } : {}) });
  const p = event.payload ?? {};
  const undoing = event.type === "step.undone";
  const current = isId(p.id) ? context.sets.get(p.id) : null;
  const valid = p.kind === "prompt-set" && TEXTS.every((k) => typeof p[k] === "string") && Array.isArray(p.prompts);
  if (!valid || !current) return settle("refused", "changed");
  if (current.step !== (undoing ? event.id : before(p, event.id))) return settle("refused", "changed");
  const { deleted: _, ...live } = current;
  commit(context, enqueue, {
    ...live,
    ...content(toRecord(p)),
    ...(p.deleted ? { deleted: true } : {}),
    step: undoing ? before(p, event.id) : event.id,
  });
  settle("applied");
}

// A new id adds a set; a save to one already kept changes it; deleted: true removes it,
// and its tombstone keeps what it had, so it could still be restored. A deleted id stays
// deleted (5).
function applySave(context, event, enqueue) {
  if (!isId(event.id)) return;
  const was = context.sets.get(event.id);
  if (was?.deleted) return;
  const fields = toRecord(event);
  if (!was) {
    if (event.deleted === true) return;
    return recordStep(context, enqueue, null, { ...fields, version: 1 });
  }
  if (event.deleted === true) return recordStep(context, enqueue, was, { ...was, deleted: true });
  const next = { ...was, ...content(fields) };
  if (same(was, next)) return;
  recordStep(context, enqueue, was, next);
}

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.reply);
  else if (message.type === "prompt-set.saved") applySave(context, message, enqueue);
  else if (message.type === "step.undone" || message.type === "step.redone") applyStep(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(
  ["list?", "prompt-set.saved", "step.undone", "step.redone"].map((t) => [t, { actions: queue }]),
);

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

// Signed out, the starters are written as soon as the copy is read; signed in, only once
// the first pull has said what the account holds (applySync's caller), so a starter the
// user deleted on another device is not shown here first.
const ready = (context, enqueue) => {
  if (!context.userId) seed(context, enqueue);
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
// every set it holds first: when it already holds one that is not deleted, this copy is
// emptied, outbox included, and the pull from 0 brings the account's. When it holds none,
// every set is queued for it on the version it holds, which the server adopts on first
// insert, and the cursor goes back to 0; a starter set never changed is queued as a
// starter, so it cannot undo the account's delete of it. A tombstone is not sent. The
// mark is cleared only once every row is stored in the outbox, so a reload midway sends
// the copy again (coalesced by id) rather than losing it; when the account cannot be
// asked (offline), the mark stays and the next load decides. A mark left by a change of
// account that was called off names the account still signed in, and is only cleared.
async function keepFor(store, from, userId, api) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!Array.isArray(held?.sets)) return;
    if (held.sets.some((r) => isId(r?.id) && !r.deleted)) {
      await store.empty();
      await store.metaPut("userId", userId);
    } else {
      const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      for (const r of records.filter((r) => isId(r?.id)).map(toRecord)) {
        if (r.deleted || queued.has(r.id)) continue;
        await store.outboxPut(outboxRow(r, r.version, untouched(r)));
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
      const [sets, outbox, cursor, userId] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      return { sets, outbox, cursor: cursor ?? 0, userId: userId ?? null };
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
      return { acks, pulled: pulled.sets, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "prompt-sets",
  meta: {
    description:
      "Owns the account's prompt sets: the lists of the user's own questions a journal prompts " +
      "sheet asks. A set has a name, an occasion (a short label such as Morning, Evening or Hard " +
      "moment), the book and author it is based on, which may be empty, its prompts in the order " +
      "they are asked, and its place in the list, a key the view gives. `prompt-sets: list` " +
      "answers every set in list order, by that key. Ten starter sets based on well-known books " +
      "come with the app, in our own words, crediting the book and never quoting it. They have " +
      "fixed ids and are written by the browser, not the server, the first time it knows no set " +
      "of the account at all, deleted ones included: signed out as soon as its copy is read, " +
      "signed in only after the first pull from the account has come back empty, so nothing is " +
      "written while the account cannot be reached. Writing them is not a step. Each is sent to " +
      "the server as a starter, which the server adds only when it holds no record of that id, " +
      "so two devices never add them twice, a starter deleted anywhere stays deleted, and one " +
      "edited anywhere keeps its edit; signing in sends a starter the user never changed the " +
      "same way. Every save that changes a set is one step Undo and Redo reverse (section 12): " +
      "adding, editing or deleting a set, and a delete asks for the short notice. Undo of an add " +
      "deletes the set, and a deleted set comes back with a restore write the server accepts. A " +
      "step is refused when the set was written since by anything else. It works signed out, " +
      "numbering versions itself, and syncs to the account when signed in (section 5). The last " +
      "write wins, so two devices never conflict, and a deleted set is kept as a tombstone, " +
      "which always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["prompt-set.changed", "prompt-set.deleted", "step.recorded", "step.settled"],
    owns: "the account's prompt sets",
    steps: { "prompt-set.saved": "step" },
    asks: ["session: read"],
  },
  context: ({ input }) => ({
    sets: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    mint: input.mint ?? ulid,
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
          actions: assign({
            sets: ({ event }) => new Map(event.output.sets.filter((r) => isId(r?.id)).map((r) => [r.id, toRecord(r)])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "list?") message.reply({ sets: [] });
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
        "list?": { actions: ({ context, event }) => replyList(context, event.reply) },
        "prompt-set.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
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
            for (const r of context.sets.values()) {
              if (context.outbox.has(r.id)) continue;
              const row = outboxRow(r, r.version, untouched(r));
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
                const { authFailed, networkError, pulled } = event.output;
                if (authFailed || networkError) return;
                if (Array.isArray(pulled) && !context.leaving) seed(context, enqueue);
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
        "list?": { actions: ({ event }) => event.reply({ sets: [] }) },
      },
    },
  },
});

// Adopt one record the server holds: its content and version. Announced as a change or,
// for a tombstone of a set this tab was showing, as gone.
function adopt(context, server, enqueue) {
  const held = context.sets.get(server.id);
  const r = toRecord(server);
  context.sets.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (r.deleted) {
    if (visible(held)) enqueue.emit({ type: "prompt-set.deleted", id: r.id });
  } else {
    enqueue.emit({ type: "prompt-set.changed", set: announce(context, r) });
  }
}

const dropRow = (context, id, enqueue) => {
  context.outbox.delete(id);
  enqueue(() => context.store.outboxDelete(id).catch(() => {}));
};

// Apply a sync's summary: adopt acknowledged and pulled records, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    const row = context.outbox.get(ack.id);
    const held = context.sets.get(ack.id);
    // A starter the server already held, as another device left it: that copy is the set.
    if (row?.starter) {
      dropRow(context, ack.id, enqueue);
      if (held && !ack.deleted && same(held, toRecord(ack))) {
        const r = { ...held, version: ack.version };
        context.sets.set(r.id, r);
        enqueue(() => context.store.put(r).catch(() => {}));
        enqueue.emit({ type: "prompt-set.changed", set: announce(context, r) });
      } else adopt(context, ack, enqueue);
      continue;
    }
    // The server holds a tombstone (a delete always wins, 5): the set is gone here too.
    if (ack.deleted) {
      dropRow(context, ack.id, enqueue);
      // This browser's own delete keeps the step that made it, so it can still be undone.
      if (held?.deleted && same(held, toRecord(ack))) {
        const r = { ...held, version: ack.version };
        context.sets.set(r.id, r);
        enqueue(() => context.store.put(r).catch(() => {}));
      } else adopt(context, ack, enqueue);
      continue;
    }
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    const drained = row && same(toRecord(row), toRecord(ack));
    if (drained) dropRow(context, ack.id, enqueue);
    else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    // Keep the latest local content (a mid-sync edit), take the server's version.
    const r = held ? { ...held, version: ack.version } : toRecord(ack);
    context.sets.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    if (visible(r)) enqueue.emit({ type: "prompt-set.changed", set: announce(context, r) });
  }

  for (const server of pulled) {
    if (!isId(server?.id)) continue;
    const current = context.sets.get(server.id);
    // A starter not yet sent gives way to the account's copy, whatever its version.
    if (context.outbox.get(server.id)?.starter) {
      dropRow(context, server.id, enqueue);
      adopt(context, server, enqueue);
      continue;
    }
    if (current && server.version <= current.version) continue;
    // A local change not yet sent is the later write, so it wins (last write wins) and is
    // sent at the next drain; a delete there always wins (5). Otherwise a live copy of a
    // local tombstone at a higher version is a restore write made elsewhere (5).
    if (context.outbox.has(server.id) && !server.deleted) continue;
    if (server.deleted && context.outbox.has(server.id)) dropRow(context, server.id, enqueue);
    if (server.deleted && !current) {
      const r = toRecord(server);
      context.sets.set(r.id, r);
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
