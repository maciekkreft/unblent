import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the hashtag checks (3.1): what Jev answered about the lines a
// hashtag line names in a note or a journal day. Replicated (5) the way
// `choice-point-checks` is: local-first, cached in the browser and syncing to the per-user
// server when signed in. An answer is added under its key and never changes, so the server
// ignores a key it already holds (5, like a chat's turns). The notes, the days and the
// evaluators are other facts' (4.3, first rule): this keeps only what was announced, to
// know which lines to check. Everything with a side effect (the store, the network, the
// asks) arrives through input, so this stays importable in Node. The key, the queue and
// the questions are copies of choice-point-checks' own, because components never import
// each other (11.2).

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ANSWER = /^([0-9A-HJKMNP-TV-Z]{26}|yes|no)$/;
const KEY = /^[0-9a-f]{28}$/;
const KINDS = new Set(["note", "day"]);
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
// What llm: decide may answer instead of answers; anything else (a bus refusal, a thrown
// ask) is announced as unavailable, the one kind text.checked has for "the decider cannot be reached".
const ERRORS = new Set(["signed-out", "no-key", "bad-key", "rate-limited", "overloaded", "invalid", "busy", "unavailable", "local-off", "no-model"]);

// How long a line waits when Jev is busy with another request.
export const CHECK_PAUSE_MS = 1500;
// The pause the network waits for after a change (5), so a run of answers drains once.
const SYNC_IDLE_MS = 2000;

// --- Hashtag lines ---------------------------------------------------------------------
// A copy of `hashtagsIn` and `hashtagScopes` in editor/editor.js, the twin the editors
// draw with: a fact may not import the editor kit (11.2), and both must read a text the
// same way, so a change to one is made to the other.

const HASHTAG = /(^|\s)#([\p{L}\p{N}-]+)/gu;

function hashtagsIn(text) {
  const found = [];
  for (const m of String(text).matchAll(HASHTAG)) {
    const from = m.index + m[1].length;
    found.push({ from, to: from + 1 + m[2].length, name: m[2] });
  }
  return found;
}

export function hashtagScopes(text) {
  const scopes = [];
  let open = null;
  for (const line of String(text).split("\n")) {
    const tags = [...new Set(hashtagsIn(line).map((t) => t.name))];
    if (tags.length) {
      open = { tags, lines: [] };
      scopes.push(open);
    } else if (line.trim() === "") open = null;
    else if (open && /[\p{L}\p{N}]/u.test(line)) open.lines.push(line.trim());
  }
  return scopes;
}

// A copy of `shortName` in components/subject/machine.js, where a chapter link is named:
// a tag names an evaluator the same way a link names a chapter, and components never
// import each other (11.2).
const PLAIN = { "ł": "l", "ø": "o", "đ": "d", "ß": "ss", "æ": "ae", "œ": "oe" };
export const shortName = (title) =>
  String(title ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[łøđßæœ]/g, (c) => PLAIN[c])
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// --- The key of an answer (a copy of choice-point-checks') -------------------------------

// Two 53-bit cyrb53 runs with different seeds, as 28 hex digits: synchronous, so the
// machine knows at once whether a line is already answered, and the same in the browser,
// in Node and on another device. A collision would only reuse one line's answer for
// another; at 106 bits that does not happen for one person's lines.
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

// The evaluator's id, a question exactly as Jev is asked it, and the line: change any of
// them and that question is asked about the line again.
export const keyOf = (evaluatorId, questions, text) => {
  const s = JSON.stringify([evaluatorId, questions, text]);
  return cyrb53(s, 1) + cyrb53(s, 2);
};

// --- The questions Jev is asked (a copy of choice-point-checks') -------------------------

const live = (items) => (Array.isArray(items) ? items : []).filter((x) => x && !x.removing);
const filled = (s) => typeof s === "string" && s.trim() !== "";

// A pick question needs two live options with distinct names, because Jev knows an option
// by its name (llm: decide).
const pickable = (q) => {
  const names = live(q.options).map((o) => str(o.name).trim());
  return names.length >= 2 && names.every((n) => n !== "") && new Set(names).size === names.length;
};

