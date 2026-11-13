import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { ulid } from "ulid";

// The fact component that owns the Eisenhower Matrices (3.1), replicated (5) the way
// `wheels` is: local-first, cached in the browser, numbering versions itself while signed
// out and syncing to the per-user server when signed in. The last write wins and a delete
// is a tombstone that always wins (5). The view where the user acted emits matrix.saved
// (4.3, fifth rule). Everything with a side effect (the store, the network, the asks)
// arrives through input, so this stays a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const isDay = (v) => typeof v === "string" && DAY.test(v);

const PLACES = ["do", "schedule", "delegate", "drop"];
const isPlace = (v) => PLACES.includes(v);

// --- Records --------------------------------------------------------------------------

const suggestedOf = (v) =>
  v && typeof v === "object" && isPlace(v.place) && typeof v.sure === "boolean" ? { place: v.place, sure: v.sure } : null;

// One fixed shape and key order per task, so two copies of the same content compare equal
// as text. A copy from storage or the network may hold anything: a task without an id or
// words is dropped, a place it cannot read counts as none, and only the first of two tasks
// with one id is kept.
const taskOf = (t) => {
  const suggested = suggestedOf(t.suggested);
  return { id: t.id, text: t.text, place: isPlace(t.place) ? t.place : null, done: t.done === true, ...(suggested ? { suggested } : {}) };
};
const tasksOf = (v) => {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(v) ? v : []) {
    if (!t || !isId(t.id) || typeof t.text !== "string" || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(taskOf(t));
  }
  return out;
};

// The user's own fields of a task (text, place, done; the order is the array's). A step
// carries and compares only these, because the suggestion is the fact's, not the user's.
const own = (tasks) => tasks.map(({ id, text, place, done }) => ({ id, text, place, done }));
const areOwnTasks = (v) =>
  Array.isArray(v) &&
  v.every((t) => t && isId(t.id) && typeof t.text === "string" && (t.place === null || isPlace(t.place)) && typeof t.done === "boolean");

// A matrix made before createdAt was kept still has one: the time its ULID was minted.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const mintedAt = (id) => new Date([...id.slice(0, 10)].reduce((ms, c) => ms * 32 + CROCKFORD.indexOf(c), 0)).toISOString();
const isTime = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

const toRecord = (r) => ({
  id: r.id,
  day: r.day,
  ...(isDay(r.from) ? { from: r.from } : {}),
  tasks: tasksOf(r.tasks),
  createdAt: isTime(r.createdAt) ? r.createdAt : mintedAt(r.id),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  ...(r.deleted === true ? { deleted: true } : {}),
  // The step that last wrote it in this browser (12, Undo); the server never has it.
  ...(typeof r.step === "string" ? { step: r.step } : {}),
});

// What a write carries, and what decides whether a change is a new version.
const content = (r) => ({ day: r.day, ...(r.from ? { from: r.from } : {}), tasks: r.tasks, createdAt: r.createdAt });
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));
const sameOwn = (a, b) => JSON.stringify(own(a.tasks)) === JSON.stringify(own(b.tasks)) && Boolean(a.deleted) === Boolean(b.deleted);

// A tombstone is kept for the sync (5) but never listed or announced as a change.
const visible = (r) => r && !r.deleted;

const announce = (context, r) => ({
  id: r.id,
  day: r.day,
  ...(r.from ? { from: r.from } : {}),
  tasks: r.tasks,
  createdAt: r.createdAt,
  version: r.version,
  pending: context.outbox.has(r.id),
});

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const LISTED = 20;

// With a day, that day's matrix; without, the newest days first, at most LISTED of them.
function replyList(context, day, reply) {
  const all = [...context.matrices.values()].filter((r) => visible(r) && (day === undefined || r.day === day));
  all.sort(day === undefined ? (a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : byId(b, a)) : byId);
  reply({ matrices: all.slice(0, LISTED).map((r) => announce(context, r)), total: all.length });
}

// The suggestion of the task held before, kept while its words stay the same: the view
// never sends one (matrix.saved), and Undo never takes one away.
function keepSuggested(tasks, before) {
  const held = new Map(before.map((t) => [t.id, t]));
  return tasks.map((t) => {
    const was = held.get(t.id);
    return was?.suggested && was.text === t.text ? { ...t, suggested: was.suggested } : t;
  });
}

