import { setup, assign, fromPromise, enqueueActions, and } from "xstate";
import { ulid } from "ulid";

// The fact component that owns the journal prompts sheets (3.1), replicated (5) the way
// `choice-points` is: local-first, cached in the browser, numbering versions itself while
// signed out and syncing to the per-user server when signed in. The last write wins and a
// delete is a tombstone that always wins (5). The view where the user acted emits
// prompt-sheet.saved (4.3, fifth rule); the check of each answer is asked the way
// `matrices` asks its suggestion. Everything with a side effect (the store, the network,
// the asks) arrives through input, so this stays a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const isDay = (v) => typeof v === "string" && DAY.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const filled = (s) => typeof s === "string" && s.trim() !== "";

// The id is a ULID the view minted when the user added the sheet, so its first ten
// characters are that moment; reading it from there needs no clock here and no column on
// the server.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const createdAt = (id) => new Date([...id.slice(0, 10)].reduce((ms, c) => ms * 32 + CROCKFORD.indexOf(c), 0)).toISOString();

// --- Records --------------------------------------------------------------------------

const fitsOf = (v) => (v === true || v === false ? v : null);

// One answer in one fixed shape and key order, so two copies of the same content compare
// equal as text; what cannot be read is an empty answer to an empty prompt.
const answerOf = (a) => ({ prompt: str(a?.prompt), answer: str(a?.answer), fits: fitsOf(a?.fits) });
const answersOf = (v) => (Array.isArray(v) ? v.map(answerOf) : []);

// The user's own fields of an answer. A step carries and compares only these, because
// fits is the fact's, not the user's.
const own = (answers) => answers.map(({ prompt, answer }) => ({ prompt, answer }));
const areOwn = (v) => Array.isArray(v) && v.every((a) => a && typeof a.prompt === "string" && typeof a.answer === "string");

const toRecord = (r) => ({
  id: r.id,
  day: r.day,
  setId: isId(r.setId) ? r.setId : "",
  setName: str(r.setName),
  basedOn: str(r.basedOn),
  answers: answersOf(r.answers),
  version: Number.isInteger(r.version) && r.version >= 1 ? r.version : 1,
  ...(r.deleted === true ? { deleted: true } : {}),
  // The step that last wrote it in this browser (12, Undo); the server never has it.
  ...(typeof r.step === "string" ? { step: r.step } : {}),
});

// A record whose set cannot be read is not kept, so every announced sheet names one.
const readable = (r) => isId(r?.id) && isDay(r?.day) && isId(r?.setId);

// What a write carries, and what decides whether a change is a new version.
const content = (r) => ({ day: r.day, setId: r.setId, setName: r.setName, basedOn: r.basedOn, answers: r.answers });
const same = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));
const ownOf = (r) => ({ setId: r.setId, setName: r.setName, basedOn: r.basedOn, answers: own(r.answers), deleted: Boolean(r.deleted) });
const sameOwn = (a, b) => JSON.stringify(ownOf(a)) === JSON.stringify(ownOf(b));

// A tombstone is kept for the sync (5) but never listed or announced as a change.
const visible = (r) => r && !r.deleted;

const announce = (context, r) => ({
  id: r.id,
  day: r.day,
  setId: r.setId,
  setName: r.setName,
  basedOn: r.basedOn,
  answers: r.answers,
  createdAt: createdAt(r.id),
  version: r.version,
  pending: context.outbox.has(r.id),
});