const toQuestion = (q) => {
  const asked = { id: q.id, instructions: q.text };
  if (q.kind === "pick") {
    asked.kind = "pick";
    asked.options = live(q.options).map((o) => ({ id: o.id, name: o.name, ...(filled(o.description) ? { description: o.description } : {}) }));
  } else {
    if (filled(q.yes)) asked.yes = q.yes;
    if (filled(q.no)) asked.no = q.no;
  }
  return asked;
};

// The questions of an evaluator as llm: decide is asked them; a question switched off is
// not asked.
export const askedOf = (evaluator) =>
  live(evaluator?.questions)
    .filter((q) => q.on !== false && filled(q.text) && (q.kind !== "pick" || pickable(q)))
    .map(toQuestion);

// Jev's answers mapped to kept answers: for a yes / no question the side Jev leans to, with
// how likely that side is; for a pick question the option picked and its name.
export function answersOf(questions, answers) {
  const byId = new Map((Array.isArray(answers) ? answers : []).map((a) => [a?.id, a]));
  const out = [];
  for (const q of questions) {
    const a = byId.get(q.id);
    if (!a || typeof a.p !== "number") continue;
    const p = Math.min(1, Math.max(0, a.p));
    if (q.kind === "pick") {
      const option = q.options.find((o) => o.id === a.choice);
      if (option) out.push({ question: q.id, option: option.id, name: option.name, p });
    } else {
      const yes = p >= 0.5;
      out.push({ question: q.id, option: yes ? "yes" : "no", name: yes ? "Yes" : "No", p: yes ? p : 1 - p });
    }
  }
  return out;
}

const answerSetting = (a) =>
  a && isId(a.question) && ANSWER.test(str(a.option)) && typeof a.p === "number"
    ? { question: a.question, option: a.option, name: str(a.name), p: Math.min(1, Math.max(0, a.p)) }
    : null;
const answerRecord = (r) => ({ key: r.key, answers: (Array.isArray(r.answers) ? r.answers : []).map(answerSetting).filter(Boolean) });

// --- What a text's lines are -----------------------------------------------------------

const sourceKey = (kind, id) => `${kind}:${id}`;

// The account's evaluator a tag names: the first whose short name is the tag's.
function evaluatorFor(context, tag) {
  const name = shortName(tag);
  if (!name) return null;
  for (const e of context.evaluators.values()) if (shortName(e.name) === name) return e;
  return null;
}

// Every tag of the text's hashtag lines with the evaluator it names, and every line those
// lines name, each once, with every asked question of every evaluator named for it and the
// key its answer is kept under. A line named in two places is asked each question once.
function planOf(context, text) {
  const tags = [];
  const seenTags = new Set();
  const lines = new Map();
  for (const scope of hashtagScopes(text)) {
    const evaluators = [];
    for (const tag of scope.tags) {
      const e = evaluatorFor(context, tag);
      if (!seenTags.has(tag)) {
        seenTags.add(tag);
        tags.push({ tag, evaluator: e ? e.id : null });
      }
      if (e && !evaluators.includes(e)) evaluators.push(e);
    }
    const asked = evaluators.flatMap((e) => askedOf(e).map((question) => ({ evaluator: e.id, question })));
    for (const t of scope.lines) {
      const line = lines.get(t) ?? { text: t, items: [] };
      for (const a of asked) {
        const key = keyOf(a.evaluator, [a.question], t);
        if (!line.items.some((i) => i.key === key)) line.items.push({ ...a, key });
      }
      lines.set(t, line);
    }
  }
  return { tags, lines: [...lines.values()].filter((l) => l.items.length > 0) };
}

// What a kept answer shows at the line's end, read with the evaluator as it stands, so a
// changed icon shows at once: a pick's option with its icon, a yes / no only on yes.
function marksOf(context, item, answer) {
  const e = context.evaluators.get(item.evaluator);
  const q = live(e?.questions).find((x) => x.id === item.question.id);
  const out = [];
  for (const a of answer.answers) {
    if (a.question !== item.question.id) continue;
    if (item.question.kind === "pick") {
      const option = live(q?.options).find((o) => o.id === a.option);
      const icon = str(option?.icon);
      out.push({ evaluator: item.evaluator, question: a.question, option: a.option, name: a.name, ...(icon ? { icon } : {}), p: a.p });
    } else if (a.option === "yes") {
      out.push({ evaluator: item.evaluator, question: a.question, option: "yes", name: filled(q?.name) ? q.name : str(q?.text) || a.name, p: a.p });
    }
  }
  return out;
}