// A matrix copied from an earlier day keeps the suggestions of the tasks it copied, found
// by id, or by the same words when the copy has ids of its own, so they are not asked again.
function copySuggested(tasks, source) {
  const left = (source?.tasks ?? []).filter((t) => t.suggested);
  return tasks.map((t) => {
    const i = left.findIndex((s) => s.id === t.id && s.text === t.text);
    const j = i >= 0 ? i : left.findIndex((s) => s.text === t.text);
    if (j < 0) return t;
    const [s] = left.splice(j, 1);
    return { ...t, suggested: s.suggested };
  });
}

// --- Changes --------------------------------------------------------------------------

// The one place a changed record is kept, stored and announced. A change of content is
// a new version: signed out it is minted here; signed in the record keeps the version
// it holds, is queued in the outbox (coalesced by id, keeping the first unsynced base)
// and a drain is asked for.
function commit(context, enqueue, next) {
  const current = context.matrices.get(next.id);
  const changed = !current || !same(current, next) || Boolean(next.deleted) !== Boolean(current.deleted);
  let r = next;
  if (changed && context.userId == null) r = { ...next, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...next, version: current.version };
  context.matrices.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (changed && context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null);
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  if (r.deleted) {
    if (visible(current)) enqueue.emit({ type: "matrix.deleted", id: r.id, day: r.day });
  } else {
    enqueue.emit({ type: "matrix.changed", matrix: announce(context, r) });
  }
  if (changed && context.userId != null) enqueue.raise({ type: "_drain" });
}

const outboxRow = (r, baseVersion) => ({ id: r.id, ...content(r), baseVersion, ...(r.deleted ? { deleted: true } : {}) });

// --- Steps (12, Undo) -------------------------------------------------------------------

// A matrix as a step names it: the user's own fields of its tasks, whether it is deleted,
// and `prior`, the step that wrote it before this one, so an Undo leaves it as that step
// left it and the step before can be undone next.
const entry = (r, prior = r.step) => ({
  kind: "matrix",
  id: r.id,
  tasks: own(r.tasks),
  deleted: Boolean(r.deleted),
  ...(prior ? { prior } : {}),
});
const todayFrom = (picture) => (isDay(picture?.today) ? picture.today : null);

// What a matrix undone back past every step this browser knows of is stamped with.
const before = (e, step) => e.prior ?? `^${step}`;

// Whether a save only took tasks away, leaving the rest as they were and in their order.
function droppedOnly(before, after) {
  if (after.length === 0 || after.length >= before.length) return false;
  const kept = own(before).filter((t) => after.some((a) => a.id === t.id));
  return JSON.stringify(kept) === JSON.stringify(own(after));
}

// Every save that changes a matrix's tasks is a step. One stretch of typing in one matrix
// is one step, from its first save until a save says `finished`; a save while that stretch
// last wrote it joins it. Adding one is the first save's step, whose Undo deletes it again;
// a delete, of the matrix or of some of its tasks, is a step of its own, which asks for the
// notice.
function recordStep(context, enqueue, was, next, event) {
  const open = context.stretch;
  const removing = Boolean(next.deleted);
  const dropping = !removing && Boolean(was) && droppedOnly(was.tasks, next.tasks);
  const joins = !removing && !dropping && open != null && open.id === next.id && was?.step === open.step;
  const step = joins ? open.step : context.mint();
  const first = joins ? open.before : was ? entry(was) : entry({ ...next, deleted: true }, null);
  commit(context, enqueue, { ...next, step });
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "matrices",
    label: dropping ? (next.tasks.length === was.tasks.length - 1 ? "delete task" : "delete tasks") : `${removing ? "delete" : first.deleted ? "add" : "edit"} Eisenhower Matrix`,
    undo: first,
    redo: entry({ ...next, step }, first.prior ?? null),
    ...(removing || dropping ? { notice: true } : {}),
  });
  const stretch = removing || dropping || event.finished === true ? null : { step, id: next.id, before: first };
  context.stretch = stretch;
  enqueue.assign({ stretch });
}

