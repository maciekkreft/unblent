import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the choice point checks (3.1): which evaluator checks each
// box of a choice point, how its answers are shown, and what Jev answered about each line.
// Replicated (5) the way `choice-points` is: local-first, cached in the browser, numbering
// versions itself while signed out and syncing to the per-user server when signed in. The
// settings are one row per box and the last write wins; an answer is added under its key
// and never changes, so the server ignores a key it already holds (5, like a chat's turns).
// The choice points and the evaluators are other facts' (4.3, first rule): this keeps only
// what they announced, to know which lines to check. Everything with a side effect (the
// store, the network, the asks) arrives through input, so this stays importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ANSWER = /^([0-9A-HJKMNP-TV-Z]{26}|yes|no)$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const KEY = /^[0-9a-f]{28}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const isDay = (v) => typeof v === "string" && DAY.test(v);
const str = (v) => (typeof v === "string" ? v : "");

export const FIELDS = ["away", "towards", "situation", "thoughts"];
const ICONS = new Set(["auto", "check", "warning", "person-simple-walk", "brain", "none"]);
// What llm: decide may answer instead of answers; anything else (a bus refusal, a thrown
// ask) is announced as unavailable, the one kind lines.checked has for "Jev cannot be reached".
const ERRORS = new Set(["signed-out", "no-key", "bad-key", "rate-limited", "overloaded", "invalid", "busy", "unavailable"]);

// The pause after a settings or evaluator change before the day on screen is checked
// again, so a run of edits in Settings asks once; also how long a busy line waits.
export const CHECK_PAUSE_MS = 1500;
// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

// --- The key of an answer --------------------------------------------------------------

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
// them and that question is asked about the line again. An answer is kept per question, so
// a question switched on or added asks only it; for a one-question evaluator this is the
// same key the whole set was once kept under.
export const keyOf = (evaluatorId, questions, text) => {
  const s = JSON.stringify([evaluatorId, questions, text]);
  return cyrb53(s, 1) + cyrb53(s, 2);
};

// --- The questions Jev is asked --------------------------------------------------------

const live = (items) => (Array.isArray(items) ? items : []).filter((x) => x && !x.removing);
const filled = (s) => typeof s === "string" && s.trim() !== "";

// A pick question needs two live options with distinct names, because Jev knows an option
// by its name (llm: decide); evaluator-list's Run box asks by the same rule.
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

// The questions of an evaluator as llm: decide is asked them, or [] when it has none to ask.
// A question switched off is kept in the evaluator but not asked; `all` counts it, which is
// how the whole set was keyed before answers were kept per question.
export const askedOf = (evaluator, { all = false } = {}) =>
  live(evaluator?.questions)
    .filter((q) => (all || q.on !== false) && filled(q.text) && (q.kind !== "pick" || pickable(q)))
    .map(toQuestion);

// Jev's answers mapped to the box's terms: for a yes / no question the side Jev leans to,
// with how likely that side is; for a pick question the option picked and its name. A
// question Jev left out, or an option it cannot name, has no answer.
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

// --- Records ---------------------------------------------------------------------------

const questionSetting = (q) =>
  q && isId(q.id)
    ? {
        id: q.id,
        show: q.show === true,
        expect: typeof q.expect === "string" && ANSWER.test(q.expect) ? q.expect : null,
        when: q.when && isId(q.when.question) && ANSWER.test(str(q.when.option)) ? { question: q.when.question, option: q.when.option } : null,
        icons: Object.fromEntries(
          Object.entries(q.icons && typeof q.icons === "object" ? q.icons : {}).filter(([k, v]) => ANSWER.test(k) && ICONS.has(v)),
        ),
      }
    : null;

const settingsOfQuestions = (qs) => (Array.isArray(qs) ? qs : []).map(questionSetting).filter(Boolean);

// The further evaluators of a box, each once and never the box's own evaluator again, so
// no question is asked twice about a line.
const alsoOf = (b, main) => {
  const seen = new Set([main]);
  const out = [];
  for (const a of Array.isArray(b?.also) ? b.also : []) {
    if (!isId(a?.evaluator) || seen.has(a.evaluator)) continue;
    seen.add(a.evaluator);
    out.push({ evaluator: a.evaluator, questions: settingsOfQuestions(a.questions) });
  }
  return out;
};