const LISTED = 20;
// Newest day first, and on one day the sheet added last first.
const newest = (a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function replyList(context, payload, reply) {
  const { day, setId } = payload ?? {};
  const all = [...context.sheets.values()]
    .filter((r) => visible(r) && (day === undefined || r.day === day) && (setId === undefined || r.setId === setId))
    .sort(newest);
  reply({ sheets: all.slice(0, LISTED).map((r) => announce(context, r)), total: all.length });
}

function replyRead(context, payload, reply) {
  const r = context.sheets.get(payload?.id);
  reply({ sheet: visible(r) ? announce(context, r) : null });
}

// The judgement of the answer held before, kept while its prompt and words stay the same
// (the view never sends one, prompt-sheet.saved, and Undo never takes one away); else one
// already found for those words since the page loaded, so they are not asked again.
function keepFits(context, answers, before) {
  return answers.map((a, i) => {
    const was = before[i];
    if (was && was.fits !== null && was.prompt === a.prompt && was.answer === a.answer) return { ...a, fits: was.fits };
    const found = context.found.get(keyOf(a));
    return found === undefined ? { ...a, fits: null } : { ...a, fits: found };
  });
}

// --- Changes --------------------------------------------------------------------------

// The one place a changed record is kept, stored and announced. A change of content is
// a new version: signed out it is minted here; signed in the record keeps the version
// it holds, is queued in the outbox (coalesced by id, keeping the first unsynced base)
// and a drain is asked for.
function commit(context, enqueue, next) {
  const current = context.sheets.get(next.id);
  const changed = !current || !same(current, next) || Boolean(next.deleted) !== Boolean(current.deleted);
  let r = next;
  if (changed && context.userId == null) r = { ...next, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...next, version: current.version };
  context.sheets.set(r.id, r);
  enqueue(() => context.store.put(r).catch(() => {}));
  if (changed && context.userId != null) {
    const existing = context.outbox.get(r.id);
    const row = outboxRow(r, existing ? existing.baseVersion : current ? current.version : null);
    context.outbox.set(r.id, row);
    enqueue(() => context.store.outboxPut(row).catch(() => {}));
  }
  if (r.deleted) {
    if (visible(current)) enqueue.emit({ type: "prompt-sheet.deleted", id: r.id, day: r.day });
  } else {
    enqueue.emit({ type: "prompt-sheet.changed", sheet: announce(context, r) });
  }
  if (changed && context.userId != null) enqueue.raise({ type: "_drain" });
}

const outboxRow = (r, baseVersion) => ({ id: r.id, ...content(r), baseVersion, ...(r.deleted ? { deleted: true } : {}) });

// --- Steps (12, Undo) -------------------------------------------------------------------

// A sheet as a step names it: the user's own fields, whether it is deleted, and `prior`,
// the step that wrote it before this one, so an Undo leaves it as that step left it and
// the step before can be undone next.
const entry = (r, prior = r.step) => ({
  kind: "prompt-sheet",
  id: r.id,
  setId: r.setId,
  setName: r.setName,
  basedOn: r.basedOn,
  answers: own(r.answers),
  deleted: Boolean(r.deleted),
  ...(prior ? { prior } : {}),
});
const todayFrom = (picture) => (isDay(picture?.today) ? picture.today : null);

// What a sheet undone back past every step this browser knows of is stamped with.
const before = (e, step) => e.prior ?? `^${step}`;

// What a step is about, as people read it after "Undo:": the set's name.
const NAME_MAX = 40;
function nameOf(r) {
  const name = r.setName.trim();
  if (!name) return "journal prompts";
  return `journal prompts ${name.length > NAME_MAX ? `${name.slice(0, NAME_MAX).trimEnd()}…` : name}`;
}

// Every save that changes a sheet is a step. One stretch of typing in one sheet is one
// step, from its first save until a save says `finished`; a save while that stretch last
// wrote it joins it. Adding one is the first save's step, whose Undo deletes it again; a
// removal is a step of its own, which asks for the notice.
function recordStep(context, enqueue, was, next, event) {
  const open = context.stretch;
  const removing = Boolean(next.deleted);
  const joins = !removing && open != null && open.id === next.id && was?.step === open.step;
  const step = joins ? open.step : context.mint();
  const first = joins ? open.before : was ? entry(was) : entry({ ...next, deleted: true }, null);
  commit(context, enqueue, { ...next, step });
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "prompt-sheets",
    label: `${removing ? "delete" : first.deleted ? "add" : "edit"} ${nameOf(removing ? was : next)}`,
    undo: first,
    redo: entry({ ...next, step }, first.prior ?? null),
    ...(removing ? { notice: true } : {}),
  });
  const stretch = removing || event.finished === true ? null : { step, id: next.id, before: first };
  context.stretch = stretch;
  enqueue.assign({ stretch });
}