// An Undo or Redo of one of this fact's steps. It is applied only while the matrix is as
// the step left it, last written in this browser by that step; anything the user's own
// fields took since, here, in another tab or on another device, refuses it. A suggestion
// written since is not such a change (see adopt), and the restored tasks keep theirs while
// their words are the same. A deleted matrix comes back with a restore write (5). A matrix
// of a day that has closed is refused.
function applyStep(context, event, enqueue) {
  if (event.owner !== "matrices") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "matrices", outcome, ...(reason ? { reason } : {}) });
  context.stretch = null;
  enqueue.assign({ stretch: null });
  const p = event.payload ?? {};
  const undoing = event.type === "step.undone";
  const current = isId(p.id) ? context.matrices.get(p.id) : null;
  if (p.kind !== "matrix" || !current || !areOwnTasks(p.tasks)) return settle("refused", "changed");
  if (current.step !== (undoing ? event.id : before(p, event.id))) return settle("refused", "changed");
  // Matrices are written only while their journal day is (13, Journal).
  if (context.today != null && current.day !== context.today) return settle("refused", "closed");
  const { deleted: _, ...live } = current;
  commit(context, enqueue, {
    ...live,
    tasks: keepSuggested(tasksOf(p.tasks), current.tasks),
    ...(p.deleted ? { deleted: true } : {}),
    step: undoing ? before(p, event.id) : event.id,
  });
  settle("applied");
  suggest(context, enqueue);
}

// A new id adds a matrix to its day, unless it holds no task (that is not a matrix yet) or
// the day already holds one (one per day). A save to one already kept changes its tasks
// and keeps its day and `from`, except that leaving no task removes it: that is how the
// view says it is gone. Its tombstone keeps what it had, so it can still be restored. A
// deleted id stays deleted (5).
function applySave(context, event, enqueue) {
  if (!isId(event.id)) return;
  const was = context.matrices.get(event.id);
  if (was?.deleted) return;
  const tasks = own(tasksOf(event.tasks));
  if (!was) {
    if (!isDay(event.day) || tasks.length === 0) return;
    if ([...context.matrices.values()].some((r) => visible(r) && r.day === event.day)) return;
    const from = isDay(event.from) && event.from < event.day ? event.from : undefined;
    const source = from ? [...context.matrices.values()].find((r) => visible(r) && r.day === from) : null;
    const next = toRecord({
      id: event.id,
      day: event.day,
      from,
      tasks: copySuggested(tasks, source),
      createdAt: new Date(context.now()).toISOString(),
    });
    recordStep(context, enqueue, null, next, event);
    return suggest(context, enqueue);
  }
  if (tasks.length === 0) return recordStep(context, enqueue, was, { ...was, deleted: true }, event);
  const next = { ...was, tasks: keepSuggested(tasks, was.tasks) };
  if (same(was, next)) {
    // A fold with nothing new to save still ends the stretch of typing.
    if (event.finished === true && context.stretch?.id === event.id) {
      context.stretch = null;
      enqueue.assign({ stretch: null });
    }
    return;
  }
  recordStep(context, enqueue, was, next, event);
  suggest(context, enqueue);
}

// --- Suggestions --------------------------------------------------------------------------

// The built-in Eisenhower evaluator and its two questions, found by these fixed ids, the
// same in every account. They are repeated here, not imported, because components never
// import each other (11.2); `evaluators` keeps them fixed so this fact can find them.
const EISENHOWER = "0000000000000000000000EMTX";
const URGENT = "0000000000000000000000RGNT";
const IMPORTANT = "0000000000000000000000MPRT";

// Yes from an even chance, and sure from 75% on either side: the same split
// evaluator-list uses to tell Yes and No from Probably yes and Probably no.
const YES_FROM = 0.5;
const SURE_FROM = 0.75;

const filled = (s) => typeof s === "string" && s.trim() !== "";

// The evaluator as listed or announced; one being removed counts as not listed.
const eisenhowerOf = (r) => (r && r.id === EISENHOWER && r.removing !== true ? r : null);