// One box's settings in one fixed shape and key order, so two copies compare equal as text.
const box = (b) => {
  const evaluator = isId(b?.evaluator) ? b.evaluator : null;
  return { evaluator, questions: settingsOfQuestions(b?.questions), also: alsoOf(b, evaluator) };
};
const boxRecord = (field, b) => ({
  field,
  ...box(b),
  version: Number.isInteger(b?.version) && b.version >= 1 ? b.version : 1,
});
const sameBox = (a, b) => JSON.stringify(box(a)) === JSON.stringify(box(b));

const answerSetting = (a) =>
  a && isId(a.question) && ANSWER.test(str(a.option)) && typeof a.p === "number"
    ? { question: a.question, option: a.option, name: str(a.name), p: Math.min(1, Math.max(0, a.p)) }
    : null;
const answerRecord = (r) => ({ key: r.key, answers: (Array.isArray(r.answers) ? r.answers : []).map(answerSetting).filter(Boolean) });

const settingsOf = (context) => Object.fromEntries(FIELDS.map((f) => [f, box(context.boxes.get(f))]));

const choicePoint = (c) => ({ id: c.id, day: c.day, ...Object.fromEntries(FIELDS.map((f) => [f, str(c[f])])) });

// --- What a choice point's lines are ---------------------------------------------------

// An evaluator whose questions are built from another fact, such as Your values from the
// values, has questions that depend on the day: a past day keeps the ones it had.
const isDerived = (e) => typeof e?.derivedFrom === "string";

// The evaluators of a box: its own first, then the further ones, in order.
const idsOf = (b) => (b ? [b.evaluator, ...(b.also ?? []).map((a) => a.evaluator)].filter(isId) : []);

// The evaluator as it stands on a day: an evaluator the user wrote is the same on every
// day; a derived one is the day's own version, listed for that day (evaluators: list), and
// undefined while that day has not been listed yet. Null when it is gone or waiting out
// its undo window.
function evaluatorOn(context, id, day) {
  const e = context.evaluators.get(id);
  if (!e || e.removing) return null;
  if (!isDerived(e)) return e;
  const daily = context.daily.get(day);
  return daily ? (daily.get(id) ?? null) : undefined;
}

// The evaluators that check a box on a day, each with the questions it is asked; one with
// no question to ask (Your values with no values) is left out, so nothing is asked for it.
// Whether an evaluator is switched on is the book's Run box's business, not this. Only the
// box's own evaluator has `whole`, the set its answers were kept under before answers were
// kept per question.
function checkersOf(context, field, day) {
  const out = [];
  idsOf(context.boxes.get(field)).forEach((id, n) => {
    const evaluator = evaluatorOn(context, id, day);
    if (!evaluator) return;
    const questions = askedOf(evaluator);
    if (questions.length === 0) return;
    out.push({ evaluator: id, questions, whole: n === 0 ? askedOf(evaluator, { all: true }) : null });
  });
  return out;
}

// Every non-empty line of every checked box, with each asked question of each of the box's
// evaluators and the key its answer is kept under, and `legacy`, for the box's own
// evaluator, the key the whole set was kept under before answers were kept per question.
// A line is keyed without the spaces around it, so adding one is not a new check.
function planOf(context, cp) {
  const out = [];
  for (const field of FIELDS) {
    const checkers = checkersOf(context, field, cp.day);
    if (checkers.length === 0) continue;
    for (const text of cp[field].split("\n")) {
      if (text.trim() === "") continue;
      const t = text.trim();
      const items = checkers.flatMap((c) =>
        c.questions.map((question) => ({ question, key: keyOf(c.evaluator, [question], t), legacy: c.whole ? keyOf(c.evaluator, c.whole, t) : null })),
      );
      out.push({ field, text, items });
    }
  }
  return out;
}

// One question's answer about a line: kept under its own key, or else taken from the whole
// set's answer kept before, so a line checked then is not asked again. A whole-set answer
// that leaves the question out still counts as asked.
function answerOf(context, item) {
  const own = context.answers.get(item.key);
  if (own) return own;
  const whole = item.legacy ? context.answers.get(item.legacy) : null;
  return whole ? { key: item.key, answers: whole.answers.filter((a) => a.question === item.question.id) } : null;
}

