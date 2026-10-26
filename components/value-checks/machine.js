import { setup, assign, fromPromise, enqueueActions, and } from "xstate";

// The fact component that owns the values checks (3.1): which evaluator checks the value
// lines of the Your values sheet, which checks the examples, and what Jev answered about
// each line. Replicated (5) the way `choice-point-checks` is: local-first, cached in the
// browser, numbering versions itself while signed out and syncing to the per-user server
// when signed in. The settings are one row and the last write wins; an answer is added
// under its key and never changes, so the server ignores a key it already holds. The
// values, the evaluators and whether a Jev key is set are other facts' (4.3, first rule):
// this keeps only what they announced, to know which lines to check. Everything with a
// side effect (the store, the network, the asks) arrives through input, so this stays
// importable in Node. Components never import each other (11.2), so what this shares with
// choice-point-checks (the key, the questions, the answers, the queue) is its own copy.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ANSWER = /^([0-9A-HJKMNP-TV-Z]{26}|yes|no)$/;
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const KEY = /^[0-9a-f]{28}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const isDay = (v) => typeof v === "string" && DAY.test(v);
const str = (v) => (typeof v === "string" ? v : "");
// A line with words: a letter or a digit, in any script. Any other line is never asked.
const worded = (s) => /[\p{L}\p{N}]/u.test(s);

// The two lines of a value, each checked by its own evaluator: which setting names it.
export const LINES = [
  { line: "value", setting: "values" },
  { line: "example", setting: "examples" },
];
// What llm: decide may answer instead of answers; anything else (a bus refusal, a thrown
// ask) is announced as unavailable, the one kind values.checked has for "Jev cannot be reached".
const ERRORS = new Set(["signed-out", "no-key", "bad-key", "rate-limited", "overloaded", "invalid", "busy", "unavailable"]);

// The pause after a settings or evaluator change before the day on screen is checked
// again, so a run of edits in Settings asks once; also how long a busy line waits.
export const CHECK_PAUSE_MS = 1500;
// The pause the network waits for after a change (5), so a run of edits drains once.
const SYNC_IDLE_MS = 2000;

// --- The key of an answer --------------------------------------------------------------

// Two 53-bit cyrb53 runs with different seeds, as 28 hex digits: synchronous, so the
// machine knows at once whether a line is already answered, and the same in the browser,
// in Node and on another device.
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

// The evaluator's id, a question exactly as Jev is asked it, and the text Jev reads:
// change any of them and that question is asked about the line again.
export const keyOf = (evaluatorId, questions, text) => {
  const s = JSON.stringify([evaluatorId, questions, text]);
  return cyrb53(s, 1) + cyrb53(s, 2);
};

// What Jev reads for each line: the value line alone, and the example with the value it
// is an example of, so the example is judged against it.
export const textOf = (line, v) =>
  line === "value" ? v.name.trim() : `${v.name.trim()}. For example: ${v.meaning.trim()}`;
const shownOf = (line, v) => (line === "value" ? v.name : v.meaning);
const hasLine = (line, v) => worded(line === "value" ? v.name : v.meaning);

// --- The questions Jev is asked --------------------------------------------------------

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
// kept in the evaluator but not asked.
export const askedOf = (evaluator) =>
  live(evaluator?.questions)
    .filter((q) => q.on !== false && filled(q.text) && (q.kind !== "pick" || pickable(q)))
    .map(toQuestion);

// Jev's answers in the sheet's terms: for a yes / no question the side Jev leans to, with
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

// --- Records ---------------------------------------------------------------------------

const settingsShape = (s) => ({ values: isId(s?.values) ? s.values : null, examples: isId(s?.examples) ? s.examples : null });
const settingsRecord = (s) => ({
  ...settingsShape(s),
  version: Number.isInteger(s?.version) && s.version >= 1 ? s.version : 1,
});
const sameSettings = (a, b) => JSON.stringify(settingsShape(a)) === JSON.stringify(settingsShape(b));
const settingsOf = (context) => settingsShape(context.settings);