// A question that is missing, switched off, empty, being removed or no longer yes / no is
// not asked and counts as No: the user may change the built-in evaluator freely.
function questionOf(evaluator, id) {
  const q = (Array.isArray(evaluator?.questions) ? evaluator.questions : []).find((x) => x?.id === id);
  if (!q || q.on === false || q.removing === true || !filled(q.text) || (q.kind !== undefined && q.kind !== "yesno")) return null;
  return { id, instructions: q.text, ...(filled(q.yes) ? { yes: q.yes } : {}), ...(filled(q.no) ? { no: q.no } : {}) };
}

// What llm: decide is asked about one task, or null when nothing can be asked: the
// evaluator is not listed (the feature is hidden), switched off, or asks neither question.
function decidePayload(evaluator, text) {
  if (!evaluator || evaluator.on === false) return null;
  const questions = [questionOf(evaluator, URGENT), questionOf(evaluator, IMPORTANT)].filter(Boolean);
  return questions.length ? { state: { task: text }, questions } : null;
}

// The answers mapped to a place. A question not asked is a sure No; one asked and left
// unanswered makes no suggestion.
export function placeOf(questions, answers) {
  const got = new Map((Array.isArray(answers) ? answers : []).map((a) => [a?.id, a]));
  const side = {};
  let sure = true;
  for (const id of [URGENT, IMPORTANT]) {
    if (!questions.some((q) => q.id === id)) {
      side[id] = false;
      continue;
    }
    const p = got.get(id)?.p;
    if (typeof p !== "number") return null;
    side[id] = p >= YES_FROM;
    if (Math.max(p, 1 - p) < SURE_FROM) sure = false;
  }
  const place = side[URGENT] ? (side[IMPORTANT] ? "do" : "delegate") : side[IMPORTANT] ? "schedule" : "drop";
  return { place, sure };
}

// A task asked about is known by its matrix, its id and its words, so new words are a
// new question.
const keyOf = (matrix, task) => `${matrix}:${task.id}:${task.text}`;

// Asks about every task of today's matrix that has no place and no suggestion, once each:
// a task being asked, or whose ask failed since the page loaded, is not asked again until
// the next load. Earlier days are read only and are not asked about.
function suggest(context, enqueue) {
  if (typeof context.ask !== "function") return;
  for (const r of context.matrices.values()) {
    if (!visible(r) || (context.today != null && r.day !== context.today)) continue;
    for (const task of r.tasks) {
      if (task.place !== null || task.suggested || !filled(task.text)) continue;
      const key = keyOf(r.id, task);
      if (context.asked.has(key)) continue;
      const payload = decidePayload(context.evaluator, task.text);
      if (!payload) return;
      context.asked.set(key, "asking");
      const matrix = r.id;
      const { id, text } = task;
      enqueue(({ self }) =>
        Promise.resolve()
          .then(() => context.ask("llm", "decide", payload))
          .catch(() => ({ error: "unavailable" }))
          .then((reply) => self.send({ type: "_decided", matrix, task: id, text, key, questions: payload.questions, reply })),
      );
    }
  }
}

// An answer is written only onto the task it was asked about, while it still has those
// words, no place and no suggestion. Writing it is not a step: the matrix keeps the step
// that last wrote it, so Undo still applies.
function decided(context, event, enqueue) {
  const found = event.reply && !event.reply.error ? placeOf(event.questions, event.reply.answers) : null;
  if (!found) {
    context.asked.set(event.key, "failed");
    return;
  }
  context.asked.delete(event.key);
  const r = context.matrices.get(event.matrix);
  if (!visible(r)) return;
  const task = r.tasks.find((t) => t.id === event.task);
  if (!task || task.text !== event.text || task.place !== null || task.suggested) return;
  commit(context, enqueue, { ...r, tasks: r.tasks.map((t) => (t === task ? { ...t, suggested: found } : t)) });
}