// An evaluator shown as one mark (`combined`, Your values) gets one for the line, by the rule
// `combinedMark` in components/choice-point-cards/machine.js and `judged` in
// components/evaluators/machine.js also hold, a copy because components never import each
// other (11.2). Going against any value is red and names them all, in the evaluator's order;
// else serving one is green and names the first; else it is uncolored. It speaks with the
// deciding answer: the first against, the first served, or the least sure, since every one
// of them had to miss. With no question answered there is no mark, as none would suggest Jev
// looked.
const valueName = (q) => (filled(q?.name) ? q.name.trim() : "one of your values");

const expectOf = (q) => {
  const want = q?.expect;
  if (want === "yes" || want === "no") return q.kind === "pick" ? null : want;
  return q?.kind === "pick" && q.options?.some((o) => o.id === want && !o.removing) ? want : null;
};

function combinedMark(evaluator, answer) {
  const answered = live(evaluator.questions)
    .filter((q) => q.on !== false)
    .map((q) => ({ q, a: answer(q.id) }))
    .filter((x) => x.a);
  if (!answered.length) return [];
  const mark = (tone, { a }, name) => ({ evaluator: evaluator.id, question: a.question, option: a.option, name, icon: "compass", p: a.p, tone });
  const against = answered.filter(({ q, a }) => q.options?.some((o) => o.id === a.option && o.against));
  if (against.length) return [mark("wrong", against[0], `Goes against ${against.map(({ q }) => valueName(q)).join(", ")}`)];
  const served = answered.find(({ q, a }) => expectOf(q) != null && a.option === expectOf(q));
  if (served) return [mark("right", served, `Serves ${valueName(served.q)}`)];
  const least = answered.reduce((x, y) => (y.a.p < x.a.p ? y : x));
  return [mark("plain", least, "Can't tell which of your values this serves")];
}

// What a line shows at its end, evaluator by evaluator, in the order of its items: only here
// are all of a combined evaluator's items known together, at the place of its first item.
function lineMarks(context, items, answers) {
  const combined = new Set();
  return items.flatMap((item, n) => {
    const e = context.evaluators.get(item.evaluator);
    if (!e?.combined) return answers[n] ? marksOf(context, item, answers[n]) : [];
    if (combined.has(e.id)) return [];
    combined.add(e.id);
    const kept = (id) => {
      const at = items.findIndex((i) => i.evaluator === e.id && i.question.id === id);
      return at < 0 ? undefined : answers[at]?.answers.find((a) => a.question === id);
    };
    return combinedMark(e, kept);
  });
}

const queuedKey = (context, key) => Boolean(context.asking?.keys.includes(key)) || context.jobs.some((j) => j.keys.includes(key));

// A line with every question answered is done; one with a question queued or being asked
// is waiting for Jev; one whose last check failed is failed. Any other line is still
// being written, or was never finished, and is left out.
function report(context, source) {
  const plan = planOf(context, source.text);
  let error;
  const lines = [];
  for (const line of plan.lines) {
    const answers = line.items.map((i) => context.answers.get(i.key));
    const missing = line.items.filter((_, n) => !answers[n]);
    const failed = missing.map((i) => context.failures.get(i.key)).find(Boolean);
    const pending = missing.some((i) => queuedKey(context, i.key));
    if (answers.every((a) => !a) && !failed && !pending) continue;
    if (failed && !pending && !error) error = failed;
    const status = missing.length === 0 ? "done" : pending ? "pending" : failed ? "failed" : "done";
    const marks = status === "done" ? lineMarks(context, line.items, answers) : [];
    lines.push({ text: line.text, status, marks });
  }
  return { source: { kind: source.kind, id: source.id }, tags: plan.tags, lines, ...(error ? { error } : {}) };
}

