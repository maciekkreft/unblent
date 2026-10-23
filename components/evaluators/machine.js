import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the evaluators (3.1), replicated (5) the way `notes` is:
// local-first, cached in the browser, numbering versions itself while signed out and
// syncing to the per-user server when signed in. Unlike a note an evaluator never
// conflicts: the last write wins, as the journal's detectors did, and a delete is a
// tombstone that always wins (5). The view where the user acted emits evaluator.saved,
// evaluator.switched, evaluator.moved and removal.started; notice-stack emits removal.undone or
// removal.settled when the undo window ends (4.3, fifth rule), and evaluator-list emits
// evaluator.discarded when the undo window on its row ends. Everything with a side
// effect (the store, the network, the ask) arrives through input, so this stays a pure
// definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const EXPECT = /^([0-9A-HJKMNP-TV-Z]{26}|yes|no)$/;
const str = (v) => (typeof v === "string" ? v : "");

// --- Records --------------------------------------------------------------------------

// Each part in one fixed shape and key order, so two copies of the same content compare
// equal as text. `removing` marks an item in this tab's undo window; it is kept in the
// cache (so a leftover mark settles at the next load) but never sent to the server.
// An option's icon is kept only when it names one, and absent otherwise, so an option
// that never had one compares equal to one kept from before icons were offered.
const option = (o) =>
  o && isId(o.id)
    ? {
        id: o.id,
        name: str(o.name),
        description: str(o.description),
        ...(typeof o.icon === "string" && o.icon ? { icon: o.icon } : {}),
        removing: o.removing === true,
      }
    : null;

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
        ...(EXPECT.test(q.expect ?? "") ? { expect: q.expect } : {}),
      }
    : null;

// The expected answer holds only while it names an answer the question has: yes or no,
// or one of its options (marked ones too, so an Undo brings it back), whichever kind the
// question is now; the options are kept across a switch of kind, and so is the
// expectation, so switching back brings it back (a reader honours it only for its kind).
// A settled removal of its option takes it away.
const fitExpect = (q) => {
  const { expect, ...rest } = q;
  const holds = expect === "yes" || expect === "no" || q.options.some((o) => o.id === expect);
  return holds ? { ...rest, expect } : rest;
};

const questionsOf = (list) => (Array.isArray(list) ? list : []).map(question).filter(Boolean);

// The try pages (8) an admin's evaluator is a starter for, by name, each once and in one
// order, so two copies of the same ticks compare equal.
const pagesOf = (list) => [...new Set((Array.isArray(list) ? list : []).filter((p) => typeof p === "string" && p))].sort();

const record = (r) => ({
  id: r.id,
  book: r.book,
  name: str(r.name),
  on: r.on !== false,
  questions: questionsOf(r.questions),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  removing: r.removing === true,
  starterFor: pagesOf(r.starterFor),
  ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
  ...(isPosition(r.position) ? { position: r.position } : {}),
  ...(r.deleted === true ? { deleted: true } : {}),
});

// --- Places in the list -----------------------------------------------------------------

// An evaluator's place in the list is a fractional index (5, an item's place is last
// write wins), the same design as a note's (notes/machine.js): a string that sorts by
// plain code-unit comparison, so an evaluator moved between two others takes a key
// between theirs and no other evaluator changes. The digits are in ASCII order, and a key
// never ends in the smallest digit, so there is always room before it.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
export const isPosition = (value) => typeof value === "string" && value.length <= 200 && KEY.test(value);

// The key between a and b (a < b); "" stands for before everything, null for after.
function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

// A key strictly between `after` and `before`, either null for the list's end. Out of
// order neighbours (a move computed against a list that changed meanwhile) place the
// evaluator just after `after`.
export function between(after, before) {
  const a = isPosition(after) ? after : "";
  const b = isPosition(before) && before > a ? before : null;
  return midpoint(a, b);
}

// An evaluator from before places existed has no key and keeps today's order, oldest
// first: its key is "z", its id and "V", so it sorts after every key `between` makes for
// a new evaluator and among its kind by id, the same on every device. The key is written
// down only when it is moved, so an edit never moves it.
export const positionOf = (r) => (isPosition(r.position) ? r.position : `z${r.id}V`);