const lineKeys = (line) => line.items.flatMap((i) => [i.key, i.legacy]).filter(Boolean);
const lineOf = (line) => `${line.field}\n${line.text}`;

// --- The day's own questions -----------------------------------------------------------

// A box checked by a derived evaluator needs each day's questions before that day's lines
// are asked or reported, so the box's evaluators are asked together and a line keeps one
// Jev request. A day is known once evaluators: list answered for it and no newer list for
// it is on its way.
const usesDerived = (context) => FIELDS.some((f) => idsOf(context.boxes.get(f)).some((id) => isDerived(context.evaluators.get(id))));
const known = (context, day) => !usesDerived(context) || (context.daily.has(day) && !context.fetching.has(day));

function listDay(context, enqueue, day) {
  context.fetching.add(day);
  const ask = context.ask;
  enqueue(({ self }) =>
    Promise.resolve()
      .then(() => (typeof ask === "function" ? ask("evaluators", "list", { day }) : null))
      .catch(() => null)
      .then((reply) => self.send({ type: "_daily", day, evaluators: listed(reply, "evaluators") })),
  );
}

// Ask for a day's questions when they are needed and not known or on their way.
function need(context, enqueue, day) {
  if (!isDay(day) || !usesDerived(context) || context.daily.has(day) || context.fetching.has(day)) return;
  listDay(context, enqueue, day);
}

// A derived evaluator changed (today's values were edited): every day listed is listed
// again, since only evaluators knows which days the change reaches. A past day's
// questions come back the same, so its keys, its answers and its marks stay.
function relist(context, enqueue) {
  for (const day of new Set([...context.daily.keys(), ...context.fetching])) {
    if (context.fetching.has(day)) context.stale.add(day);
    else listDay(context, enqueue, day);
  }
}

// A day's questions arrived: the reads waiting for them are answered, and the day's choice
// points are checked (the day on screen) or announced with what they have.
function dayListed(context, enqueue, { day, evaluators }) {
  context.fetching.delete(day);
  context.daily.set(day, new Map(evaluators.filter((e) => isId(e?.id) && isDerived(e)).map((e) => [e.id, e])));
  if (context.stale.delete(day)) listDay(context, enqueue, day);
  if (!known(context, day)) return;
  const waiting = context.waiting.get(day) ?? [];
  context.waiting.delete(day);
  for (const reply of waiting) replyRead(context, enqueue, day, reply);
  for (const cp of context.choicePoints.values()) {
    if (cp.day !== day) continue;
    checkFinished(context, enqueue, cp);
    if (day === context.day) check(context, enqueue, cp);
    else announce(context, enqueue, cp);
  }
}

// A line with every question answered is done; one with a question queued or being asked
// is waiting for Jev; one whose last check failed is failed. A line with some answers and
// the rest not asked yet (a question just switched on) shows what it has. Any other line is
// still being written and is left out, so it shows no mark until the user finishes it.
function report(context, cp) {
  let error;
  const lines = [];
  for (const line of planOf(context, cp)) {
    const answers = line.items.map((i) => answerOf(context, i));
    const missing = line.items.filter((_, n) => !answers[n]);
    const failed = missing.map((i) => context.failures.get(i.key)).find(Boolean);
    const pending = missing.some((i) => queuedKey(context, i.key));
    const known = answers.filter(Boolean);
    if (known.length === 0 && !failed && !pending) continue;
    if (failed && !pending && !error) error = failed;
    const status = missing.length === 0 ? "done" : pending ? "pending" : failed ? "failed" : "done";
    lines.push({ field: line.field, text: line.text, status, answers: status === "done" ? known.flatMap((a) => a.answers) : [] });
  }
  return { choicePoint: cp.id, day: cp.day, lines, ...(error ? { error } : {}) };
}