// An Undo or Redo of one of this fact's steps. It is applied only while the sheet is as
// the step left it, last written in this browser by that step; anything the user's own
// fields took since, here, in another tab or on another device, refuses it. A judgement
// written since is not such a change (see adopt), and the restored answers keep theirs
// while their words are the same. A deleted sheet comes back with a restore write (5). A
// sheet of a day that has closed is refused.
function applyStep(context, event, enqueue) {
  if (event.owner !== "prompt-sheets") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "prompt-sheets", outcome, ...(reason ? { reason } : {}) });
  context.stretch = null;
  enqueue.assign({ stretch: null });
  const p = event.payload ?? {};
  const undoing = event.type === "step.undone";
  const current = isId(p.id) ? context.sheets.get(p.id) : null;
  if (p.kind !== "prompt-sheet" || !current || !isId(p.setId) || !areOwn(p.answers)) return settle("refused", "changed");
  if (current.step !== (undoing ? event.id : before(p, event.id))) return settle("refused", "changed");
  // Sheets are written only while their journal day is (13, Journal).
  if (context.today != null && current.day !== context.today) return settle("refused", "closed");
  const { deleted: _, ...live } = current;
  commit(context, enqueue, {
    ...live,
    setId: p.setId,
    setName: str(p.setName),
    basedOn: str(p.basedOn),
    answers: keepFits(context, answersOf(p.answers), current.answers),
    ...(p.deleted ? { deleted: true } : {}),
    step: undoing ? before(p, event.id) : event.id,
  });
  settle("applied");
  check(context, enqueue);
}

// A sheet with no answer text, only spaces and blank lines, is not kept: the view may save
// a sheet the user opened and left blank.
const blank = (answers) => answers.every((a) => !filled(a.answer));

// A new id adds a sheet to its day, unless it holds no answer text. A save to one already
// kept changes its set and its answers and keeps its day, except that no answer text, or
// deleted, removes it; its tombstone keeps the answers it had, so it could be restored. A
// deleted id stays deleted (5).
function applySave(context, event, enqueue) {
  if (!isId(event.id)) return;
  const was = context.sheets.get(event.id);
  if (was?.deleted) return;
  const answers = answersOf(event.answers).map((a) => ({ ...a, fits: null }));
  if (!was) {
    if (event.deleted === true || !isDay(event.day) || !isId(event.setId) || blank(answers)) return;
    const next = toRecord({ ...event, answers: keepFits(context, answers, []) });
    recordStep(context, enqueue, null, next, event);
    return check(context, enqueue);
  }
  if (event.deleted === true || blank(answers)) {
    recordStep(context, enqueue, was, { ...was, deleted: true }, event);
    return check(context, enqueue);
  }
  const next = {
    ...was,
    setId: isId(event.setId) ? event.setId : was.setId,
    setName: str(event.setName),
    basedOn: str(event.basedOn),
    answers: keepFits(context, answers, was.answers),
  };
  if (same(was, next)) {
    // A finish with nothing new to save still ends the stretch of typing.
    if (event.finished === true && context.stretch?.id === event.id) {
      context.stretch = null;
      enqueue.assign({ stretch: null });
    }
    return check(context, enqueue);
  }
  recordStep(context, enqueue, was, next, event);
  check(context, enqueue);
}

// --- The check --------------------------------------------------------------------------

// The built-in Answers the prompt evaluator and its one question, found by these fixed
// ids, the same in every account. They are repeated here, not imported, because
// components never import each other (11.2); `evaluators` keeps them fixed.
const PROMPT = "0000000000000000000000PRMT";
const ANSWERS = "0000000000000000000000NSWR";

// Sure from 75% on either side, the split evaluator-list uses for Yes and No; between
// them the answer stays not judged, so a mark is shown only when the check is sure.
const SURE_FROM = 0.75;

// Jev answers one decision at a time (llm); an ask told busy waits and asks again.
const BUSY_TRIES = 5;
const BUSY_PAUSE_MS = 1500;

// The evaluator as listed or announced; one being removed counts as not listed.
const promptOf = (r) => (r && r.id === PROMPT && r.removing !== true ? r : null);

// What llm: decide is asked about one answer, or null when nothing can be asked: the
// evaluator is not listed (the feature is hidden), switched off, or its question is
// missing, switched off, emptied or no longer yes / no.
function decidePayload(evaluator, a) {
  if (!evaluator || evaluator.on === false) return null;
  const q = (Array.isArray(evaluator.questions) ? evaluator.questions : []).find((x) => x?.id === ANSWERS);
  if (!q || q.on === false || q.removing === true || !filled(q.text) || (q.kind !== undefined && q.kind !== "yesno")) return null;
  return {
    state: { prompt: a.prompt, answer: a.answer },
    questions: [{ id: ANSWERS, instructions: q.text, ...(filled(q.yes) ? { yes: q.yes } : {}), ...(filled(q.no) ? { no: q.no } : {}) }],
  };
}

// The answer mapped to fits: true or false when sure, else null.
export function fitsFrom(answers) {
  const p = (Array.isArray(answers) ? answers : []).find((x) => x?.id === ANSWERS)?.p;
  if (typeof p !== "number") return null;
  return p >= SURE_FROM ? true : p <= 1 - SURE_FROM ? false : null;
}