// Announce a text when its report differs from what was last announced or read for it; a
// text with no tag and no checked line is not announced until it has one.
function announce(context, enqueue, source) {
  const k = sourceKey(source.kind, source.id);
  const r = report(context, source);
  const text = JSON.stringify(r);
  const last = context.reported.get(k);
  if (last === text || (last === undefined && r.tags.length === 0 && r.lines.length === 0)) return;
  context.reported.set(k, text);
  enqueue.emit({ type: "text.checked", ...r });
}

const announceAll = (context, enqueue) => {
  for (const source of context.sources.values()) announce(context, enqueue, source);
};

// --- Checking --------------------------------------------------------------------------

// Whether a text may ask: a note always; a journal day only while it is the day that can
// still be written (journal.changed's open), or a new page for today the journal has not
// announced yet. Undefined while the journal has not said, so the lines wait for it.
function mayAsk(context, source) {
  if (source.kind === "note") return true;
  const j = context.journal;
  if (!j) return undefined;
  if (j.open === source.id) return true;
  if (j.days.has(source.id)) return false;
  return j.open == null ? true : undefined;
}

// Queue, for every finished line of the text and every line whose last check failed, the
// questions it has no answer to and that are not queued yet, as one Jev request per line;
// then announce it, so its new lines show as waiting at once. Without a decider nothing is
// asked.
function check(context, enqueue, source, finished) {
  let added = false;
  if (context.keySet) {
    for (const line of planOf(context, source.text).lines) {
      const retry = line.items.some((i) => context.failures.has(i.key));
      if (!finished.has(line.text) && !retry) continue;
      const missing = line.items.filter((i) => !context.answers.has(i.key) && !queuedKey(context, i.key));
      if (missing.length === 0) continue;
      for (const item of missing) context.failures.delete(item.key);
      const questions = missing.map((i) => i.question);
      context.jobs.push({ keys: missing.map((i) => i.key), questions, payload: { state: { text: line.text }, questions } });
      added = true;
    }
  }
  announce(context, enqueue, source);
  if (added) enqueue.raise({ type: "_next" });
}

// The finished lines of a text, asked now when the text may ask, dropped when it may not
// (a past day), and kept until the journal says which day is open otherwise.
function settle(context, enqueue, source) {
  const k = sourceKey(source.kind, source.id);
  const may = mayAsk(context, source);
  const finished = context.finished.get(k) ?? new Set();
  if (may === undefined) return announce(context, enqueue, source);
  context.finished.delete(k);
  if (may) return check(context, enqueue, source, finished);
  announce(context, enqueue, source);
}

function saved(context, enqueue, kind, id, text, finished) {
  if (!isId(id) || typeof text !== "string") return;
  const k = sourceKey(kind, id);
  const source = { kind, id, text };
  context.sources.set(k, source);
  const marks = context.finished.get(k) ?? new Set();
  for (const t of Array.isArray(finished) ? finished : []) if (filled(t)) marks.add(t.trim());
  context.finished.set(k, marks);
  settle(context, enqueue, source);
}

// A queued line is still wanted when one of its questions has no answer yet and some text
// still names it: a line edited again while it waited is not asked about.
function wanted(context, job) {
  const open = job.keys.filter((k) => !context.answers.has(k));
  if (open.length === 0) return false;
  const planned = new Set([...context.sources.values()].flatMap((s) => planOf(context, s.text).lines.flatMap((l) => l.items.map((i) => i.key))));
  return open.some((k) => planned.has(k));
}

// --- Storage ---------------------------------------------------------------------------

const answerRow = (r) => ({ id: `answer:${r.key}`, kind: "answer", ...answerRecord(r) });

function queueRow(context, enqueue, row) {
  context.outbox.set(row.id, row);
  enqueue(() => context.store.outboxPut(row).catch(() => {}));
}

function keepAnswer(context, enqueue, r) {
  context.answers.set(r.key, r);
  context.failures.delete(r.key);
  enqueue(() => context.store.answerPut(r).catch(() => {}));
}