const answerSetting = (a) =>
  a && isId(a.question) && ANSWER.test(str(a.option)) && typeof a.p === "number"
    ? { question: a.question, option: a.option, name: str(a.name), p: Math.min(1, Math.max(0, a.p)) }
    : null;
const answerRecord = (r) => ({ key: r.key, answers: (Array.isArray(r.answers) ? r.answers : []).map(answerSetting).filter(Boolean) });

const valuesOf = (list) =>
  (Array.isArray(list) ? list : []).filter((v) => isId(v?.id)).map((v) => ({ id: v.id, name: str(v.name), meaning: str(v.meaning) }));

// --- What a day's lines are ------------------------------------------------------------

const evaluatorOf = (context, id) => {
  const e = isId(id) ? context.evaluators.get(id) : null;
  return e && !e.removing ? e : null;
};

// Every line with words of every value held for the day, whose line has an evaluator with
// questions to ask, with each question and the key its answer is kept under. Without a Jev
// key there is nothing to check, so nothing is asked and nothing is reported.
function planOf(context, day) {
  const held = context.days.get(day);
  if (!context.keySet || !held) return [];
  const out = [];
  const checkers = LINES.map(({ line, setting }) => {
    const id = context.settings?.[setting];
    const evaluator = evaluatorOf(context, id);
    return { line, id, evaluator, questions: evaluator ? askedOf(evaluator) : [] };
  });
  for (const v of held.values) {
    for (const c of checkers) {
      if (c.questions.length === 0 || !hasLine(c.line, v)) continue;
      const text = textOf(c.line, v);
      out.push({
        id: v.id,
        line: c.line,
        shown: shownOf(c.line, v),
        text,
        evaluator: c.evaluator,
        items: c.questions.map((question) => ({ question, key: keyOf(c.id, [question], text) })),
      });
    }
  }
  return out;
}

const lineOf = (l) => `${l.id}\n${l.line}\n${l.text}`;

// The names of the answers that are not the one their question expects; a question with
// no expected answer has none.
function unexpectedOf(evaluator, answers) {
  const expect = new Map(live(evaluator?.questions).map((q) => [q.id, q.expect]));
  return answers.filter((a) => typeof expect.get(a.question) === "string" && expect.get(a.question) !== a.option).map((a) => a.name);
}

const queuedKey = (context, key) => Boolean(context.asking?.keys.includes(key)) || context.jobs.some((j) => j.keys.includes(key));

// A line with every question answered is done; one with a question queued or being asked
// is waiting for Jev; one whose last check failed is failed. Any other line is still being
// written and is left out, so it shows no mark until the user finishes it.
function report(context, day) {
  let error;
  const byValue = new Map();
  for (const line of planOf(context, day)) {
    const answers = line.items.map((i) => context.answers.get(i.key));
    const missing = line.items.filter((_, n) => !answers[n]);
    const failed = missing.map((i) => context.failures.get(i.key)).find(Boolean);
    const pending = missing.some((i) => queuedKey(context, i.key));
    const known = answers.filter(Boolean);
    if (known.length === 0 && !failed && !pending) continue;
    if (failed && !pending && !error) error = failed;
    const status = missing.length === 0 ? "done" : pending ? "pending" : failed ? "failed" : "done";
    const given = status === "done" ? known.flatMap((a) => a.answers) : [];
    if (!byValue.has(line.id)) byValue.set(line.id, []);
    byValue.get(line.id).push({ line: line.line, text: line.shown, status, answers: given, unexpected: unexpectedOf(line.evaluator, given) });
  }
  const values = [...byValue].map(([id, lines]) => ({ id, lines }));
  return { day, values, ...(error ? { error } : {}) };
}

