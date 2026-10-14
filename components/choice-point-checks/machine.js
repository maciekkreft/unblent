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

// The pause a choice point's text must keep before its lines are checked, so a line is
// asked about once it has stopped changing, not while it is typed.
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

// The evaluator's id, its questions exactly as Jev is asked them, and the line: change any
// of them and the line is a new check.
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
export const askedOf = (evaluator) =>
  live(evaluator?.questions)
    .filter((q) => filled(q.text) && (q.kind !== "pick" || pickable(q)))
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

// One box's settings in one fixed shape and key order, so two copies compare equal as text.
const box = (b) => ({
  evaluator: isId(b?.evaluator) ? b.evaluator : null,
  questions: (Array.isArray(b?.questions) ? b.questions : []).map(questionSetting).filter(Boolean),
});
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

// The evaluator that checks a box, with the questions it is asked, or null when the box
// has none, its evaluator is gone or waiting out its undo window, or it has no question
// to ask. Whether it is switched on is the book's Run box's business, not this.
function checkerOf(context, field) {
  const id = context.boxes.get(field)?.evaluator;
  const evaluator = id ? context.evaluators.get(id) : null;
  if (!evaluator || evaluator.removing) return null;
  const questions = askedOf(evaluator);
  return questions.length > 0 ? { evaluator: id, questions } : null;
}

// Every non-empty line of every checked box, with the key its answer is kept under. A line
// is keyed without the spaces around it, so adding one is not a new check.
function planOf(context, cp) {
  const out = [];
  for (const field of FIELDS) {
    const checker = checkerOf(context, field);
    if (!checker) continue;
    for (const text of cp[field].split("\n")) {
      if (text.trim() === "") continue;
      out.push({ field, text, key: keyOf(checker.evaluator, checker.questions, text.trim()), questions: checker.questions });
    }
  }
  return out;
}

// A line with an answer is done, one whose last check failed is failed, and any other is
// waiting for Jev: queued, being asked, or about to be after the pause.
function report(context, cp) {
  let error;
  const lines = planOf(context, cp).map(({ field, text, key }) => {
    const answer = context.answers.get(key);
    const failed = !answer && context.failures.get(key);
    if (failed && !error) error = failed;
    return { field, text, status: answer ? "done" : failed ? "failed" : "pending", answers: answer ? answer.answers : [] };
  });
  return { choicePoint: cp.id, day: cp.day, lines, ...(error ? { error } : {}) };
}

// Announce a choice point's lines when they differ from what was last announced for it; a
// choice point that has never had a checked line is not announced until it has one.
function announce(context, enqueue, cp) {
  const r = report(context, cp);
  const text = JSON.stringify(r);
  const last = context.reported.get(cp.id);
  if (last === text || (last === undefined && r.lines.length === 0 && !r.error)) return;
  context.reported.set(cp.id, text);
  enqueue.emit({ type: "lines.checked", ...r });
}

const announceAll = (context, enqueue, keys) => {
  for (const cp of context.choicePoints.values()) {
    if (!keys || planOf(context, cp).some((l) => keys.has(l.key))) announce(context, enqueue, cp);
  }
};

// --- Checking --------------------------------------------------------------------------

const queuedKey = (context, key) => context.asking?.key === key || context.jobs.some((j) => j.key === key);

// Queue every line of the choice point that has no answer and is not queued yet, then
// announce it, so its new lines show as waiting at once.
function check(context, enqueue, cp) {
  let added = false;
  for (const line of planOf(context, cp)) {
    if (context.answers.has(line.key) || queuedKey(context, line.key)) continue;
    context.failures.delete(line.key);
    context.jobs.push({ key: line.key, questions: line.questions, payload: { state: { text: line.text.trim() }, questions: line.questions } });
    added = true;
  }
  announce(context, enqueue, cp);
  if (added) enqueue.raise({ type: "_next" });
}

function checkDay(context, enqueue) {
  if (!context.day) return;
  for (const cp of context.choicePoints.values()) if (cp.day === context.day) check(context, enqueue, cp);
}

// A queued line is still wanted when it has no answer yet and some choice point still holds
// it: a line edited again, or a choice point removed, while it waited is not asked about.
const wanted = (context, key) =>
  !context.answers.has(key) && [...context.choicePoints.values()].some((cp) => planOf(context, cp).some((l) => l.key === key));