// --- Loading ------------------------------------------------------------------------------

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.payload.day, message.reply);
  else if (message.type === "matrix.saved") applySave(context, message, enqueue);
  else if (message.type === "step.undone" || message.type === "step.redone") applyStep(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(
  ["list?", "matrix.saved", "step.undone", "step.redone"].map((t) => [t, { actions: queue }]),
);

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

const ready = (context, enqueue) => {
  for (const message of context.queued) flush(context, message, enqueue);
  enqueue.assign({ queued: [] });
  if (context.userId) enqueue.raise({ type: "_sync", pull: true });
  suggest(context, enqueue);
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
// every matrix it holds first: when it already holds one that is not deleted, this copy is
// emptied, outbox included, and the pull from 0 brings the account's. When it holds none,
// every matrix is queued for it on the version it holds, which the server adopts on first
// insert, and the cursor goes back to 0. A tombstone is not sent: the account never had
// the record, so there is nothing to delete. The mark is cleared only once every row is
// stored in the outbox, so a reload midway sends the copy again (coalesced by id) rather
// than losing it; when the account cannot be asked (offline), the mark stays and the next
// load decides. A mark left by a change of account that was called off names the account
// still signed in, and is only cleared.
async function keepFor(store, from, userId, api) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!Array.isArray(held?.matrices)) return;
    if (held.matrices.some((r) => isId(r?.id) && !r.deleted)) {
      await store.empty();
      await store.metaPut("userId", userId);
    } else {
      const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      for (const r of records.filter((r) => isId(r?.id) && isDay(r?.day)).map(toRecord)) {
        if (r.deleted || queued.has(r.id)) continue;
        await store.outboxPut(outboxRow(r, r.version));
      }
    }
    await store.metaPut("cursor", 0);
  }
  await store.metaPut("adopt", null);
}