// Announce a choice point's lines when they differ from what was last announced for it; a
// choice point that has never had a checked line is not announced until it has one. A day
// whose own questions are not known yet is announced once they are (dayListed).
function announce(context, enqueue, cp) {
  if (!known(context, cp.day)) return need(context, enqueue, cp.day);
  const r = report(context, cp);
  const text = JSON.stringify(r);
  const last = context.reported.get(cp.id);
  if (last === text || (last === undefined && r.lines.length === 0 && !r.error)) return;
  context.reported.set(cp.id, text);
  enqueue.emit({ type: "lines.checked", ...r });
}

const announceAll = (context, enqueue, keys) => {
  for (const cp of context.choicePoints.values()) {
    if (!keys || planOf(context, cp).some((l) => lineKeys(l).some((k) => keys.has(k)))) announce(context, enqueue, cp);
  }
};

// --- Checking --------------------------------------------------------------------------

const queuedKey = (context, key) => Boolean(context.asking?.keys.includes(key)) || context.jobs.some((j) => j.keys.includes(key));

// Queue, for every line of the choice point (or only those `only` lets through), the
// questions it has no answer to and that are not queued yet, as one Jev request per line;
// then announce it, so its new lines show as waiting at once. An answer found only in the
// whole set's old record is kept under its own key here, so it outlives a later edit of
// another question. A day whose own questions are not known yet waits for them, so the
// line is asked once with every evaluator's questions (dayListed).
function check(context, enqueue, cp, only = () => true) {
  if (!known(context, cp.day)) return need(context, enqueue, cp.day);
  let added = false;
  for (const line of planOf(context, cp)) {
    if (!only(line)) continue;
    const missing = [];
    for (const item of line.items) {
      if (context.answers.has(item.key)) continue;
      const derived = answerOf(context, item);
      if (derived) storeAnswer(context, enqueue, derived);
      else if (!queuedKey(context, item.key)) missing.push(item);
    }
    if (missing.length === 0) continue;
    for (const item of missing) context.failures.delete(item.key);
    const questions = missing.map((i) => i.question);
    context.jobs.push({ keys: missing.map((i) => i.key), questions, payload: { state: { text: line.text.trim() }, questions } });
    added = true;
  }
  announce(context, enqueue, cp);
  if (added) enqueue.raise({ type: "_next" });
}

function checkDay(context, enqueue) {
  if (!context.day) return;
  for (const cp of context.choicePoints.values()) if (cp.day === context.day) check(context, enqueue, cp);
}

// A queued line is still wanted when one of its questions has no answer yet and some choice
// point still asks it: a line edited again, a question switched off, or a choice point
// removed while it waited is not asked about.
function wanted(context, job) {
  const open = job.keys.filter((k) => !context.answers.has(k));
  if (open.length === 0) return false;
  const planned = new Set([...context.choicePoints.values()].flatMap((cp) => planOf(context, cp).flatMap((l) => l.items.map((i) => i.key))));
  return open.some((k) => planned.has(k));
}

// A line the user finished (choice-point.saved's finished) is marked until the choice point
// as `choice-points` announced it holds that text, because the save and the change it
// leads to may reach this fact in either order. The marked lines are then queued, with
// any line of the same choice point whose last check failed, so a failure is retried at
// the next finished line.
const markOf = (id, field, text) => `${id}\n${field}\n${text.trim()}`;

function checkFinished(context, enqueue, cp) {
  // The marks wait with the day for its own questions (dayListed).
  if (!known(context, cp.day)) return need(context, enqueue, cp.day);
  const marked = planOf(context, cp).filter((l) => context.finished.has(markOf(cp.id, l.field, l.text)));
  if (marked.length === 0) return;
  for (const l of marked) context.finished.delete(markOf(cp.id, l.field, l.text));
  const lines = new Set(marked.map(lineOf));
  check(context, enqueue, cp, (l) => lines.has(lineOf(l)) || l.items.some((i) => context.failures.has(i.key)));
}

function finish(context, enqueue, message) {
  if (!isId(message.id) || !Array.isArray(message.finished)) return;
  for (const line of message.finished) {
    if (!FIELDS.includes(line?.field) || !filled(line.text) || idsOf(context.boxes.get(line.field)).length === 0) continue;
    context.finished.add(markOf(message.id, line.field, line.text));
  }
  const cp = context.choicePoints.get(message.id);
  if (cp) checkFinished(context, enqueue, cp);
}