// List order: by key, then by id where two keys are equal.
const byPosition = (a, b) => {
  const pa = positionOf(a);
  const pb = positionOf(b);
  return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

// A new evaluator goes first (5): a key before every evaluator's.
function firstPosition(context) {
  let min = null;
  for (const r of context.evaluators.values()) {
    if (!visible(r)) continue;
    const p = positionOf(r);
    if (min === null || p < min) min = p;
  }
  return between(null, min);
}

// An outbox row with content (a save or a delete), as against one that only moves.
const hasContent = (row) => row != null && "name" in row;

// The questions as another device is told them: every mark stripped.
const bare = (questions) =>
  questions.map(({ removing, options, ...q }) => ({ ...q, options: options.map(({ removing: _, ...o }) => o) }));

// What a write carries, and what decides whether a change is a new version. The marks
// belong to this tab's undo window, so setting or clearing one is not a change.
const content = (r) => ({
  book: r.book,
  name: r.name,
  on: r.on,
  questions: bare(r.questions),
  starterFor: pagesOf(r.starterFor),
});
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));

// A tombstone is kept for the sync (5) but never listed or announced as a change.
const visible = (r) => r && !r.deleted;

// starterFor rides only on an evaluator that is a starter somewhere, so everyone else's
// evaluators are announced as before.
const announce = (context, r) => {
  const { deleted, starterFor, ...rest } = r;
  return { ...rest, position: positionOf(r), ...(starterFor?.length ? { starterFor } : {}), pending: context.outbox.has(r.id) };
};