const journalChanged = assign({ today: ({ context, event }) => todayFrom(event) ?? context.today });
// The evaluator heard of is newer than the one the load asked for, which the bus holds
// news for until it is answered (4.2).
const evaluatorChanged = assign({
  evaluator: ({ context, event }) => (event.evaluator?.id === EISENHOWER ? eisenhowerOf(event.evaluator) : context.evaluator),
  evaluatorHeard: ({ context, event }) => context.evaluatorHeard || event.evaluator?.id === EISENHOWER,
});
const evaluatorDeleted = assign({
  evaluator: ({ context, event }) => (event.id === EISENHOWER ? null : context.evaluator),
  evaluatorHeard: ({ context, event }) => context.evaluatorHeard || event.id === EISENHOWER,
});

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
      const [matrices, outbox, cursor, userId, journal, evaluators] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
        // Which day is today, for an Undo (12) and for what is asked about: a page without
        // the journal answers nothing.
        ask ? ask("journal", "read", {}).catch(() => null) : null,
        // The Eisenhower evaluator, listed only while the feature is shown (3.1).
        ask ? ask("evaluators", "list", {}).catch(() => null) : null,
      ]);
      const list = Array.isArray(evaluators?.evaluators) ? evaluators.evaluators : [];
      return {
        matrices,
        outbox,
        cursor: cursor ?? 0,
        userId: userId ?? null,
        today: todayFrom(journal),
        evaluator: eisenhowerOf(list.find((r) => r?.id === EISENHOWER)),
      };
    }),
    // Missing (a Node test) is treated as signed out, so the fact still works headless.
    session: fromPromise(({ input }) => (input.ask ? input.ask("session", "read", {}) : Promise.resolve({ userId: null }))),
    // Empties the local copy in one transaction, outbox and cache together (12).
    // With keep (12) the copy stays and is marked, under the account it came from, to be
    // added to the account the browser joins after the reload.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // It returns a summary the machine applies; it never emits (4.3). A network error
    // stops it with what it had; 401 reports the session is gone.
    sync: fromPromise(async ({ input }) => {
      const { api, store, rows, cursor, pull } = input;
      const acks = [];
      for (const row of [...rows].sort(byId)) {
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
      return { acks, pulled: pulled.matrices, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "matrices",
  meta: {
    description:
      "Owns the Eisenhower Matrices kept with the journal's days, one per day. A matrix is a " +
      "list of tasks, each with its words, a tick, and the place the user put it: Do (urgent " +
      "and important), Schedule (important only), Delegate (urgent only) or Drop (neither), or " +
      "no place yet. The order of the tasks is their order inside each place. Each matrix names " +
      "its journal day and keeps it for good, and one copied to a new day names the day it came " +
      "from; a new matrix on a day that already has one is not kept. `matrices: list` answers one " +
      "day's matrix, or the 20 newest days' when no day is given, with how many there are in all. " +
      "A task of today's matrix that has no place and no suggestion is asked about once: the fact " +
      "finds the built-in Eisenhower evaluator by its fixed id and asks its two questions, Urgent? " +
      "and Important?, found by their fixed ids, in one `llm: decide` request with the task's words " +
      "as the state. An answer is Yes from 50%; both Yes is Do, Important alone Schedule, Urgent " +
      "alone Delegate, neither Drop; the suggestion is sure when every answer is 75% or more on its " +
      "side, and Not sure otherwise. A question the user switched off, emptied or turned into a " +
      "pick question counts as a sure No; when neither can be asked, or the evaluator is switched " +
      "off or not listed (the feature hidden), nothing is asked and no suggestion is made. A task " +
      "without a place shows at its suggestion, and with neither in To sort. A place the user chose " +
      "is final, and a placed task is never asked about. Changing a task's words drops its " +
      "suggestion, so an unplaced task is asked about again; a task copied to a new day keeps its " +
      "suggestion and is not asked again. An error, such as no key or being offline, leaves the " +
      "task without a suggestion until the next load; earlier days are not asked about. Writing a " +
      "suggestion is not a step and Undo never removes one. A matrix with no task is not kept, and " +
      "a save that leaves none deletes it at once with the short notice; a save that only takes tasks away is a step of its own with the short notice too. Every change the user " +
      "makes is a step Undo and Redo reverse (section 12): one stretch of changes to one matrix, " +
      "from its first save until a save says finished, and a delete; Undo of a new matrix's first " +
      "stretch deletes it, and a deleted one comes back with a restore write. A step compares only " +
      "the tasks' words, places, ticks and order: it is refused when those were written since by " +
      "anything else, and when its journal day has closed, which it learns from the journal. It " +
      "works signed out, numbering versions itself, and syncs to the account when signed in " +
      "(section 5); signing in uploads every matrix with its history. The last write wins, so two " +
      "devices never conflict, and a deleted matrix is kept as a tombstone, which always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["matrix.changed", "matrix.deleted", "step.recorded", "step.settled"],
    owns: "the Eisenhower Matrices kept with each journal day",
    steps: { "matrix.saved": "step" },
    asks: ["session: read", "journal: read", "evaluators: list", "llm: decide"],
  },
  context: ({ input }) => ({
    matrices: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    mint: input.mint ?? ulid,
    now: input.now ?? Date.now,
    // Today's journal day, from the journal (13); null until it says, or on a page without it.
    today: null,
    // The Eisenhower evaluator as last listed or announced; null while it is not listed.
    evaluator: null,
    evaluatorHeard: false,
    // Each task asked about since the page loaded, by keyOf: "asking" while the ask is
    // open, "failed" when it brought no suggestion. Kept in memory only.
    asked: new Map(),
    // The stretch of typing still open (12, Undo): { step, id, before }, the step's id, the
    // matrix changed and how it was before the stretch; null when none is.
    stretch: null,
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
  // While loading, only whether the browser is leaving, today and the evaluator are kept
  // (12); the rest of the news is read from session once the store is loaded.
  on: {
    "session.changed": {
      actions: assign({ leaving: ({ event }) => event.leaving === true, keep: ({ event }) => event.leaving === true && event.keep === true }),
    },
    "journal.changed": { actions: journalChanged },
    "evaluator.changed": { actions: evaluatorChanged },
    "evaluator.deleted": { actions: evaluatorDeleted },
    _decided: { actions: enqueueActions(({ context, event, enqueue }) => decided(context, event, enqueue)) },
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
            matrices: ({ event }) =>
              new Map(event.output.matrices.filter((r) => isId(r?.id) && isDay(r?.day)).map((r) => [r.id, toRecord(r)])),
            outbox: ({ event }) => new Map(event.output.outbox.map((row) => [row.id, row])),
            cursor: ({ event }) => event.output.cursor,
            userId: ({ event }) => event.output.userId,
            today: ({ context, event }) => context.today ?? event.output.today,
            evaluator: ({ context, event }) => (context.evaluatorHeard ? context.evaluator : event.output.evaluator),
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "list?") message.reply({ matrices: [], total: 0 });
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
        "list?": { actions: ({ context, event }) => replyList(context, event.payload.day, event.reply) },
        "matrix.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "journal.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            context.today = todayFrom(event) ?? context.today;
            enqueue.assign({ today: context.today });
            suggest(context, enqueue);
          }),
        },
        "evaluator.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            if (event.evaluator?.id !== EISENHOWER) return;
            context.evaluator = eisenhowerOf(event.evaluator);
            enqueue.assign({ evaluator: context.evaluator, evaluatorHeard: true });
            suggest(context, enqueue);
          }),
        },
        "evaluator.deleted": { actions: evaluatorDeleted },
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
            for (const r of context.matrices.values()) {
              if (context.outbox.has(r.id)) continue;
              const row = outboxRow(r, r.version);
              context.outbox.set(r.id, row);
              enqueue(() => context.store.outboxPut(row).catch(() => {}));
            }
            enqueue.raise({ type: "_sync", pull: true });
            // An ask that failed signed out may succeed now.
            for (const [key, state] of context.asked) if (state === "failed") context.asked.delete(key);
            context.userId = userId;
            suggest(context, enqueue);
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
        "list?": { actions: ({ event }) => event.reply({ matrices: [], total: 0 }) },
      },
    },
  },
});