const restartPause = (enqueue, id, event) => {
  enqueue.cancel(id);
  enqueue.raise(event, { delay: CHECK_PAUSE_MS, id });
};

const usesEvaluator = (context, id) => FIELDS.some((f) => idsOf(context.boxes.get(f)).includes(id));

// --- Settings changes ------------------------------------------------------------------

// The one place a box's settings change: kept, stored, queued for the server when signed
// in (signed out the version is minted here), and announced with the other three boxes.
function commitBox(context, enqueue, field, next) {
  const current = context.boxes.get(field);
  if (current && sameBox(current, next)) return;
  let r = boxRecord(field, next);
  if (context.userId == null) r = { ...r, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...r, version: current.version };
  context.boxes.set(field, r);
  enqueue(() => context.store.boxPut(r).catch(() => {}));
  if (context.userId != null) {
    const existing = context.outbox.get(`box:${field}`);
    queueRow(context, enqueue, boxRow(r, existing ? existing.baseVersion : current ? current.version : null));
    enqueue.raise({ type: "_drain" });
  }
  enqueue.emit({ type: "checks.changed", settings: settingsOf(context) });
  restartPause(enqueue, "day", { type: "_dueDay" });
}

const boxRow = (r, baseVersion) => ({ id: `box:${r.field}`, kind: "box", field: r.field, ...box(r), baseVersion });
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

// A read of a day whose own questions are not known yet is answered once they are.
function replyRead(context, enqueue, day, reply) {
  if (isDay(day) && !known(context, day)) {
    context.waiting.set(day, [...(context.waiting.get(day) ?? []), reply]);
    return need(context, enqueue, day);
  }
  const choicePoints = isDay(day)
    ? [...context.choicePoints.values()]
        .filter((cp) => cp.day === day)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((cp) => report(context, cp))
        .filter((r) => r.lines.length > 0 || r.error)
    : [];
  reply({ settings: settingsOf(context), choicePoints });
}