// An answer is asked about by its prompt and words, so the same words to the same prompt
// are asked once, whichever sheet holds them.
const keyOf = (a) => `${a.prompt}\n${a.answer}`;

// Asks about the first answer of today's sheets that has words and is not judged, one at
// a time. The sheet the user is typing in waits until that stretch ends, so an answer is
// asked about only once it is finished. A key asked since the page loaded is not asked
// again until the next load, whatever came of it. Earlier days are read only and are not
// asked about, nor is anything while today is not known.
function check(context, enqueue) {
  if (typeof context.ask !== "function" || context.checking != null || context.today == null) return;
  for (const r of [...context.sheets.values()].sort(newest)) {
    if (!visible(r) || r.day !== context.today || context.stretch?.id === r.id) continue;
    for (const a of r.answers) {
      if (a.fits !== null || !filled(a.answer)) continue;
      const key = keyOf(a);
      if (context.asked.has(key)) continue;
      const payload = decidePayload(context.evaluator, a);
      if (!payload) return;
      context.asked.add(key);
      context.checking = key;
      enqueue.assign({ checking: key });
      const { prompt, answer } = a;
      const { ask, wait } = context;
      enqueue(({ self }) =>
        (async () => {
          for (let tries = 1; ; tries += 1) {
            const reply = await Promise.resolve()
              .then(() => ask("llm", "decide", payload))
              .catch(() => ({ error: "unavailable" }));
            if (reply?.error !== "busy" || tries >= BUSY_TRIES) return reply;
            await wait(BUSY_PAUSE_MS);
          }
        })().then((reply) => self.send({ type: "_decided", prompt, answer, reply })),
      );
      return;
    }
  }
}

// A judgement is written onto every answer of today's sheets with that prompt and those
// words that is not judged yet. Writing it is not a step: the sheet keeps the step that
// last wrote it, so Undo still applies. A failure, or an answer that is not sure, writes
// nothing.
function decided(context, event, enqueue) {
  context.checking = null;
  enqueue.assign({ checking: null });
  const fits = event.reply && !event.reply.error ? fitsFrom(event.reply.answers) : null;
  if (fits !== null) {
    const key = keyOf(event);
    context.found.set(key, fits);
    for (const r of [...context.sheets.values()]) {
      if (!visible(r) || r.day !== context.today) continue;
      if (!r.answers.some((a) => a.fits === null && keyOf(a) === key)) continue;
      commit(context, enqueue, { ...r, answers: r.answers.map((a) => (a.fits === null && keyOf(a) === key ? { ...a, fits } : a)) });
    }
  }
  check(context, enqueue);
}

// --- Loading ------------------------------------------------------------------------------

// A query or gesture that arrived before the store loaded, replayed in order.
function flush(context, message, enqueue) {
  if (message.type === "list?") replyList(context, message.payload, message.reply);
  else if (message.type === "read?") replyRead(context, message.payload, message.reply);
  else if (message.type === "prompt-sheet.saved") applySave(context, message, enqueue);
  else if (message.type === "step.undone" || message.type === "step.redone") applyStep(context, message, enqueue);
}

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(
  ["list?", "read?", "prompt-sheet.saved", "step.undone", "step.redone"].map((t) => [t, { actions: queue }]),
);

// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