// Announce a day's lines when they differ from what was last announced for it; a day that
// has never had a checked line is not announced until it has one.
function announce(context, enqueue, day) {
  const r = report(context, day);
  const text = JSON.stringify(r);
  const last = context.reported.get(day);
  if (last === text || (last === undefined && r.values.length === 0 && !r.error)) return;
  context.reported.set(day, text);
  enqueue.emit({ type: "values.checked", ...r });
}

const announceAll = (context, enqueue) => {
  for (const day of context.days.keys()) announce(context, enqueue, day);
};

// --- Checking --------------------------------------------------------------------------

// Queue, for every line of the day (or only those `only` lets through), the questions it
// has no answer to and that are not queued yet, as one Jev request per line; then
// announce the day, so its new lines show as waiting at once.
function check(context, enqueue, day, only = () => true) {
  let added = false;
  for (const line of planOf(context, day)) {
    if (!only(line)) continue;
    const missing = line.items.filter((i) => !context.answers.has(i.key) && !queuedKey(context, i.key));
    if (missing.length === 0) continue;
    for (const item of missing) context.failures.delete(item.key);
    const questions = missing.map((i) => i.question);
    context.jobs.push({ keys: missing.map((i) => i.key), questions, payload: { state: { text: line.text }, questions } });
    added = true;
  }
  announce(context, enqueue, day);
  if (added) enqueue.raise({ type: "_next" });
}

function checkDay(context, enqueue) {
  const day = context.day;
  if (!day) return;
  if (context.days.has(day) && !context.fetching.has(day)) check(context, enqueue, day);
  else fetchDay(context, enqueue, day);
}

// A queued line is still wanted when one of its questions has no answer yet and some held
// day still asks it: a value edited again, a question switched off, or the key removed
// while it waited is not asked about.
function wanted(context, job) {
  const open = job.keys.filter((k) => !context.answers.has(k));
  if (open.length === 0) return false;
  const planned = new Set([...context.days.keys()].flatMap((d) => planOf(context, d).flatMap((l) => l.items.map((i) => i.key))));
  return open.some((k) => planned.has(k));
}

// A row the user finished (values.saved's finished) is marked, line by line, until the
// values as `values` announced them hold that text, because the save and the change it
// leads to may reach this fact in either order. The marked lines are then queued, with
// any line of the day whose last check failed, so a failure is retried at the next
// finished row.
function checkFinished(context, enqueue, day) {
  if (!context.days.has(day) || context.fetching.has(day)) return;
  const marked = planOf(context, day).filter((l) => context.finished.has(lineOf(l)));
  if (marked.length === 0) return;
  const lines = new Set(marked.map(lineOf));
  for (const mark of lines) context.finished.delete(mark);
  check(context, enqueue, day, (l) => lines.has(lineOf(l)) || l.items.some((i) => context.failures.has(i.key)));
}

function finish(context, enqueue, message) {
  if (!isDay(message.day) || !Array.isArray(message.finished)) return;
  const values = new Map(valuesOf(message.values).map((v) => [v.id, v]));
  for (const id of message.finished) {
    const v = values.get(id);
    if (!v) continue;
    for (const { line } of LINES) if (hasLine(line, v)) context.finished.add(`${id}\n${line}\n${textOf(line, v)}`);
  }
  checkFinished(context, enqueue, message.day);
}

const restartPause = (enqueue, id, event) => {
  enqueue.cancel(id);
  enqueue.raise(event, { delay: CHECK_PAUSE_MS, id });
};

const usesEvaluator = (context, id) => LINES.some(({ setting }) => context.settings?.[setting] === id);

// --- The day's values ------------------------------------------------------------------

// A day's values are asked once, when the day is shown or read; today's follow
// values.changed after (4.3, fourth rule).
function fetchDay(context, enqueue, day) {
  if (!isDay(day) || context.fetching.has(day)) return;
  context.fetching.add(day);
  const ask = context.ask;
  enqueue(({ self }) =>
    Promise.resolve()
      .then(() => (typeof ask === "function" ? ask("values", "read", { day }) : null))
      .catch(() => null)
      .then((reply) => self.send({ type: "_values", day, reply })),
  );
}