function replyList(context, book, reply) {
  const evaluators = [...context.evaluators.values()]
    .filter((r) => visible(r) && (book === undefined || r.book === book))
    .sort(byPosition)
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
function commit(context, enqueue, given) {
  const next = { ...given, questions: given.questions.map(fitExpect) };
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
    const row = outboxRow(r, hasContent(existing) ? existing.baseVersion : current ? current.version : null);
    // The place rides the write only when this device set it (5: last write wins), so an
    // edit never carries a stale place over a move made on another device.
    if (isPosition(r.position) && (existing?.position !== undefined || !isPosition(current?.position))) row.position = r.position;
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
// changes its name and its questions, keeps its book and its tick, and keeps whatever
// of it is still in its undo window. A deleted id stays deleted (5).
// A `journal` field in a save or a stored row is no longer read: the schemas keep it
// because contracts only grow (7.1), and a write leaving it out keeps the server's.
function applySave(context, event, enqueue) {
  if (!isId(event.id) || context.evaluators.get(event.id)?.deleted) return;
  const was = live(context, event.id);
  if (!was) {
    if (!isId(event.book)) return;
    const position = firstPosition(context);
    return commit(context, enqueue, record({ id: event.id, book: event.book, name: event.name, on: true, questions: event.questions, position }));
  }
  const questions = keepMarked(
    was.questions,
    questionsOf(event.questions).map((q) => {
      const old = was.questions.find((x) => x.id === q.id);
      return { ...q, options: keepMarked(old ? old.options : [], q.options) };
    }),
  );
  const next = { ...was, name: str(event.name), questions };
  if (same(was, next)) return;
  commit(context, enqueue, next);
}

// The admin ticked or unticked an evaluator as a starter for a try page (8). Only the
// admin's sheet shows the ticks; the server keeps starterFor only from the admin (5).
function applyTick(context, { evaluator, page, on }, enqueue) {
  const was = live(context, evaluator);
  if (!was) return;
  const starterFor = pagesOf(on ? [...was.starterFor, page] : was.starterFor.filter((p) => p !== page));
  if (JSON.stringify(starterFor) === JSON.stringify(was.starterFor)) return;
  commit(context, enqueue, { ...was, starterFor });
}

// --- Starters on a try page (8) --------------------------------------------------------

// One starter as the visitor's own: new ids for it, its questions and their options, so
// nothing of the admin's is shared; kept with the Journal, switched on as every new
// evaluator is, and a starter for nothing. Later changes by the admin never reach it.
const copyOf = (starter, journal, newId) =>
  record({
    id: newId(),
    book: journal,
    name: starter.name,
    on: true,
    questions: questionsOf(starter.questions).map((q) => {
      const ids = new Map(q.options.map((o) => [o.id, newId()]));
      return {
        ...q,
        id: newId(),
        removing: false,
        options: q.options.map((o) => ({ ...o, id: ids.get(o.id), removing: false })),
        ...(q.expect ? { expect: ids.get(q.expect) ?? q.expect } : {}),
      };
    }),
  });

// The copies are made only once the Journal's id is known and the starters have come;
// without either nothing is copied, and the page works as it would with no starters.
function seed(context, enqueue) {
  const starters = context.seeds ?? [];
  if (!context.journal || starters.length === 0) return;
  for (const starter of starters) commit(context, enqueue, copyOf(starter, context.journal, context.newId));
}

// How long the try page waits for the starters and the Journal before it shows the
// evaluators without them.
const SEED_WAIT_MS = 4000;

// The user moved an evaluator in the list (evaluator-list emits evaluator.moved, 4.3
// fifth rule): it takes a key between its new neighbours'. A place is last write wins
// (5): it bumps no version, so the list's remembered answers, kept by what an evaluator
// asks, stay; signed in it rides the outbox alone, or on the row of an edit not yet sent.
function applyMove(context, event, enqueue) {
  const current = live(context, event.id);
  if (!current) return;
  const neighbour = (id) => {
    const r = id && id !== event.id ? live(context, id) : null;
    return r ? positionOf(r) : null;
  };
  const position = between(neighbour(event.after), neighbour(event.before));
  if (position === current.position) return;
  const r = { ...current, position };
  context.evaluators.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = existing ? { ...existing, position } : { id: r.id, position };
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  enqueue.emit({ type: "evaluator.changed", evaluator: announce(context, r) });
  if (context.userId != null) enqueue.raise({ type: "_drain" });
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

// Start over on a try page (8), once its Undo window ended: every evaluator here becomes
// a tombstone, uploaded like any delete, and _restart fetches the starters again and
// copies them in as on a first visit. Off a try page it means nothing.
function startOver(context, enqueue) {
  if (!context.tryPage) return;
  for (const r of [...context.evaluators.values()].filter(visible)) commit(context, enqueue, { ...r, removing: false, deleted: true });
  enqueue.raise({ type: "_restart" });
}

// The undo window on a list row ran out (evaluator-list, 4.3 fifth rule): the evaluator
// becomes a tombstone at once; it was never marked, since the list kept the window itself.
function applyDiscard(context, { id }, enqueue) {
  const r = live(context, id);
  if (r) commit(context, enqueue, { ...r, removing: false, deleted: true });
}

const settled = (context, message, enqueue) =>
  message.kind === "trial" ? startOver(context, enqueue) : applySettle(context, message, enqueue);

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
  else if (message.type === "evaluator.moved") applyMove(context, message, enqueue);
  else if (message.type === "starter.ticked") applyTick(context, message, enqueue);
  else if (message.type === "removal.started") applyMark(context, message, true, enqueue);
  else if (message.type === "removal.undone") applyMark(context, message, false, enqueue);
  else if (message.type === "removal.settled") settled(context, message, enqueue);
  else if (message.type === "evaluator.discarded") applyDiscard(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(
  ["list?", "evaluator.saved", "evaluator.switched", "evaluator.moved", "starter.ticked", "removal.started", "removal.undone", "removal.settled", "evaluator.discarded"].map((t) => [t, { actions: queue }]),
);

// A visitor on a try page (8) with nothing in this browser yet gets the page's
// starters. A signed-in account, a guest among them, sees the page as itself.
const seedable = (context, userId) =>
  Boolean(context.tryPage) &&
  userId == null &&
  context.evaluators.size === 0 &&
  context.outbox.size === 0 &&
  typeof context.api?.starters === "function";

// Who is signed in is known: leftover marks settle, a try page's copies are made when
// they were fetched, what waited is replayed in order, and a signed-in tab syncs.
function settle(context, enqueue, seeding = false) {
  settleAll(context, enqueue);
  if (seeding) {
    seed(context, enqueue);
    enqueue.assign({ seeds: null });
  }
  for (const message of context.queued) flush(context, message, enqueue);
  enqueue.assign({ queued: [] });
  if (context.userId) enqueue.raise({ type: "_sync", pull: true });
}

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

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

// The browser joined an account keeping this copy (12, keep): every evaluator is queued
// for the account on the version it holds, which the server adopts on first insert, and
// the cursor goes back to 0, so the pull then brings the account's own. A tombstone is not sent: the account never had the record, so there is nothing
// to delete. The mark is
// cleared only once every row is stored in the outbox, so a reload midway sends the copy
// again (coalesced by id) rather than losing it. A mark left by a change of account that
// was called off names the account still signed in, and is only cleared.
async function keepFor(store, from, userId) {
  if (!from) return;
  if (from !== userId) {
    const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
    const queued = new Set(outbox.map((row) => row.id));
    for (const r of records.filter((r) => isId(r?.id)).map(record)) {
      if (r.deleted || queued.has(r.id)) continue;
      const row = outboxRow(r, r.version);
      if (isPosition(r.position)) row.position = r.position;
      await store.outboxPut(row);
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
    // Both have come: the starters, and the Journal's id unless there is nothing to copy.
    seedsIn: ({ context }) => context.seeds !== null && (context.seeds.length === 0 || context.journal !== null),
  },
  actors: {
    load: fromPromise(async ({ input }) => {
      const { store, ask } = input;
      await claim(store, ask);
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
    // The try page's starters from the server, which needs no account (8).
    starters: fromPromise(({ input }) => input.api.starters(input.page)),
    // The Journal is the book books marks written; it may come later, on book.changed.
    books: fromPromise(({ input }) => input.ask("books", "list", {})),
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
        // A move for an evaluator the server never had: nothing to place (applySync).
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
      "options, each option with an optional icon its mark on a choice point line shows; a " +
      "question may name the answer expected (an option, or yes or no), kept across a switch " +
      "of kind and back, which a removed option takes with it once its removal settles; and it is switched on or off. Each question is switched on or off too: one " +
      "switched off is kept, with its wording, but not asked, and a question without the " +
      "switch counts as on. `evaluators: list` answers one book's evaluators, " +
      "or every book's when no book is given, in their places in the list, each with when its content last " +
      "changed (`updatedAt`, absent on one kept from before it was recorded). A new evaluator starts switched on and " +
      "goes first in the list; an edit never moves an evaluator, and a move from the list " +
      "(`evaluator.moved`) puts it between its new neighbours, the same on every device. A " +
      "place is last write wins and changes no version. An evaluator from before places keeps " +
      "the order it had, oldest first, until it is moved. It works signed out, numbering versions " +
      "itself, and syncs to the account when signed in (section 5); signing in uploads every " +
      "evaluator with its history. The last write wins, so two devices never conflict, and a " +
      "deleted evaluator is kept as a tombstone, which always wins. A removed evaluator, question " +
      "or option is marked while its undo window runs and goes only when the window ends; a mark " +
      "left by a closed tab ends at the next load. An evaluator deleted from the list " +
      "(`evaluator.discarded`) is not marked, since the list counts its undo window down on the " +
      "row, and goes at once when that window ends. An evaluator reads what it is given: the " +
      "book's Run box asks the switched-on evaluators about a typed text, and " +
      "choice-point-checks asks the one chosen for a choice point box about each of its " +
      "lines, whether it is switched on or not. The admin ticks evaluators as starters for a try " +
      "page (`starterFor`, by the page's name); the server keeps a copy of the ticked ones for " +
      "visitors. On a try page, a visitor whose browser holds no evaluators yet gets a copy of " +
      "each of that page's starters before anything is listed, with new ids, switched on and " +
      "kept with the Journal; the copies are the visitor's own and upload with the rest once " +
      "the guest is made, and later changes by the admin do not reach them. Start over on a " +
      "try page, once its Undo window ends, deletes every evaluator in the browser and " +
      "copies the starters in again the same way.",
    kind: "fact",
    shape: "replicated",
    emits: ["evaluator.changed", "evaluator.deleted"],
    owns: "the evaluators kept with each book",
    asks: ["session: read", "books: list"],
  },
  context: ({ input }) => ({
    evaluators: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    now: input.now ?? (() => new Date().toISOString()),
    // The try page this tab is on (8), by name, or null; and how a copy gets its ids.
    tryPage: input.tryPage ?? null,
    newId: input.newId,
    seeds: null,
    journal: null,
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
  initial: "loading",
  on: {
    // While loading, only whether the browser is leaving is kept (12); the rest of the
    // news is read from session once the store is loaded.
    "session.changed": {
      actions: assign({ leaving: ({ event }) => event.leaving === true, keep: ({ event }) => event.leaving === true && event.keep === true }),
    },
    // The Journal's id matters only while a try page copies its starters (seeding).
    "book.changed": { actions: () => {} },
    "book.deleted": { actions: () => {} },
  },
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask }),
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
        onDone: [
          {
            guard: ({ context, event }) => seedable(context, event.output?.userId ?? null),
            target: "seeding",
            actions: assign({ userId: null }),
          },
          {
            target: "ready.idle",
            actions: enqueueActions(({ context, event, enqueue }) => {
              context.userId = event.output?.userId ?? null;
              enqueue.assign({ userId: context.userId });
              settle(context, enqueue);
            }),
          },
        ],
        onError: [
          { guard: ({ context }) => seedable(context, context.userId), target: "seeding" },
          { target: "ready.idle", actions: enqueueActions(({ context, enqueue }) => settle(context, enqueue)) },
        ],
      },
      on: QUEUED,
    },
    // A visitor on a try page (8) with nothing here yet: the page's starters and the
    // Journal's id are fetched while queries and gestures wait, so the first list
    // already holds the copies.
    seeding: {
      invoke: [
        {
          src: "starters",
          input: ({ context }) => ({ api: context.api, page: context.tryPage }),
          onDone: { actions: assign({ seeds: ({ event }) => (Array.isArray(event.output?.evaluators) ? event.output.evaluators : []) }) },
          onError: { actions: assign({ seeds: [] }) },
        },
        {
          src: "books",
          input: ({ context }) => ({ ask: context.ask }),
          onDone: {
            actions: assign({
              journal: ({ context, event }) =>
                (Array.isArray(event.output?.books) ? event.output.books.find((b) => b?.written === true)?.id : null) ?? context.journal,
            }),
          },
          onError: { actions: [] },
        },
      ],
      always: { guard: "seedsIn", target: "ready.idle", actions: enqueueActions(({ context, enqueue }) => settle(context, enqueue, true)) },
      after: { [SEED_WAIT_MS]: { target: "ready.idle", actions: enqueueActions(({ context, enqueue }) => settle(context, enqueue, true)) } },
      on: {
        ...QUEUED,
        "book.changed": { guard: ({ event }) => event.written === true, actions: assign({ journal: ({ event }) => event.id }) },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "list?": { actions: ({ context, event }) => replyList(context, event.payload.book, event.reply) },
        "evaluator.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        "evaluator.switched": { actions: enqueueActions(({ context, event, enqueue }) => applySwitch(context, event, enqueue)) },
        "evaluator.moved": { actions: enqueueActions(({ context, event, enqueue }) => applyMove(context, event, enqueue)) },
        "starter.ticked": { actions: enqueueActions(({ context, event, enqueue }) => applyTick(context, event, enqueue)) },
        "removal.started": { actions: enqueueActions(({ context, event, enqueue }) => applyMark(context, event, true, enqueue)) },
        "removal.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyMark(context, event, false, enqueue)) },
        "removal.settled": { actions: enqueueActions(({ context, event, enqueue }) => settled(context, event, enqueue)) },
        "evaluator.discarded": { actions: enqueueActions(({ context, event, enqueue }) => applyDiscard(context, event, enqueue)) },
        _restart: { target: "#evaluators.seeding", actions: assign({ seeds: null }) },
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
            for (const r of context.evaluators.values()) {
              if (context.outbox.has(r.id)) continue;
              const row = outboxRow(r, r.version);
              if (isPosition(r.position)) row.position = r.position;
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
    if (ack.missing) {
      context.outbox.delete(ack.id);
      continue;
    }
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
    const placed = row && (row.position === undefined || row.position === ack.position);
    const drained = row && placed && (!hasContent(row) || JSON.stringify(content(record(row))) === JSON.stringify(content(record(ack))));
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
    if (current && server.version <= current.version) {
      // A move made elsewhere changes no version, so it is taken on its own, unless this
      // device moved the evaluator since and has not sent it yet (the later write, 5).
      const moving = context.outbox.get(server.id)?.position !== undefined;
      if (visible(current) && !server.deleted && !moving && isPosition(server.position) && server.position !== current.position) {
        const r = { ...current, position: server.position };
        context.evaluators.set(r.id, r);
        enqueue(() => context.store.put(r).catch(() => {}));
        enqueue.emit({ type: "evaluator.changed", evaluator: announce(context, r) });
      }
      continue;
    }
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