const ready = (context, enqueue) => {
  for (const message of context.queued) flush(context, message, enqueue);
  enqueue.assign({ queued: [] });
  if (context.userId) enqueue.raise({ type: "_sync", pull: true });
  check(context, enqueue);
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
// every sheet it holds first: when it already holds one that is not deleted, this copy is
// emptied, outbox included, and the pull from 0 brings the account's. When it holds none,
// every sheet is queued for it on the version it holds, which the server adopts on first
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
    if (!Array.isArray(held?.sheets)) return;
    if (held.sheets.some((r) => isId(r?.id) && !r.deleted)) {
      await store.empty();
      await store.metaPut("userId", userId);
    } else {
      const [records, outbox] = await Promise.all([store.all(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      for (const r of records.filter(readable).map(toRecord)) {
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
  evaluator: ({ context, event }) => (event.evaluator?.id === PROMPT ? promptOf(event.evaluator) : context.evaluator),
  evaluatorHeard: ({ context, event }) => context.evaluatorHeard || event.evaluator?.id === PROMPT,
});
const evaluatorDeleted = assign({
  evaluator: ({ context, event }) => (event.id === PROMPT ? null : context.evaluator),
  evaluatorHeard: ({ context, event }) => context.evaluatorHeard || event.id === PROMPT,
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
      const [sheets, outbox, cursor, userId, journal, evaluators] = await Promise.all([
        store.all(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
        // Which day is today, for an Undo (12) and for what is checked: a page without the
        // journal answers nothing.
        ask ? ask("journal", "read", {}).catch(() => null) : null,
        // The Answers the prompt evaluator, listed only while the feature is shown (3.1).
        ask ? ask("evaluators", "list", {}).catch(() => null) : null,
      ]);
      const list = Array.isArray(evaluators?.evaluators) ? evaluators.evaluators : [];
      return {
        sheets,
        outbox,
        cursor: cursor ?? 0,
        userId: userId ?? null,
        today: todayFrom(journal),
        evaluator: promptOf(list.find((r) => r?.id === PROMPT)),
      };
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
      return { acks, pulled: pulled.sheets, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "prompt-sheets",
  meta: {
    description:
      "Owns the journal prompts sheets kept with the journal's days, any number per day. A sheet " +
      "names the prompt set it was started from and keeps that set's name and the book it is " +
      "based on, and holds one answer per prompt with the prompt's text stored beside it, so an " +
      "earlier day still reads as it was answered after the set changes or is deleted. Each sheet " +
      "names its journal day by date and keeps that day for good. A sheet with no answer text " +
      "(only spaces and blank lines count as none) is not kept, and a save that empties every " +
      "answer of a kept one, or says deleted, deletes it at once; its tombstone keeps the answers " +
      "it had. Once the user finishes a stretch of typing in a sheet of today, the fact checks " +
      "each of its answers with words that is not judged yet, one at a time: it finds the " +
      "built-in Answers the prompt evaluator by its fixed id and asks its one question, found by " +
      "its fixed id, through `llm: decide`, with the prompt and the answer as the state. The " +
      "answer is stored as fits: true from 75% yes, false from 75% no, and none in between. The " +
      "same words to the same prompt are asked about once a page load, whichever sheet holds " +
      "them; when Jev is busy the fact waits 1.5 seconds and asks again, up to five times. An " +
      "error, such as being offline, having no key, or Ollama not running or without its model, " +
      "leaves fits none without a word, and the answer is asked about again at the next load. " +
      "Nothing is asked while the evaluator is not listed (Journal prompts hidden), switched off, " +
      "or its question is switched off, emptied or no longer yes / no, nor about an earlier day " +
      "or while today is not known. Changing an answer's words drops its judgement. Writing fits " +
      "is not a step, Undo never removes one, and it rides the sheet's own write: the last write " +
      "wins, so a check never conflicts with an edit, and a judgement lost to a later write from " +
      "another device is asked again there. `prompt-sheets: list` answers one day's sheets, one " +
      "set's, or both, or the 20 newest when neither is given, newest day first and on one day " +
      "the sheet added last first, at most 20, with how many match in all; `prompt-sheets: read` " +
      "answers one sheet by its id, or none. The chat may use them as lookups, Reading journal " +
      "prompts and Reading a journal prompts sheet. Every change the user makes is a step Undo " +
      "and Redo reverse (section 12): one stretch of typing in one sheet, until a save says it " +
      "finished, and a removal from the day, which asks for the short notice; Undo of a new " +
      "sheet's first stretch deletes it, and a deleted one comes back with a restore write. A " +
      "step compares only the set and the answers' prompts and words: it is refused when those " +
      "were written since by anything else, and when its journal day has closed, which it learns " +
      "from the journal. It works signed out, numbering versions itself, and syncs to the account " +
      "when signed in (section 5); signing in uploads every sheet with its history. The last " +
      "write wins, so two devices never conflict, and a deleted sheet is kept as a tombstone, " +
      "which always wins.",
    kind: "fact",
    shape: "replicated",
    emits: ["prompt-sheet.changed", "prompt-sheet.deleted", "step.recorded", "step.settled"],
    owns: "the journal prompts sheets kept with each journal day",
    steps: { "prompt-sheet.saved": "step" },
    asks: ["session: read", "journal: read", "evaluators: list", "llm: decide"],
  },
  context: ({ input }) => ({
    sheets: new Map(),
    outbox: new Map(),
    store: input.store,
    api: input.api,
    ask: input.ask,
    mint: input.mint ?? ulid,
    wait: input.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    // Today's journal day, from the journal (13); null until it says, or on a page without it.
    today: null,
    // The Answers the prompt evaluator as last listed or announced; null while it is not listed.
    evaluator: null,
    evaluatorHeard: false,
    // Each answer asked about since the page loaded, by keyOf, and what was found for
    // those that brought a sure answer; the key being asked now, or null. Memory only.
    asked: new Set(),
    found: new Map(),
    checking: null,
    // The stretch of typing still open (12, Undo): { step, id, before }, the step's id, the
    // sheet typed in and how it was before the stretch; null when none is.
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
            sheets: ({ event }) => new Map(event.output.sheets.filter(readable).map((r) => [r.id, toRecord(r)])),
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
            for (const message of context.queued) {
              if (message.type === "list?") message.reply({ sheets: [], total: 0 });
              if (message.type === "read?") message.reply({ sheet: null });
            }
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
        "list?": { actions: ({ context, event }) => replyList(context, event.payload, event.reply) },
        "read?": { actions: ({ context, event }) => replyRead(context, event.payload, event.reply) },
        "prompt-sheet.saved": { actions: enqueueActions(({ context, event, enqueue }) => applySave(context, event, enqueue)) },
        "step.undone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "step.redone": { actions: enqueueActions(({ context, event, enqueue }) => applyStep(context, event, enqueue)) },
        "journal.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            context.today = todayFrom(event) ?? context.today;
            enqueue.assign({ today: context.today });
            check(context, enqueue);
          }),
        },
        "evaluator.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            if (event.evaluator?.id !== PROMPT) return;
            context.evaluator = promptOf(event.evaluator);
            enqueue.assign({ evaluator: context.evaluator, evaluatorHeard: true });
            check(context, enqueue);
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
            for (const r of context.sheets.values()) {
              if (context.outbox.has(r.id)) continue;
              const row = outboxRow(r, r.version);
              context.outbox.set(r.id, row);
              enqueue(() => context.store.outboxPut(row).catch(() => {}));
            }
            enqueue.raise({ type: "_sync", pull: true });
            // An ask that failed signed out may succeed now; one that found an answer
            // need not be asked again.
            for (const key of [...context.asked]) if (!context.found.has(key)) context.asked.delete(key);
            context.userId = userId;
            check(context, enqueue);
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
        "list?": { actions: ({ event }) => event.reply({ sheets: [], total: 0 }) },
        "read?": { actions: ({ event }) => event.reply({ sheet: null }) },
      },
    },
  },
});

// Adopt one record the server holds: its content and version. A record whose user fields
// are those held here keeps the step that wrote them, so a judgement written elsewhere
// never refuses an Undo. Announced as a change or, for a tombstone of a sheet this tab was
// showing, as gone.
function adopt(context, server, enqueue) {
  const held = context.sheets.get(server.id);
  const r = toRecord(server);
  const kept = held?.step && sameOwn(held, r) ? { ...r, step: held.step } : r;
  context.sheets.set(kept.id, kept);
  enqueue(() => context.store.put(kept).catch(() => {}));
  if (kept.deleted) {
    if (visible(held)) enqueue.emit({ type: "prompt-sheet.deleted", id: kept.id, day: kept.day });
  } else {
    enqueue.emit({ type: "prompt-sheet.changed", sheet: announce(context, kept) });
  }
}

// Apply a sync's summary: adopt acknowledged and pulled records, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], pulled = [], newCursor, authFailed } = output;

  for (const ack of acks) {
    if (!readable(ack)) continue;
    const row = context.outbox.get(ack.id);
    const held = context.sheets.get(ack.id);
    // The server holds a tombstone (a delete always wins, 5): the sheet is gone here too.
    if (ack.deleted) {
      context.outbox.delete(ack.id);
      enqueue(() => context.store.outboxDelete(ack.id).catch(() => {}));
      // This browser's own delete keeps the step that made it, so it can still be undone.
      if (held?.deleted && same(held, toRecord(ack))) {
        const r = { ...held, version: ack.version };
        context.sheets.set(r.id, r);
        enqueue(() => context.store.put(r).catch(() => {}));
      } else adopt(context, ack, enqueue);
      continue;
    }
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    const drained = row && same(toRecord(row), toRecord(ack));
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
    context.sheets.set(r.id, r);
    enqueue(() => context.store.put(r).catch(() => {}));
    if (visible(r)) enqueue.emit({ type: "prompt-sheet.changed", sheet: announce(context, r) });
  }

  for (const server of pulled ?? []) {
    if (!readable(server)) continue;
    const current = context.sheets.get(server.id);
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
      context.sheets.set(r.id, r);
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
  check(context, enqueue);
}