const restartPause = (enqueue, id, event) => {
  enqueue.cancel(id);
  enqueue.raise(event, { delay: CHECK_PAUSE_MS, id });
};

const usesEvaluator = (context, id) => FIELDS.some((f) => context.boxes.get(f)?.evaluator === id);

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

// --- Messages --------------------------------------------------------------------------

function replyRead(context, day, reply) {
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
      return replyRead(context, message.payload?.day, message.reply);
    case "checks.edited":
      if (FIELDS.includes(message.field)) commitBox(context, enqueue, message.field, message);
      return;
    case "choice-point.changed": {
      const c = message.choicePoint;
      if (!isId(c?.id) || !isDay(c?.day)) return;
      const next = choicePoint(c);
      const held = context.choicePoints.get(next.id);
      context.choicePoints.set(next.id, next);
      // A change that leaves the texts as they were (a version, a mark) is no new check.
      if (held && JSON.stringify(held) === JSON.stringify(next)) return;
      restartPause(enqueue, `cp:${next.id}`, { type: "_due", id: next.id });
      return;
    }
    case "choice-point.deleted":
      context.choicePoints.delete(message.id);
      context.reported.delete(message.id);
      enqueue.cancel(`cp:${message.id}`);
      return;
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

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0,
    hasJob: ({ context }) => context.jobs.some((j) => wanted(context, j.key)),
  },
  actors: {
    // The cache, who is signed in, and the evaluators and choice points to know which
    // lines to check. Missing asks (a Node test) read as signed out with nothing listed.
    load: fromPromise(async ({ input }) => {
      const { store, ask } = input;
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
      "under Your account; the last write wins, so two devices never conflict. Each answer " +
      "is kept under a key made of the evaluator's id, its questions as they stand, and the " +
      "line's text, and never changes once written: editing a line hides its old mark until " +
      "the new text is answered, editing the evaluator's questions leads to a new check, and " +
      "another device reuses the answers. A line is checked once its choice point has stopped " +
      "changing for about 1.5 seconds; the day on screen is checked when it is shown, and again " +
      "after a settings change or a change to a box's evaluator. A line that already has an " +
      "answer is never asked again, so opening a day already checked costs nothing. Lines are " +
      "checked one at a time, in a queue, with one Jev request per line that asks all of the " +
      "box's questions together about the line alone; every answer is announced, and which " +
      "marks are shown is decided only when they are shown. Whether the evaluator is switched " +
      "on for its book does not matter here. A failure, such as signed out, no Jev key or " +
      "rate limited, ends the queue and is announced with the lines so the choice point can " +
      "say why; the lines are asked again at the choice point's next change or the next time " +
      "its day is shown. When Jev is busy with another request the line waits and is asked " +
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
    failures: new Map(), // key -> the error its last check ended with
    reported: new Map(), // choice point id -> the lines.checked last announced, as text
    jobs: [],
    asking: null,
    day: null, // the day on screen, from day.shown
    userId: null,
    cursor: 0,
    queued: [],
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
        _due: {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const cp = context.choicePoints.get(event.id);
            if (cp) check(context, enqueue, cp);
          }),
        },
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
                const i = context.jobs.findIndex((j) => wanted(context, j.key));
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
      },
    },
    failed: {
      on: {
        "read?": { actions: ({ context, event }) => event.reply({ settings: settingsOf(context), choicePoints: [] }) },
      },
    },
  },
});

// Jev's reply to the line being asked. An answer is kept, queued for the server when
// signed in, and announced. Busy (another Jev request in flight) puts the line back at the
// head of the queue to be asked after a pause. Any other failure ends the queue: every
// line in it fails with the same reason, since the next would fail the same way.
function decided(context, reply, enqueue) {
  const job = context.asking;
  if (!job) return;
  context.asking = null;
  enqueue.assign({ asking: null });
  if (Array.isArray(reply?.answers)) {
    const r = { key: job.key, answers: answersOf(job.questions, reply.answers) };
    keepAnswer(context, enqueue, r);
    if (context.userId != null) {
      queueRow(context, enqueue, answerRow(r));
      enqueue.raise({ type: "_drain" });
    }
    announceAll(context, enqueue, new Set([job.key]));
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
  for (const j of failed) context.failures.set(j.key, error);
  announceAll(context, enqueue, new Set(failed.map((j) => j.key)));
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