// Every message from the bus, whether it arrived while ready or was queued while loading.
function handle(context, message, enqueue) {
  switch (message.type) {
    case "read?":
      return replyRead(context, enqueue, message.payload?.day, message.reply);
    case "checks.edited":
      if (FIELDS.includes(message.field)) commitBox(context, enqueue, message.field, message);
      return;
    case "choice-point.changed": {
      const c = message.choicePoint;
      if (!isId(c?.id) || !isDay(c?.day)) return;
      const next = choicePoint(c);
      context.choicePoints.set(next.id, next);
      return checkFinished(context, enqueue, next);
    }
    case "choice-point.saved":
      return finish(context, enqueue, message);
    case "choice-point.deleted":
      context.choicePoints.delete(message.id);
      context.reported.delete(message.id);
      for (const mark of context.finished) if (mark.startsWith(`${message.id}\n`)) context.finished.delete(mark);
      return;
    case "evaluator.changed": {
      const e = message.evaluator;
      if (!isId(e?.id)) return;
      context.evaluators.set(e.id, e);
      // A changed question makes new keys; the day on screen is checked once editing pauses.
      if (!usesEvaluator(context, e.id)) return;
      if (isDerived(e)) relist(context, enqueue);
      restartPause(enqueue, "day", { type: "_dueDay" });
      return;
    }
    case "evaluator.deleted":
      context.evaluators.delete(message.id);
      if (usesEvaluator(context, message.id)) restartPause(enqueue, "day", { type: "_dueDay" });
      return;
    case "day.shown":
      if (!isDay(message.day)) return;
      context.day = message.day;
      return checkDay(context, enqueue);
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

// Signing in enqueues every box and every answer, so what was made signed out becomes the
// account's (5); a different user resets the cursor. The day on screen is checked again,
// so a line that failed for being signed out is asked now.
function applySession(context, userId, enqueue) {
  if (userId === context.userId) return;
  context.userId = userId;
  enqueue.assign({ userId });
  enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
  if (!userId) return;
  enqueue.assign({ cursor: 0 });
  enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
  for (const r of context.boxes.values()) if (!context.outbox.has(`box:${r.field}`)) queueRow(context, enqueue, boxRow(r, r.version));
  for (const r of context.answers.values()) if (!context.outbox.has(`answer:${r.key}`)) queueRow(context, enqueue, answerRow(r));
  enqueue.raise({ type: "_sync", pull: true });
  checkDay(context, enqueue);
}

const QUEUED_TYPES = [
  "read?",
  "checks.edited",
  "choice-point.changed",
  "choice-point.saved",
  "choice-point.deleted",
  "evaluator.changed",
  "evaluator.deleted",
  "day.shown",
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
// another account, with nothing of it left to upload, is emptied before it is read, so
// none of it is shown to the account now signed in or uploaded as its own. A copy marked
// to be added to the account (12, keep) is kept instead, and `keepFor` sends it.
async function claim(store, ask) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, outbox, from] = await Promise.all([store.metaGet("userId"), store.outboxAll(), store.metaGet("adopt")]);
  if (kept && kept !== userId && outbox.length === 0 && !from) await store.empty();
  await keepFor(store, from, userId);
}

// The browser joined an account keeping this copy (12, keep): every box, on the version it
// holds, and every answer is queued for the account, the cursor goes back to 0, and the
// copy is marked as the account's, so the pull then brings the account's own and the
// sign-in path (applySession) does not queue them again. The mark is cleared only once
// every row is stored in the outbox, so a reload midway sends the copy again (coalesced
// by id) rather than losing it. A mark left by a change of account that was called off
// names the account still signed in, and is only cleared.
async function keepFor(store, from, userId) {
  if (!from) return;
  if (from !== userId) {
    const [boxes, answers, outbox] = await Promise.all([store.boxAll(), store.answerAll(), store.outboxAll()]);
    const queued = new Set(outbox.map((row) => row.id));
    const rows = [
      ...boxes.filter((b) => FIELDS.includes(b?.field)).map((b) => boxRecord(b.field, b)).map((r) => boxRow(r, r.version)),
      ...answers.filter((a) => KEY.test(str(a?.key))).map((a) => answerRow(answerRecord(a))),
    ];
    for (const row of rows) if (!queued.has(row.id)) await store.outboxPut(row);
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
    // The cache, who is signed in, and the evaluators and choice points to know which
    // lines to check. Missing asks (a Node test) read as signed out with nothing listed.
    load: fromPromise(async ({ input }) => {
      const { store, ask } = input;
      await claim(store, ask);
      const asked = (target, name, payload, fallback) =>
        ask ? ask(target, name, payload).catch(() => fallback) : Promise.resolve(fallback);
      const [boxes, answers, outbox, cursor, userId] = await Promise.all([
        store.boxAll(),
        store.answerAll(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      const [session, evaluators, choicePoints] = await Promise.all([
        asked("session", "read", {}, { userId: null }),
        asked("evaluators", "list", {}, {}),
        asked("choice-points", "list", {}, {}),
      ]);
      return {
        boxes,
        answers,
        outbox,
        cursor: cursor ?? 0,
        storedUserId: userId ?? null,
        userId: session?.error ? (userId ?? null) : (session?.userId ?? null),
        evaluators: listed(evaluators, "evaluators"),
        choicePoints: listed(choicePoints, "choicePoints"),
      };
    }),
    // decide is superseded by nothing, so nothing is held for it.
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
    // Empties the local copy in one transaction, outbox and cache together (12).
    // With keep (12) the copy stays and is marked, under the account it came from, to be
    // added to the account the browser joins after the reload.
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
      return { acks, boxes: pulled.boxes, answers: pulled.answers, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "choice-point-checks",
  meta: {
    description:
      "Owns which evaluator checks each box of a choice point (away, towards, situation, " +
      "thoughts and feelings), how its answers are shown, and what Jev answered about each " +
      "line written in a checked box. The settings are one row per box, chosen in Settings " +
      "under Your account; the last write wins, so two devices never conflict. A box may also " +
      "have further evaluators, chosen under Also check with, that check each of its lines as " +
      "well; a line is still one Jev request, asking every evaluator's questions it has no " +
      "answer to together, and its answers are announced together, the box's own evaluator's " +
      "first. An evaluator built from another fact, Your values from the values, is asked the " +
      "questions of the choice point's own day (`evaluators: list` with that day), and its lines " +
      "are asked and reported only once that day's questions are known: a past day keeps the " +
      "values it had, so its answers and marks never change, an edit of today's values asks " +
      "again only the questions of the values that changed, and with no values nothing is " +
      "asked for it. Each answer " +
      "is kept per question, under a key made of the evaluator's id, that question as it " +
      "stands, and the line's text, and never changes once written: editing a line hides its " +
      "old mark until the new text is answered, editing a question asks only that question " +
      "again, and another device reuses the answers. A question switched off in the evaluator " +
      "is not asked and its answers are not reported, which asks nothing; switching it back " +
      "on asks only the lines that have no answer to it. Answers kept for a whole set of " +
      "questions before answers were kept per question are still used, so those lines are " +
      "not asked again. A line is checked when the user has finished it and " +
      "moved on, as the choice point's save says: Enter to a new line, the cursor moved to " +
      "another line, the box losing focus, or the sheet folding; the line being typed is not " +
      "checked and shows no mark until then. The day on screen is checked when it is shown, " +
      "and again after a settings change or a change to a box's evaluator. A line that already has an " +
      "answer is never asked again, so opening a day already checked costs nothing. Lines are " +
      "checked one at a time, in a queue, with one Jev request per line that asks the box's " +
      "questions it has no answer to together, about the line alone; every answer is announced, and which " +
      "marks are shown is decided only when they are shown. Whether the evaluator is switched " +
      "on for its book does not matter here. A failure, such as signed out, no Jev key or " +
      "rate limited, ends the queue and is announced with the lines so the choice point can " +
      "say why; the lines are asked again when a line of that choice point is next finished or " +
      "its day is next shown. When Jev is busy with another request the line waits and is asked " +
      "again. It works signed out and syncs to the account when signed in (section 5).",
    kind: "fact",
    shape: "replicated",
    owns: "which evaluator checks each choice point box, and Jev's answers about each line",
    emits: ["checks.changed", "lines.checked"],
    asks: ["llm: decide", "evaluators: list", "choice-points: list", "session: read"],
  },
  context: ({ input }) => ({
    store: input.store,
    api: input.api,
    ask: input.ask,
    boxes: new Map(), // field -> box record
    answers: new Map(), // key -> { key, answers }
    outbox: new Map(),
    evaluators: new Map(), // as evaluators announced them
    choicePoints: new Map(), // id -> { id, day, texts }, as choice-points announced them
    daily: new Map(), // day -> Map of derived evaluator id -> that day's evaluator (evaluators: list)
    fetching: new Set(), // days whose evaluators: list is on its way
    stale: new Set(), // days to list again once the list on its way lands
    waiting: new Map(), // day -> read replies waiting for the day's questions
    failures: new Map(), // key -> the error its last check ended with
    finished: new Set(), // lines the user finished that wait to be held here (markOf)
    reported: new Map(), // choice point id -> the lines.checked last announced, as text
    jobs: [],
    asking: null,
    day: null, // the day on screen, from day.shown
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
        input: ({ context }) => ({ store: context.store, ask: context.ask }),
        onDone: {
          target: "ready",
          actions: enqueueActions(({ context, event, enqueue }) => {
            const o = event.output;
            for (const b of o.boxes) if (FIELDS.includes(b?.field)) context.boxes.set(b.field, boxRecord(b.field, b));
            for (const a of o.answers) if (KEY.test(str(a?.key))) context.answers.set(a.key, answerRecord(a));
            for (const row of o.outbox) context.outbox.set(row.id, row);
            for (const e of o.evaluators) if (isId(e?.id)) context.evaluators.set(e.id, e);
            for (const c of o.choicePoints) if (isId(c?.id) && isDay(c?.day)) context.choicePoints.set(c.id, choicePoint(c));
            context.cursor = o.cursor;
            context.userId = o.storedUserId;
            enqueue.assign({ cursor: o.cursor, userId: o.storedUserId });
            // Who is signed in now decides how a change is made, so it is settled before
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
            for (const message of context.queued) if (message.type === "read?") message.reply({ settings: settingsOf(context), choicePoints: [] });
            enqueue.assign({ queued: [] });
          }),
        },
      },
      on: QUEUED,
    },
    ready: {
      type: "parallel",
      on: {
        ...HANDLED,
        _daily: { actions: enqueueActions(({ context, event, enqueue }) => dayListed(context, enqueue, event)) },
        _dueDay: {
          actions: enqueueActions(({ context, enqueue }) => {
            checkDay(context, enqueue);
            // A box that lost its evaluator leaves nothing to queue, but the marks already
            // announced for it, on any day, must go.
            for (const cp of context.choicePoints.values()) if (context.reported.has(cp.id)) announce(context, enqueue, cp);
          }),
        },
      },
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
      },
    },
    failed: {
      on: {
        "read?": { actions: ({ context, event }) => event.reply({ settings: settingsOf(context), choicePoints: [] }) },
      },
    },
  },
});

// Jev's reply to the line being asked. The answer is split into one record per question,
// each kept, queued for the server when signed in, and announced. Busy (another Jev request in flight) puts the line back at the
// head of the queue to be asked after a pause. Any other failure ends the queue: every
// line in it fails with the same reason, since the next would fail the same way.
function decided(context, reply, enqueue) {
  const job = context.asking;
  if (!job) return;
  context.asking = null;
  enqueue.assign({ asking: null });
  if (Array.isArray(reply?.answers)) {
    job.questions.forEach((q, n) => storeAnswer(context, enqueue, { key: job.keys[n], answers: answersOf([q], reply.answers) }));
    announceAll(context, enqueue, new Set(job.keys));
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
  announceAll(context, enqueue, new Set(failed.flatMap((j) => j.keys)));
}

// Apply a sync's summary: adopt acknowledged and pulled boxes and answers, advance the
// cursor, and drop the session on a 401. A box changed here and not yet sent is the later
// write, so it wins over a pulled one (last write wins) and is sent at the next drain.
function applySync(context, output, enqueue) {
  const { acks = [], boxes = [], answers = [], newCursor, authFailed } = output;
  let settingsChanged = false;
  const newKeys = new Set();

  const adoptAnswer = (server) => {
    if (!KEY.test(str(server?.key))) return;
    const r = answerRecord(server);
    const held = context.answers.get(r.key);
    if (held && JSON.stringify(held) === JSON.stringify(r)) return;
    keepAnswer(context, enqueue, r);
    newKeys.add(r.key);
  };

  for (const { row, result } of acks) {
    const held = context.outbox.get(row.id);
    if (row.kind === "answer") {
      context.outbox.delete(row.id);
      enqueue(() => context.store.outboxDelete(row.id).catch(() => {}));
      // Another device may have answered the same key first; its answer is the one kept.
      adoptAnswer(result);
      continue;
    }
    if (!FIELDS.includes(result?.field)) continue;
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    if (held && sameBox(held, result)) {
      context.outbox.delete(row.id);
      enqueue(() => context.store.outboxDelete(row.id).catch(() => {}));
    } else if (held) {
      const advanced = { ...held, baseVersion: result.version };
      context.outbox.set(row.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    const current = context.boxes.get(result.field);
    const r = current ? { ...current, version: result.version } : boxRecord(result.field, result);
    context.boxes.set(r.field, r);
    enqueue(() => context.store.boxPut(r).catch(() => {}));
  }

  for (const server of boxes) {
    if (!FIELDS.includes(server?.field)) continue;
    const current = context.boxes.get(server.field);
    if (current && server.version <= current.version) continue;
    if (context.outbox.has(`box:${server.field}`)) continue;
    const r = boxRecord(server.field, server);
    context.boxes.set(r.field, r);
    enqueue(() => context.store.boxPut(r).catch(() => {}));
    if (!current || !sameBox(current, r)) settingsChanged = true;
  }

  for (const server of answers) adoptAnswer(server);

  if (settingsChanged) {
    enqueue.emit({ type: "checks.changed", settings: settingsOf(context) });
    restartPause(enqueue, "day", { type: "_dueDay" });
  }
  if (newKeys.size > 0) announceAll(context, enqueue, newKeys);

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