// The version a values.changed carries is the day's when it was written on or before the
// day and is not older than the version held: the values as they stood on that day.
const fits = (day, held, version) => version.day <= day && (!held?.day || version.day >= held.day);

function follow(context, enqueue, version) {
  context.latest = version;
  for (const [day, held] of context.days) {
    if (context.fetching.has(day) || !fits(day, held, version)) continue;
    context.days.set(day, { day: version.day, values: version.values });
    checkFinished(context, enqueue, day);
    announce(context, enqueue, day);
  }
}

// A day's values arrived: the reads waiting for them are answered, and the day is checked
// (the day on screen) or announced with what it has. A values.changed that landed while
// the read was on its way is newer and wins.
function dayFetched(context, enqueue, { day, reply }) {
  context.fetching.delete(day);
  let held = { day: isDay(reply?.day) ? reply.day : null, values: valuesOf(reply?.values) };
  if (context.latest && fits(day, held, context.latest)) held = { day: context.latest.day, values: context.latest.values };
  context.days.set(day, held);
  const waiting = context.waiting.get(day) ?? [];
  context.waiting.delete(day);
  for (const r of waiting) r(readReply(context, day));
  checkFinished(context, enqueue, day);
  if (day === context.day) check(context, enqueue, day);
  else announce(context, enqueue, day);
}

// --- Settings changes ------------------------------------------------------------------

// The one place the settings change: kept, stored, queued for the server when signed in
// (signed out the version is minted here), and announced.
function commitSettings(context, enqueue, next) {
  const current = context.settings;
  if (current && sameSettings(current, next)) return;
  if (!current && sameSettings({}, next)) return;
  let r = settingsRecord(next);
  if (context.userId == null) r = { ...r, version: current ? current.version + 1 : 1 };
  else if (current) r = { ...r, version: current.version };
  context.settings = r;
  enqueue(() => context.store.settingsPut(r).catch(() => {}));
  if (context.userId != null) {
    const existing = context.outbox.get("settings");
    queueRow(context, enqueue, settingsRow(r, existing ? existing.baseVersion : current ? current.version : null));
    enqueue.raise({ type: "_drain" });
  }
  enqueue.emit({ type: "value-checks.changed", settings: settingsOf(context) });
  restartPause(enqueue, "day", { type: "_dueDay" });
}

const settingsRow = (r, baseVersion) => ({ id: "settings", kind: "settings", ...settingsShape(r), baseVersion });
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

function readReply(context, day) {
  return { keySet: context.keySet, settings: settingsOf(context), values: isDay(day) ? report(context, day).values : [] };
}

// A read of a day whose values are not held yet is answered once they are.
function replyRead(context, enqueue, day, reply) {
  if (isDay(day) && (!context.days.has(day) || context.fetching.has(day))) {
    context.waiting.set(day, [...(context.waiting.get(day) ?? []), reply]);
    return fetchDay(context, enqueue, day);
  }
  reply(readReply(context, day));
}

function keyChanged(context, enqueue, jev) {
  const keySet = jev?.keySet === true;
  if (keySet === context.keySet) return;
  context.keySet = keySet;
  enqueue.assign({ keySet });
  // With a key the day on screen is checked; without one every mark goes.
  if (keySet) checkDay(context, enqueue);
  announceAll(context, enqueue);
}