// An answer made here: kept, and queued for the server when signed in.
function storeAnswer(context, enqueue, r) {
  keepAnswer(context, enqueue, r);
  if (context.userId != null) {
    queueRow(context, enqueue, answerRow(r));
    enqueue.raise({ type: "_drain" });
  }
}

// --- Messages --------------------------------------------------------------------------

// Whether a decider can answer llm: decide for this account (a copy of value-checks'):
// the picture's decider is ready, or, in a picture from before deciders were offered, a
// Jev key is saved.
const canDecide = (picture) => (picture?.decider ? picture.decider.ready === true : picture?.jev?.keySet === true);

// The report for the text an editor shows, from kept answers only: nothing is asked, so
// opening, reloading or showing a past day costs nothing. The text is kept, so a later
// change to an evaluator it names is announced for it.
function replyRead(context, payload, reply) {
  if (!KINDS.has(payload?.kind) || !isId(payload?.id) || typeof payload?.text !== "string") return reply({ error: "invalid" });
  const source = { kind: payload.kind, id: payload.id, text: payload.text };
  const k = sourceKey(source.kind, source.id);
  context.sources.set(k, source);
  const r = report(context, source);
  context.reported.set(k, JSON.stringify(r));
  reply(r);
}

// Every message from the bus, whether it arrived while ready or was queued while loading.
function handle(context, message, enqueue) {
  switch (message.type) {
    case "read?":
      return replyRead(context, message.payload, message.reply);
    case "note.saved":
      return saved(context, enqueue, "note", message.id, message.body, message.finished);
    case "day.saved":
      return saved(context, enqueue, "day", message.id, message.text, message.finished);
    case "journal.changed": {
      const days = new Set((Array.isArray(message.days) ? message.days : []).map((d) => d?.id).filter(isId));
      context.journal = { open: isId(message.open) ? message.open : null, days };
      for (const source of context.sources.values()) if (source.kind === "day" && context.finished.has(sourceKey("day", source.id))) settle(context, enqueue, source);
      return;
    }
    case "llm.changed": {
      const keySet = canDecide(message);
      context.keySet = keySet;
      enqueue.assign({ keySet });
      return;
    }
    // A changed or removed evaluator changes the marks shown, never asks by itself: its
    // lines are asked again when one of them is next finished.
    case "evaluator.changed": {
      const e = message.evaluator;
      if (!isId(e?.id)) return;
      if (e.removing) context.evaluators.delete(e.id);
      else context.evaluators.set(e.id, e);
      return announceAll(context, enqueue);
    }
    case "evaluator.deleted":
      context.evaluators.delete(message.id);
      return announceAll(context, enqueue);
    case "session.changed":
      // The browser is changing account (12): upload what is left, then empty the
      // local copy. Any other news ends it, and syncing goes on as before.
      if (message.leaving) {
        enqueue.assign({ leaving: true, keep: message.keep === true });
        enqueue.raise({ type: "_leave" });
        return;
      }
      if (context.leaving) enqueue.assign({ leaving: false, keep: false });
      // A keep called off (12): the copy stays this account's, so its mark goes.
      if (context.keep) enqueue(() => context.store.metaPut("adopt", null).catch(() => {}));
      return applySession(context, message.userId ?? null, enqueue);
  }
}

// Signing in enqueues every answer, so what was made signed out becomes the account's
// (5); a different user resets the cursor.
function applySession(context, userId, enqueue) {
  if (userId === context.userId) return;
  context.userId = userId;
  enqueue.assign({ userId });
  enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
  if (!userId) return;
  enqueue.assign({ cursor: 0 });
  enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
  for (const r of context.answers.values()) if (!context.outbox.has(`answer:${r.key}`)) queueRow(context, enqueue, answerRow(r));
  enqueue.raise({ type: "_sync", pull: true });
}

const QUEUED_TYPES = [
  "read?",
  "note.saved",
  "day.saved",
  "journal.changed",
  "llm.changed",
  "evaluator.changed",
  "evaluator.deleted",
  "session.changed",
];
const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });
const QUEUED = Object.fromEntries(QUEUED_TYPES.map((t) => [t, { actions: queue }]));
const HANDLED = Object.fromEntries(
  QUEUED_TYPES.map((t) => [t, { actions: enqueueActions(({ context, event, enqueue }) => handle(context, event, enqueue)) }]),
);