// Adopt one record the server holds: its content and version. A record whose user fields
// are those held here keeps the step that wrote them, so a suggestion written elsewhere
// never refuses an Undo. Announced as a change or, for a tombstone of a matrix this tab
// was showing, as gone.
function adopt(context, server, enqueue) {
  const held = context.matrices.get(server.id);
  const r = toRecord(server);
  const kept = held?.step && sameOwn(held, r) ? { ...r, step: held.step } : r;
  context.matrices.set(kept.id, kept);
  enqueue(() => context.store.put(kept).catch(() => {}));
  if (kept.deleted) {
    if (visible(held)) enqueue.emit({ type: "matrix.deleted", id: kept.id, day: kept.day });
  } else {
    enqueue.emit({ type: "matrix.changed", matrix: announce(context, kept) });
  }
}

// Apply a sync's summary: adopt acknowledged and pulled records, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    if (!isId(ack?.id)) continue;
    const row = context.outbox.get(ack.id);
    const held = context.matrices.get(ack.id);
    // The server holds a tombstone (a delete always wins, 5): the matrix is gone here too.
    if (ack.deleted) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
      // This browser's own delete keeps the step that made it, so it can still be undone.
      if (held?.deleted && same(held, toRecord(ack))) {
        const r = { ...held, version: ack.version };
        context.matrices.set(r.id, r);
        enqueue(() => context.store.put(r).catch(() => {}));
      } else adopt(context, ack, enqueue);
      continue;
    }
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    const drained = row && JSON.stringify(content(toRecord({ ...ack, ...row }))) === JSON.stringify(content(toRecord(ack)));
    if (drained) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
    } else if (row) {
      const advanced = { ...row, baseVersion: ack.version };
      context.outbox.set(ack.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    // Keep the latest local content (a mid-sync edit), take the server's version.
    const r = held ? { ...held, version: ack.version } : toRecord(ack);
    context.matrices.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    if (visible(r)) enqueue.emit({ type: "matrix.changed", matrix: announce(context, r) });
  }

  for (const server of pulled ?? []) {
    if (!isId(server?.id) || !isDay(server?.day)) continue;
    const current = context.matrices.get(server.id);
    if (current && server.version <= current.version) continue;
    // A local change not yet sent is the later write, so it wins (last write wins) and is
    // sent at the next drain; a delete there always wins (5). Otherwise a live copy of a
    // local tombstone at a higher version is a restore write made elsewhere (5).
    if (context.outbox.has(server.id) && !server.deleted) continue;
    if (server.deleted && context.outbox.has(server.id)) {
      context.outbox.delete(server.id);
      enqueue(() => context.store.outboxDelete(server.id).catch(() => {}));
    }
    if (server.deleted && !current) {
      const r = toRecord(server);
      context.matrices.set(r.id, r);
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
  suggest(context, enqueue);
}