// Every message from the bus, whether it arrived while ready or was queued while loading.
function handle(context, message, enqueue) {
  switch (message.type) {
    case "read?":
      return replyRead(context, enqueue, message.payload?.day, message.reply);
    case "value-checks.edited":
      return commitSettings(context, enqueue, message);
    case "llm.changed":
      return keyChanged(context, enqueue, message.jev);
    case "values.changed":
      if (!isDay(message.day)) return;
      return follow(context, enqueue, { day: message.day, values: valuesOf(message.values) });
    case "values.saved":
      return finish(context, enqueue, message);
    case "evaluator.changed": {
      const e = message.evaluator;
      if (!isId(e?.id)) return;
      context.evaluators.set(e.id, e);
      // A changed question makes new keys; the day on screen is checked once editing pauses.
      if (usesEvaluator(context, e.id)) restartPause(enqueue, "day", { type: "_dueDay" });
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

// Signing in enqueues the settings and every answer, so what was made signed out becomes
// the account's (5); a different user resets the cursor. The day on screen is checked
// again, so a line that failed for being signed out is asked now.
function applySession(context, userId, enqueue) {
  if (userId === context.userId) return;
  context.userId = userId;
  enqueue.assign({ userId });
  enqueue(() => context.store.metaPut("userId", userId).catch(() => {}));
  if (!userId) return;
  enqueue.assign({ cursor: 0 });
  enqueue(() => context.store.metaPut("cursor", 0).catch(() => {}));
  const s = context.settings;
  if (s && !context.outbox.has("settings")) queueRow(context, enqueue, settingsRow(s, s.version));
  for (const r of context.answers.values()) if (!context.outbox.has(`answer:${r.key}`)) queueRow(context, enqueue, answerRow(r));
  enqueue.raise({ type: "_sync", pull: true });
  checkDay(context, enqueue);
}

const QUEUED_TYPES = [
  "read?",
  "value-checks.edited",
  "llm.changed",
  "values.changed",
  "values.saved",
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
// holds settings or an answer, this copy is emptied and the pull from 0 brings the
// account's; when it holds none, the settings and every answer are queued for it. The mark
// is cleared only once every row is in the outbox; when the account cannot be asked
// (offline), the mark stays and the next load decides.
async function keepFor(store, from, userId, api) {
  if (!from) return;
  if (from !== userId) {
    let held;
    try {
      held = api ? await api.pull(0) : null;
    } catch {
      held = null;
    }
    if (!held || held.error || !Array.isArray(held.answers)) {
      await store.metaPut("userId", userId);
      return;
    }
    if (Number.isInteger(held.settings?.version) || held.answers.some((a) => KEY.test(str(a?.key)))) {
      await store.empty();
    } else {
      const [settings, answers, outbox] = await Promise.all([store.settingsGet(), store.answerAll(), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.id));
      const rows = [
        ...(settings ? [settingsRecord(settings)].map((r) => settingsRow(r, r.version)) : []),
        ...answers.filter((a) => KEY.test(str(a?.key))).map((a) => answerRow(answerRecord(a))),
      ];
      for (const row of rows) if (!queued.has(row.id)) await store.outboxPut(row);
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
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
    hasJob: ({ context }) => context.jobs.some((j) => wanted(context, j)),
  },
  actors: {
    // The cache, who is signed in, whether a Jev key is set, and the evaluators. Missing
    // asks (a Node test) read as signed out, with no key and nothing listed.
    load: fromPromise(async ({ input }) => {
      const { store, ask, api } = input;
      await claim(store, ask, api);
      const asked = (target, name, payload, fallback) =>
        ask ? ask(target, name, payload).catch(() => fallback) : Promise.resolve(fallback);
      const [settings, answers, outbox, cursor, userId] = await Promise.all([
        store.settingsGet(),
        store.answerAll(),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
      ]);
      const [session, evaluators, llm] = await Promise.all([
        asked("session", "read", {}, { userId: null }),
        asked("evaluators", "list", {}, {}),
        asked("llm", "read", {}, {}),
      ]);
      return {
        settings: settings ?? null,
        answers,
        outbox,
        cursor: cursor ?? 0,
        storedUserId: userId ?? null,
        userId: session?.error ? (userId ?? null) : (session?.userId ?? null),
        evaluators: listed(evaluators, "evaluators"),
        keySet: llm?.jev?.keySet === true,
      };
    }),
    // decide is superseded by nothing, so nothing is held for it.
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
    // Empties the local copy in one transaction, outbox and cache together (12). With
    // keep (12) the copy stays and is marked, under the account it came from.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
    // One sync: drain the outbox in id order, then pull what changed since the cursor when
    // asked to. It returns a summary the machine applies; it never emits (4.3).
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
      return { acks, settings: pulled.settings ?? null, answers: pulled.answers, newCursor: pulled.cursor };
    }),
  },
}).createMachine({
  id: "value-checks",
  meta: {
    description:
      "Owns which evaluator checks the value lines of the Your values sheet and which checks " +
      "the examples, and what Jev answered about each line. Each value has two lines: the " +
      "value itself, which Jev reads alone, and its example, which Jev reads together with " +
      "the value as \"<value>. For example: <example>\". A line without words (no letter or " +
      "digit in any script) is never asked. Nothing is asked and nothing is reported unless " +
      "the account has its own Jev key, as `llm` says. The settings are one row, chosen in " +
      "Settings under Your account, where they show only once a Jev key is saved; the last " +
      "write wins, so two devices never conflict. Which questions are asked, and which answer " +
      "each expects, are the evaluator's own; every line's report lists the names of the " +
      "answers that are not the expected one. Each answer is kept per question, under a key " +
      "made of the evaluator's id, the question as it stands and the text Jev read, and never " +
      "changes once written: editing a value asks both its lines again, editing only its " +
      "example asks only the example, and another device reuses the answers. A row is checked " +
      "when the user has finished it and moved on, as the values sheet's save says; the row " +
      "being typed shows no mark until then. The day on screen is checked when it is shown, " +
      "with that day's values, and again after a settings change or a change to a chosen " +
      "evaluator. A line that already has an answer is never asked again. Lines are checked " +
      "one at a time, with one Jev request per line asking every question it has no answer " +
      "to. A failure, such as no Jev key or rate limited, ends the queue and is announced " +
      "with the lines; they are asked again when a row is next finished or the day is next " +
      "shown. When Jev is busy with another request the line waits and is asked again. It " +
      "works signed out and syncs to the account when signed in (section 5).",
    kind: "fact",
    shape: "replicated",
    owns: "which evaluators check the values and their examples, and Jev's answers about each line",
    emits: ["values.checked", "value-checks.changed"],
    asks: ["llm: read", "llm: decide", "evaluators: list", "values: read", "session: read"],
  },
  context: ({ input }) => ({
    store: input.store,
    api: input.api,
    ask: input.ask,
    settings: null, // { values, examples, version }
    answers: new Map(), // key -> { key, answers }
    outbox: new Map(),
    evaluators: new Map(), // as evaluators announced them
    keySet: false, // the account has its own Jev key (llm)
    days: new Map(), // day -> { day: the version's own day, values }
    latest: null, // the last values.changed, today's version
    fetching: new Set(), // days whose values: read is on its way
    waiting: new Map(), // day -> read replies waiting for the day's values
    failures: new Map(), // key -> the error its last check ended with
    finished: new Set(), // lines the user finished that wait to be held here (lineOf)
    reported: new Map(), // day -> the values.checked last announced, as text
    jobs: [],
    asking: null,
    day: null, // the day on screen, from day.shown
    userId: null,
    cursor: 0,
    queued: [],
    leaving: false,
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
            if (o.settings) context.settings = settingsRecord(o.settings);
            for (const a of o.answers) if (KEY.test(str(a?.key))) context.answers.set(a.key, answerRecord(a));
            for (const row of o.outbox) context.outbox.set(row.id, row);
            for (const e of o.evaluators) if (isId(e?.id)) context.evaluators.set(e.id, e);
            context.keySet = o.keySet;
            context.cursor = o.cursor;
            context.userId = o.storedUserId;
            enqueue.assign({ cursor: o.cursor, userId: o.storedUserId, keySet: o.keySet });
            const signedIn = o.userId && o.userId !== o.storedUserId;
            applySession(context, o.userId, enqueue);
            for (const message of context.queued) handle(context, message, enqueue);
            enqueue.assign({ queued: [] });
            if (context.userId && !signedIn) enqueue.raise({ type: "_sync", pull: true });
          }),
        },
        onError: {
          target: "failed",
          actions: enqueueActions(({ context, enqueue }) => {
            for (const message of context.queued) if (message.type === "read?") message.reply(readReply(context, null));
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
        _values: { actions: enqueueActions(({ context, event, enqueue }) => dayFetched(context, enqueue, event)) },
        _dueDay: {
          actions: enqueueActions(({ context, enqueue }) => {
            checkDay(context, enqueue);
            // A line that lost its evaluator leaves nothing to queue, but the marks already
            // announced for it, on any day, must go.
            announceAll(context, enqueue);
          }),
        },
      },
      states: {
        // One request at a time (llm answers a second one busy).
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
            emptying: {
              invoke: {
                src: "empty",
                input: ({ context }) => ({ store: context.store, keep: context.keep, from: context.userId }),
                onDone: { target: "left" },
                onError: { target: "left" },
              },
            },
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
        "read?": { actions: ({ context, event }) => event.reply(readReply(context, null)) },
      },
    },
  },
});

// Jev's reply to the line being asked: one record per question, each kept, queued for the
// server when signed in, and announced. Busy puts the line back at the head of the queue
// to be asked after a pause. Any other failure ends the queue: every line in it fails
// with the same reason, since the next would fail the same way.
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

// Apply a sync's summary: adopt acknowledged and pulled settings and answers, advance the
// cursor, and drop the session on a 401. Settings changed here and not yet sent are the
// later write, so they win over pulled ones (last write wins) and are sent at the next drain.
function applySync(context, output, enqueue) {
  const { acks = [], settings = null, answers = [], newCursor, authFailed } = output;
  let settingsChanged = false;
  let newAnswers = false;

  const adoptAnswer = (server) => {
    if (!KEY.test(str(server?.key))) return;
    const r = answerRecord(server);
    const held = context.answers.get(r.key);
    if (held && JSON.stringify(held) === JSON.stringify(r)) return;
    keepAnswer(context, enqueue, r);
    newAnswers = true;
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
    if (!Number.isInteger(result?.version)) continue;
    // A newer edit made during the sync leaves a newer row, which stays pending on the
    // acknowledged version; otherwise the row is drained.
    if (held && sameSettings(held, result)) {
      context.outbox.delete(row.id);
      enqueue(() => context.store.outboxDelete(row.id).catch(() => {}));
    } else if (held) {
      const advanced = { ...held, baseVersion: result.version };
      context.outbox.set(row.id, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    const r = context.settings ? { ...context.settings, version: result.version } : settingsRecord(result);
    context.settings = r;
    enqueue(() => context.store.settingsPut(r).catch(() => {}));
  }

  if (settings && Number.isInteger(settings.version) && !context.outbox.has("settings")) {
    const current = context.settings;
    if (!current || settings.version > current.version) {
      const r = settingsRecord(settings);
      context.settings = r;
      enqueue(() => context.store.settingsPut(r).catch(() => {}));
      if (!current || !sameSettings(current, r)) settingsChanged = true;
    }
  }

  for (const server of answers ?? []) adoptAnswer(server);

  if (settingsChanged) {
    enqueue.emit({ type: "value-checks.changed", settings: settingsOf(context) });
    restartPause(enqueue, "day", { type: "_dueDay" });
  }
  if (newAnswers) announceAll(context, enqueue);

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