// A list another fact answered, or [] when it is not on the page or could not answer.
const listed = (reply, name) => (Array.isArray(reply?.[name]) ? reply[name] : []);

// The browser changed account while this fact was not on the page (12): a copy kept for
// another account, with nothing of it left to upload, is emptied before it is read. A copy
// marked to be added to the account (12, keep) is kept instead, and `keepFor` sends it.
async function claim(store, ask, api) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, outbox, from] = await Promise.all([store.metaGet("userId"), store.outboxAll(), store.metaGet("adopt")]);
  if (kept && kept !== userId && outbox.length === 0 && !from) await store.empty();
  await keepFor(store, from, userId, api);
}

// The browser joined an account keeping this copy (12, keep). When the account already
// holds any answer this copy is emptied and the pull from 0 brings the account's; when it
// holds none, every answer is queued for it. The mark is cleared only once every row is in
// the outbox, so a reload midway sends the copy again; when the account cannot be asked
// (offline) the mark stays and the next load decides.
async function keepFor(store, from, userId, api) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!Array.isArray(held?.answers)) {
      await store.metaPut("userId", userId);
      return;
    }
    if (held.answers.some((a) => KEY.test(str(a?.key)))) {
      await store.empty();
    } else {
      const [answers, outbox] = await Promise.all([store.answerAll(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      for (const a of answers) {
        if (!KEY.test(str(a?.key))) continue;
        const row = answerRow(answerRecord(a));
        if (!queued.has(row.id)) await store.outboxPut(row);
      }
    }
    await store.metaPut("cursor", 0);
    await store.metaPut("userId", userId);
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
    hasJob: ({ context }) => context.jobs.some((j) => wanted(context, j)),
  },
  actors: {
    // The cache, who is signed in, whether a decider can answer, and the evaluators a tag
    // may name. Missing asks (a Node test) read as signed out, no decider, nothing listed.
    load: fromPromise(async ({ input }) => {
      const { store, ask, api } = input;
      const asked = (target, name, payload, fallback) =>
        ask ? ask(target, name, payload).catch(() => fallback) : Promise.resolve(fallback);
      // Asked first, before anything is awaited: an llm.changed or evaluator.changed that
      // arrives after the ask is held until its reply (4.2), so what is queued while loading
      // is never older than the reply it is applied after.
      const facts = Promise.all([asked("evaluators", "list", {}, {}), asked("llm", "read", {}, {})]);
      await claim(store, ask, api);
      const [answers, outbox, cursor, userId] = await Promise.all([
        store.answerAll(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      const [session, [evaluators, llm]] = await Promise.all([asked("session", "read", {}, { userId: null }), facts]);
      return {
        answers,
        outbox,
        cursor: cursor ?? 0,
        storedUserId: userId ?? null,
        userId: session?.error ? (userId ?? null) : (session?.userId ?? null),
        evaluators: listed(evaluators, "evaluators"),
        keySet: canDecide(llm),
      };
    }),
    // decide is superseded by nothing, so nothing is held for it.
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
    // Empties the local copy in one transaction, outbox and cache together (12). With
    // keep (12) the copy stays and is marked, under the account it came from.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // One sync: drain the outbox in id order, then pull what changed since the cursor when
    // asked to. It returns a summary the machine applies; it never emits (4.3). A network
    // error stops it with what it had; 401 reports the session is gone.
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
        acks.push({ row, result });
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
      return { acks, answers: pulled.answers, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "line-checks",
  meta: {
    description:
      "Owns what Jev, or Kev in Ollama on a Mac, answered about the lines a hashtag line " +
      "names in a note or a journal day. A hashtag line is a line that holds one or more " +
      "#name words, with or without other text, such as \"Things on my mind tonight " +
      "#in-my-control\". Each name is matched to one of the account's evaluators by the " +
      "evaluator's name made short the way a chapter link names a chapter: lowercase a to z " +
      "and digits, accented letters written plainly, every other run of characters one " +
      "hyphen. In the journal and in a note, typing # opens a list of the account's evaluators " +
      "by these short names, each with its description, and picking one writes its name; " +
      "Enter at the end of a hashtag line starts a bullet below it, so the lines written " +
      "next are in its list and get checked. " +
      "A name that matches no evaluator checks nothing. The hashtag line itself is " +
      "not checked. It checks the lines after it in the same paragraph or list, up to the next " +
      "gap between paragraphs (a blank line); a line without a letter or digit is skipped. A " +
      "line is checked once the user has finished it, as the editor's save says (the cursor " +
      "left the line, Enter, the box losing focus, or a paste); the line being typed is not " +
      "checked. A past journal day never asks: it shows only the answers already kept. The " +
      "read query answers from the kept answers only and never asks, so opening, reloading " +
      "or showing a past day costs nothing. Each answer is kept per question, under a key " +
      "made of the evaluator's id, that question as it stands, and the line's text, and never " +
      "changes once written, so editing a line hides its old mark until the new text is " +
      "answered and another device reuses the answers, as in choice-point-checks. Renaming " +
      "or editing an evaluator changes the marks shown at once but asks nothing by itself; " +
      "its lines are asked when one of them is next finished. The marks " +
      "announced for a line are one per question: for a pick-one question the chosen " +
      "option's icon and name; for a yes / no question the question's short name, only when " +
      "the answer is yes, and nothing on no. An evaluator shown as one mark (`combined`, Your " +
      "values) instead gets one compass per line, however many values it has, made from the " +
      "same kept answers, so nothing more is asked: red when any answer goes against a value, " +
      "naming them all (\"Goes against Honesty, Health\"); otherwise green when a value is " +
      "served, naming the first (\"Serves Honesty\"); otherwise uncolored (\"Can't tell which " +
      "of your values this serves\"); and none when no question is answered. Other evaluators " +
      "on the line keep their own marks, in the order of the tags. Lines are asked one at a time, in a queue, one " +
      "Jev request per line; when Jev is busy the line waits and is asked again. Without a key " +
      "or a decider nothing is asked. A " +
      "failure, such as signed out, no key or rate limited, is announced with the lines so " +
      "the editor can say why, and those lines are asked again when a line of that text is " +
      "next finished. It works signed out and syncs to the account when signed in " +
      "(section 5). Checking is not a step: the edit that made the line is the note's or the " +
      "day's step.",
    kind: "fact",
    shape: "replicated",
    owns: "Jev's answers about the lines named by hashtags in notes and journal days",
    steps: {
      "note.saved": "follows",
      "day.saved": "follows",
    },
    emits: ["text.checked"],
    asks: ["llm: decide", "llm: read", "evaluators: list", "session: read"],
  },
  context: ({ input }) => ({
    store: input.store,
    api: input.api,
    ask: input.ask,
    answers: new Map(), // key -> { key, answers }
    outbox: new Map(),
    evaluators: new Map(), // as evaluators announced them
    sources: new Map(), // "kind:id" -> { kind, id, text }, the latest text saved or read
    finished: new Map(), // "kind:id" -> the finished lines waiting to be asked
    journal: null, // { open, days } from journal.changed, null until it is heard
    failures: new Map(), // key -> the error its last check ended with
    reported: new Map(), // "kind:id" -> the report last announced or read, as text
    jobs: [],
    asking: null,
    keySet: false, // a decider can answer llm: decide (a Jev key, or Kev on the Mac)
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
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ store: context.store, ask: context.ask, api: context.api }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            const o = event.output;
            for (const a of o.answers) if (KEY.test(str(a?.key))) context.answers.set(a.key, answerRecord(a));
            for (const row of o.outbox) context.outbox.set(row.id, row);
            for (const e of o.evaluators) if (isId(e?.id) && !e.removing) context.evaluators.set(e.id, e);
            context.cursor = o.cursor;
            context.userId = o.storedUserId;
            context.keySet = o.keySet;
            enqueue.assign({ cursor: o.cursor, userId: o.storedUserId, keySet: o.keySet });
            // Who is signed in now decides how an answer is kept, so it is settled before
            // what queued while loading is replayed.
            const signedIn = o.userId && o.userId !== o.storedUserId;
            applySession(context, o.userId, enqueue);
            for (const message of context.queued) handle(context, message, enqueue);
            enqueue.assign({ queued: [] });
            // Signing in already asked for a sync with a pull.
            if (context.userId && !signedIn) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "read?") message.reply({ error: "not-ready" });
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: QUEUED,
    },
    ready: {
      type: "parallel",
      on: HANDLED,
      states: {
        // One request at a time (llm answers a second one busy): the head of the queue
        // still wanted is asked, its answer kept and announced, and the next one follows.
        check: {
          initial: "waiting",
          states: {
            waiting: {
              on: { _next: { guard: "hasJob", target: "asking" } },
            },
            asking: {
              entry: assign(({ context }) => {
                const i = context.jobs.findIndex((j) => wanted(context, j));
                return { asking: context.jobs[i], jobs: context.jobs.slice(i + 1) };
              }),
              invoke: {
                src: "decide",
                input: ({ context }) => ({ ask: context.ask, payload: context.asking.payload }),
                onDone: {
                  target: "waiting",
                  actions: enqueueActions(({ context, event, enqueue }) => decided(context, event.output, enqueue)),
                },
                onError: {
                  target: "waiting",
                  actions: enqueueActions(({ context, enqueue }) => decided(context, { error: "unavailable" }, enqueue)),
                },
              },
            },
          },
        },
        sync: {
          initial: "idle",
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
            // Emptied; an answer made meanwhile is uploaded and emptied again. When the
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
      },
    },
    failed: {
      on: {
        "read?": { actions: ({ event }) => event.reply({ error: "not-ready" }) },
      },
    },
  },
});

// Jev's reply to the line being asked. The answer is split into one record per question,
// each kept, queued for the server when signed in, and announced. Busy (another Jev
// request in flight) puts the line back at the head of the queue to be asked after a
// pause. Any other failure ends the queue: every line in it fails with the same reason,
// since the next would fail the same way.
function decided(context, reply, enqueue) {
  const job = context.asking;
  if (!job) return;
  context.asking = null;
  enqueue.assign({ asking: null });
  if (Array.isArray(reply?.answers)) {
    job.questions.forEach((q, n) => storeAnswer(context, enqueue, { key: job.keys[n], answers: answersOf([q], reply.answers) }));
    announceAll(context, enqueue);
    enqueue.raise({ type: "_next" });
    return;
  }
  const error = ERRORS.has(reply?.error) ? reply.error : "unavailable";
  if (error === "busy") {
    context.jobs.unshift(job);
    enqueue.cancel("busy");
    enqueue.raise({ type: "_next" }, { delay: CHECK_PAUSE_MS, id: "busy" });
    return;
  }
  const failed = [job, ...context.jobs];
  context.jobs.length = 0;
  for (const j of failed) for (const k of j.keys) context.failures.set(k, error);
  announceAll(context, enqueue);
}

// Apply a sync's summary: adopt acknowledged and pulled answers, advance the cursor, and
// drop the session on a 401.
function applySync(context, output, enqueue) {
  const { acks = [], answers = [], newCursor, authFailed } = output;
  let changed = false;

  const adoptAnswer = (server) => {
    if (!KEY.test(str(server?.key))) return;
    const r = answerRecord(server);
    const held = context.answers.get(r.key);
    if (held && JSON.stringify(held) === JSON.stringify(r)) return;
    keepAnswer(context, enqueue, r);
    changed = true;
  };

  for (const { row, result } of acks) {
    context.outbox.delete(row.id);
    enqueue(() => context.store.outboxDelete(row.id).catch(() => {}));
    // Another device may have answered the same key first; its answer is the one kept.
    adoptAnswer(result);
  }
  for (const server of answers) adoptAnswer(server);
  if (changed) announceAll(context, enqueue);

  if (newCursor !== undefined) {
    context.cursor = newCursor;
    enqueue.assign({ cursor: newCursor });
    enqueue(() => context.store.metaPut("cursor", newCursor).catch(() => {}));
  }
  if (authFailed) {
    context.userId = null;
    enqueue.assign({ userId: null });
    enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
  }
}
