import { setup, assign, enqueueActions, fromPromise, and } from "xstate";

// The fact component that owns the journal (3.1), replicated (5): its days, its own
// projects and detectors, and Jev's answers. One fact owns them all, so the journal has
// one sync, one server module and one per-user database. journal-entry, where the user
// writes, emits day.saved; the Detectors dock emits the project and detector gestures;
// whoever shows a delete emits removal.started, and notice-stack emits removal.undone or
// removal.settled when the undo window ends (4.3, fifth rule). This fact keeps them,
// stores each changed record, announces the whole journal as journal.changed and answers
// journal: read for the starting picture. The "today only" rule lives here, in how
// day.saved is handled, and nowhere else. While signed out it numbers versions itself,
// as notes does (5). Everything with a side effect (the store, the clock, the ask)
// arrives through `input`, so the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const HOUR = 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD: "today" is the user's day, not UTC's.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// The local midnight that ends `day`. Built from the calendar date, so a day that is 23
// or 25 hours long across a clock change still ends at its own midnight.
const endOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + 1).getTime();
};

// The day that can still be edited at `now`, or null: the one whose date is today, or
// that was edited less than an hour ago, so writing past midnight keeps going in the
// same entry. A new day is only started while none is open, so at most one qualifies;
// the latest edited wins should a clock change ever let two.
export const openDay = (days, now) =>
  days
    .filter((d) => !d.deleted && (d.day === dateOf(now) || now - d.editedAt < HOUR))
    .reduce((a, b) => (a && a.editedAt >= b.editedAt ? a : b), null);

// The earliest moment the open day can close. Only a schedule: whether it is open is
// always decided by openDay, so a clock set back merely re-checks early.
const closesAt = (day) => Math.max(endOf(day.day), day.editedAt + HOUR);

// The paragraphs of a day's text, in order, trimmed. A line break ends a paragraph; while
// the box is being typed in, the line at the end is unfinished, otherwise every paragraph
// is finished.
export const paragraphs = (text, editing) => {
  const lines = text.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t) out.push({ text: t, finished: !editing || i < lines.length - 1 });
  });
  return out;
};

const live = (items) => items.filter((x) => !x.removing && !x.deleted);

// The question as Jev is asked it: its text, and its yes and no words or its options. A
// yes / no question keeps its options for a switch back, but they are not asked, so they
// are not part of its wording; an option being removed is not offered either.
export const wordingOf = (q) =>
  q.kind === "pick"
    ? { text: q.text, yes: "", no: "", options: live(q.options).map((o) => ({ id: o.id, name: o.name })) }
    : { text: q.text, yes: q.yes, no: q.no, options: [] };

// A question llm: decide would accept.
const askable = (q) => q.text.trim() !== "" && (q.kind !== "pick" || live(q.options).length >= 2);

// Every question that reads the writing now: an askable question of a detector that is
// on, in a project that is on.
const onQuestions = ({ projects, detectors }) => {
  const on = new Set(live(projects).filter((p) => p.on).map((p) => p.id));
  return live(detectors)
    .filter((d) => d.on && on.has(d.project))
    .flatMap((d) => live(d.questions).filter(askable));
};

// --- Records --------------------------------------------------------------------------

const option = (o) => (o && isId(o.id) ? { id: o.id, name: str(o.name), description: str(o.description), removing: o.removing === true } : null);

const question = (q) => {
  if (!q || !isId(q.id)) return null;
  return {
    id: q.id,
    kind: q.kind === "pick" ? "pick" : "yesno",
    text: str(q.text),
    yes: str(q.yes),
    no: str(q.no),
    options: (Array.isArray(q.options) ? q.options : []).map(option).filter(Boolean),
    removing: q.removing === true,
  };
};

const version = (v) => (Number.isInteger(v) && v >= 1 ? v : 1);

// `deleted` marks a tombstone (5): kept so a later sync tells other devices, never shown.
const tomb = (r) => (r.deleted === true ? { deleted: true } : {});

// Each record in its stored shape, or null when it has no valid id.
const dayRecord = (d) =>
  d && isId(d.id) && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
    ? { id: d.id, day: d.day, text: str(d.text), editedAt: Number.isInteger(d.editedAt) ? d.editedAt : 0, version: version(d.version), ...tomb(d) }
    : null;

const projectRecord = (p) =>
  p && isId(p.id)
    ? { id: p.id, name: str(p.name), on: p.on !== false, version: version(p.version), removing: p.removing === true, ...tomb(p) }
    : null;

const detectorRecord = (r) =>
  r && isId(r.id) && isId(r.project)
    ? {
        id: r.id,
        project: r.project,
        name: str(r.name),
        on: r.on !== false,
        questions: (Array.isArray(r.questions) ? r.questions : []).map(question).filter(Boolean),
        version: version(r.version),
        removing: r.removing === true,
        ...tomb(r),
      }
    : null;

// An answer is kept by its question's id and its paragraph's text.
const keyOf = (a) => `${a.answer.id}\n${a.text}`;

const answerRecord = (a) =>
  a && typeof a.text === "string" && a.wording && a.answer && isId(a.answer.id) && Number.isInteger(a.at)
    ? { key: keyOf(a), text: a.text, wording: a.wording, answer: a.answer, at: a.at, version: version(a.version), ...tomb(a) }
    : null;

// --- Seeds ----------------------------------------------------------------------------

// The example projects a first visit starts with, with ids of their own: a removal names
// only an id, and each fact recognises only its own, so no other fact's removal can reach
// the journal's detectors. The ids are fixed, so two
// devices seeding the same journal make the same records. `since` is the seed version
// that added a record; it stays in this file and the catch-up.
export const SEED_VERSION = 1;
export const IDS = Object.freeze({
  distortion: "01K7SEED00000000000000JP01",
  goals: "01K7SEED00000000000000JP02",
  distortionDetector: "01K7SEED00000000000000JD01",
  goalOrValue: "01K7SEED00000000000000JD02",
  goalOrValueYesNo: "01K7SEED00000000000000JD03",
  distortionPick: "01K7SEED00000000000000JQ01",
  goalOrValuePick: "01K7SEED00000000000000JQ02",
  isGoal: "01K7SEED00000000000000JQ03",
  isValue: "01K7SEED00000000000000JQ04",
});

const yn = (id, text, yes, no) => ({ id, kind: "yesno", text, yes, no, options: [] });
const opt = (id, name, description) => ({ id, name, description });
const optId = (n) => `01K7SEED00000000000000JC${pad(n)}`;

const PROJECTS = [
  { id: IDS.distortion, name: "Cognitive Distortion", on: true, since: 1 },
  { id: IDS.goals, name: "Goals and values", on: true, since: 1 },
];

const DETECTORS = [
  {
    id: IDS.distortionDetector,
    project: IDS.distortion,
    name: "Cognitive Distortion",
    on: true,
    since: 1,
    questions: [{
      id: IDS.distortionPick,
      kind: "pick",
      text: "What cognitive distortion it is, if any?",
      yes: "",
      no: "",
      options: [
        opt(optId(4), "All-or-nothing thinking", "Seeing things in extremes, with no middle ground."),
        opt(optId(5), "Overgeneralization", "Drawing a broad conclusion from a single event or a small number of events."),
        opt(optId(6), "Mind reading", "Assuming you know what other people are thinking, usually negatively."),
        opt(optId(7), "Fortune telling", "Predicting that something bad will happen and treating the prediction as fact."),
        opt(optId(8), "Catastrophizing", "Expecting the worst possible outcome and struggling to consider more likely alternatives."),
        opt(optId(9), "Emotional reasoning", "Treating feelings as proof that something is true."),
        opt(optId(10), "Should statements", "Rigid rules about how you or other people must behave."),
        opt(optId(11), "Labeling", "Defining yourself or another person by a single characteristic or behavior."),
        opt(optId(12), "Personalization", "Taking excessive responsibility for events that are not entirely within your control."),
        opt(optId(13), "Mental filtering", "Focusing exclusively on negative details while ignoring positive ones."),
      ],
    }],
  },
  {
    id: IDS.goalOrValue,
    project: IDS.goals,
    name: "Goal or value",
    on: true,
    since: 1,
    questions: [{
      id: IDS.goalOrValuePick,
      kind: "pick",
      text: "Is this a goal, a value, or neither?",
      yes: "",
      no: "",
      options: [
        opt(optId(1), "Goal", "Something you can achieve and then it is finished."),
        opt(optId(2), "Value", "An ongoing way of acting that is never finished."),
        opt(optId(3), "Other", "Neither a goal nor a value."),
      ],
    }],
  },
  {
    id: IDS.goalOrValueYesNo,
    project: IDS.goals,
    name: "Goal or value (yes / no)",
    on: false,
    since: 1,
    questions: [
      yn(IDS.isGoal, "Is this a goal?", "it is something you can achieve and then it is finished", "it is never finished, or it is not something to achieve"),
      yn(IDS.isValue, "Is this a value?", "it is an ongoing way of acting that is never finished", "it can be finished, or it is not a way of acting"),
    ],
  },
];

export const SEED = Object.freeze({ projects: PROJECTS.map(projectRecord), detectors: DETECTORS.map(detectorRecord) });

const SOURCES = { projects: [PROJECTS, projectRecord], detectors: [DETECTORS, detectorRecord] };

// A journal stored by an older seed version gains only the seed records a newer version
// added, unless their id is already there; a seed record the user deleted was added by a
// version the journal already had, and its tombstone keeps the id, so it is not brought
// back. Nothing stored is a first visit, version 0, which gains every seed.
export const catchUp = (table, list, version) => {
  const [source, record] = SOURCES[table];
  const have = new Set(list.map((r) => r.id));
  return [...list, ...source.filter((s) => s.since > version && !have.has(s.id)).map(record)];
};

// --- Changes --------------------------------------------------------------------------

// The incoming list with every flagged item of the old list that it left out put back
// after the nearest item before it that is still there, so a save never drops what is
// still in its undo window. An incoming item flagged in the old list stays flagged.
const keepFlagged = (old, incoming) => {
  const flagged = new Set(old.filter((x) => x.removing).map((x) => x.id));
  const out = incoming.map((x) => (flagged.has(x.id) ? { ...x, removing: true } : x));
  old.forEach((x, i) => {
    if (!x.removing || out.some((y) => y.id === x.id)) return;
    const before = old.slice(0, i).reverse().find((p) => out.some((y) => y.id === p.id));
    out.splice(before ? out.findIndex((y) => y.id === before.id) + 1 : 0, 0, x);
  });
  return out;
};

// A record as another device would be told it. The removing marks belong to this tab's
// undo window, so setting or clearing one is not a new version.
const content = (r) => JSON.stringify(r, (k, v) => (k === "removing" || k === "version" ? undefined : v));

// The next list with versions minted locally (5, while signed out): a record whose
// content changed takes the next version; a new one starts at 1.
const mint = (old, next) => {
  const was = new Map(old.map((r) => [r.id, r]));
  return next.map((r) => {
    const o = was.get(r.id);
    if (!o) return { ...r, version: 1 };
    return { ...r, version: content(o) === content(r) ? o.version : o.version + 1 };
  });
};

// A save to the open day, or a new day while none is open. A new day takes today's date
// at its first character, so an empty new day is not a day yet. A save to any other day
// is refused: this is the one place the "today only" rule is kept.
const daySaved = (c, { id, text }, now) => {
  const open = openDay(c.days, now);
  const was = c.days.find((d) => d.id === id);
  if (was) {
    if (open?.id !== id || was.text === text) return null;
    return { days: mint(c.days, c.days.map((d) => (d.id === id ? { ...d, text, editedAt: now } : d))) };
  }
  if (open || text === "") return null;
  return { days: [...c.days, { id, day: dateOf(now), text, editedAt: now, version: 1 }] };
};

const find = (list, id) => list.find((x) => x.id === id);
const alive = (list, id) => {
  const x = find(list, id);
  return x && !x.deleted ? x : null;
};

// A deleted id stays deleted (5): a late save for it does not bring it back.
const projectSaved = (c, { id, name }) => {
  if (find(c.projects, id)?.deleted) return null;
  const projects = alive(c.projects, id)
    ? c.projects.map((p) => (p.id === id ? { ...p, name } : p))
    : [...c.projects, projectRecord({ id, name })];
  return { projects: mint(c.projects, projects) };
};

// Unticking a project keeps each detector's own tick.
const projectSwitched = (c, { id, on }) =>
  alive(c.projects, id) ? { projects: mint(c.projects, c.projects.map((p) => (p.id === id ? { ...p, on } : p))) } : null;

const detectorSwitched = (c, { id, on }) =>
  alive(c.detectors, id) ? { detectors: mint(c.detectors, c.detectors.map((d) => (d.id === id ? { ...d, on } : d))) } : null;

// A detector belongs to one of the journal's projects; a new id adds it there, switched
// on, and a save keeps its tick and whatever of it is still in its undo window.
const detectorSaved = (c, event) => {
  if (!alive(c.projects, event.project) || find(c.detectors, event.id)?.deleted) return null;
  const was = alive(c.detectors, event.id);
  const r = detectorRecord({ ...event, on: was ? was.on : true, removing: was?.removing, version: was?.version });
  if (!was) return { detectors: mint(c.detectors, [...c.detectors, r]) };
  const questions = keepFlagged(
    was.questions,
    r.questions.map((q) => {
      const old = was.questions.find((x) => x.id === q.id);
      return { ...q, options: keepFlagged(old ? old.options : [], q.options) };
    }),
  );
  return { detectors: mint(c.detectors, c.detectors.map((d) => (d.id === r.id ? { ...r, questions } : d))) };
};

// Sets `removing` on the one item of `kind` named by `id`, wherever it sits. A detector
// is a "rubric" in the removal vocabulary. An id that is not one of the journal's own
// matches nothing, so other facts' removals pass by.
const mark = (removing) => (c, { kind, id }) => {
  const set = (x) => (x.id === id && !x.deleted ? { ...x, removing } : x);
  if (kind === "project") return { projects: c.projects.map(set) };
  if (kind === "rubric") return { detectors: c.detectors.map(set) };
  if (kind === "question") return { detectors: c.detectors.map((d) => ({ ...d, questions: d.questions.map(set) })) };
  if (kind === "option")
    return { detectors: c.detectors.map((d) => ({ ...d, questions: d.questions.map((q) => ({ ...q, options: q.options.map(set) })) })) };
  return null;
};

// A settled removal makes a tombstone of a project or a detector, and of every detector
// of a settled project, and drops a question or an option from its detector. Only an
// item still flagged settles: one that was undone, or never removed, stays.
const settle = (c, { kind, id }) => {
  const flagged = (x) => x.id === id && x.removing;
  const bury = (x) => ({ ...x, removing: false, deleted: true });
  if (kind === "project") {
    if (!c.projects.some(flagged)) return null;
    return {
      projects: mint(c.projects, c.projects.map((p) => (flagged(p) ? bury(p) : p))),
      detectors: mint(c.detectors, c.detectors.map((d) => (d.project === id && !d.deleted ? bury(d) : d))),
    };
  }
  if (kind === "rubric") return { detectors: mint(c.detectors, c.detectors.map((d) => (flagged(d) ? bury(d) : d))) };
  const keep = (x) => !flagged(x);
  if (kind === "question") return { detectors: mint(c.detectors, c.detectors.map((d) => ({ ...d, questions: d.questions.filter(keep) }))) };
  if (kind === "option")
    return {
      detectors: mint(c.detectors, c.detectors.map((d) => ({ ...d, questions: d.questions.map((q) => ({ ...q, options: q.options.filter(keep) })) }))),
    };
  return null;
};

// At load no tab can undo anything any more, because the tab that showed the undo
// notice closed, so every leftover flag settles.
const settleAll = (held) => {
  let c = held;
  const apply = (kind, id) => (c = { ...c, ...settle(c, { kind, id }) });
  for (const p of c.projects.filter((x) => x.removing)) apply("project", p.id);
  for (const d of c.detectors.filter((x) => x.removing)) apply("rubric", d.id);
  for (const q of c.detectors.flatMap((d) => d.questions).filter((x) => x.removing)) apply("question", q.id);
  for (const o of c.detectors.flatMap((d) => d.questions.flatMap((q) => q.options)).filter((x) => x.removing)) apply("option", o.id);
  return c;
};

// --- Asking Jev (llm: decide) ---------------------------------------------------------

// decide's errors the journal shows as its reason. "busy" is not one: the queue waits it out.
const ERRORS = ["signed-out", "no-key", "bad-key", "rate-limited", "overloaded", "invalid", "unavailable"];
// The bus's own refusals (no-answerer, invalid-payload, invalid-reply) mean Jev could
// not be asked, which is "unavailable".
const failure = (error) => (ERRORS.includes(error) ? error : "unavailable");

// llm answers busy while another asker's decide is open; the queue tries again after
// this long rather than stopping.
export const BUSY_RETRY_MS = 1000;

const unit = (v) => typeof v === "number" && v >= 0 && v <= 1;

// The one llm: decide payload for one paragraph: every question that is on, each under
// its own id, which is how its answer is kept. An option in its undo window is not offered, as wordingOf leaves it out.
export const payload = (text, questions) => ({
  state: { text },
  questions: questions.map((q) =>
    q.kind === "pick"
      ? {
          id: q.id,
          kind: "pick",
          instructions: q.text,
          options: live(q.options).map((o) => ({ id: o.id, name: o.name, description: o.description })),
        }
      : { id: q.id, kind: "yesno", instructions: q.text, yes: q.yes, no: q.no },
  ),
});

// One answer: p always, and for a pick question the choice,
// every option's probability and how sure Jev is.
const answerOf = (a, id) => {
  const out = { id, p: a.p };
  if (isId(a.choice)) out.choice = a.choice;
  if (Array.isArray(a.probabilities))
    out.probabilities = a.probabilities.filter((x) => isId(x?.id) && unit(x.p)).map((x) => ({ id: x.id, p: x.p }));
  if (unit(a.confidence)) out.confidence = a.confidence;
  return out;
};

// Jev's reply for one paragraph, as one answer record per question it answered, each
// with the wording it was asked with.
export const answersOf = (text, questions, answers, at) => {
  const asked = new Map(questions.map((q) => [q.id, q]));
  const out = new Map();
  for (const a of answers) {
    const q = asked.get(a?.id);
    if (q && unit(a.p)) out.set(q.id, { key: `${q.id}\n${text}`, text, wording: wordingOf(q), answer: answerOf(a, q.id), at });
  }
  return [...out.values()];
};

// Each new answer in place of the one for the same paragraph and question, on the next
// version: answers are last write wins (5).
const replaceAnswers = (answers, added) => {
  const byKey = new Map(added.map((a) => [a.key, a]));
  const out = answers.map((a) => (byKey.has(a.key) ? { ...byKey.get(a.key), version: a.version + 1 } : a));
  const have = new Set(answers.map((a) => a.key));
  return [...out, ...added.filter((a) => !have.has(a.key)).map((a) => ({ ...a, version: 1 }))];
};

// --- The picture ----------------------------------------------------------------------

// Why Jev is not reading the writing, in llm: decide's words, or null when it is. Before
// llm has answered, or with no llm on the page, nobody is known to be signed in. Starter
// requests used up read as no key, because llm then reports the key as not set.
const reason = (c) => {
  if (!c.llm?.signedIn) return "signed-out";
  if (!c.llm.jev?.keySet) return "no-key";
  if (!onQuestions(c).length) return "no-detector";
  return c.error;
};

// A paragraph some question on now has not answered with its current wording.
const missing = (text, questions, answers) =>
  questions.some((q) => {
    const a = answers.get(`${q.id}\n${text}`);
    return !a || !same(a.wording, wordingOf(q));
  });

// A day's finished paragraphs that some question on now has not answered with its
// current wording: what Judge this day would send.
const unanswered = (day, editing, questions, answers) => {
  const out = [];
  for (const { text, finished } of paragraphs(day.text, editing)) {
    if (finished && !out.includes(text) && missing(text, questions, answers)) out.push(text);
  }
  return out;
};

// The open day's last line is still being written, so it is not finished yet, unless the
// last save said the writing box was left.
const editing = (c, open, day) => day.id === open?.id && c.left !== day.id;

const answersByKey = (c) => new Map(c.answers.filter((a) => !a.deleted).map((a) => [a.key, a]));

// The paragraphs Jev is to be asked about, in order: the one being asked, then the open
// day's unanswered paragraphs, then those Judge this day asked for that are still
// unanswered. A paragraph is asked once however many days hold it, because its answers
// are kept by its text. Nothing waits while Jev cannot be asked.
const queued = (c, open = openDay(c.days, c.now()), questions = onQuestions(c), byKey = answersByKey(c)) => {
  const out = c.asking ? [c.asking.text] : [];
  if (reason(c) !== null) return out;
  const add = (t) => !out.includes(t) && out.push(t);
  if (open) unanswered(open, editing(c, open, open), questions, byKey).forEach(add);
  c.requested.filter((t) => missing(t, questions, byKey)).forEach(add);
  return out;
};

const shown = ({ deleted, ...r }) => r;

const body = (c) => {
  const open = openDay(c.days, c.now());
  const questions = onQuestions(c);
  const byKey = answersByKey(c);
  const asked = queued(c, open, questions, byKey);
  const wordings = new Map(live(c.detectors).flatMap((d) => live(d.questions).map((q) => [q.id, wordingOf(q)])));
  return {
    days: c.days
      .filter((d) => !d.deleted)
      .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id))
      .map((d) => ({
        id: d.id,
        day: d.day,
        text: d.text,
        editedAt: d.editedAt,
        version: d.version,
        waiting: [...new Set(paragraphs(d.text, false).map((p) => p.text))].filter((t) => asked.includes(t)),
        unanswered: unanswered(d, editing(c, open, d), questions, byKey),
      })),
    projects: c.projects.filter((p) => !p.deleted).map(shown),
    detectors: c.detectors.filter((d) => !d.deleted).map(shown),
    answers: c.answers.filter((a) => !a.deleted).map(({ key, version: _, deleted: __, ...a }) => ({
      ...a,
      earlier: wordings.has(a.answer.id) && !same(wordings.get(a.answer.id), a.wording),
    })),
    open: open?.id ?? null,
    reason: reason(c),
  };
};

// --- The actor ------------------------------------------------------------------------

// Each record kind and the field that keys it; an answer has no id of its own.
const KEY = { days: "id", projects: "id", detectors: "id", answers: "key" };
const TABLES = Object.keys(KEY);
const idOf = (table, r) => r[KEY[table]];
// A record's row in the outbox: one per kind and id.
const rowKey = (table, r) => `${table}\n${idOf(table, r)}`;
const normal = { days: dayRecord, projects: projectRecord, detectors: detectorRecord, answers: answerRecord };

// Stores every record that differs from what was held, so a keystroke writes one day,
// not the journal.
const persist = (store, held, next, enqueue) => {
  for (const table of TABLES) {
    if (!next[table]) continue;
    const was = new Map(held[table].map((r) => [idOf(table, r), r]));
    for (const r of next[table]) if (!same(was.get(idOf(table, r)), r)) enqueue(() => store.put(table, r).catch(() => {}));
  }
};

// The open day closes by time alone, once its date has passed and an hour after its last
// edit, with nobody acting, so a timer wakes the fact then to re-check it and announce
// the closing. It is re-armed after every change, since an edit moves the moment.
const arm = (enqueue, days, now) => {
  enqueue.cancel("close");
  const open = openDay(days, now);
  // setTimeout fires at once past 2^31 ms, so a clock set far back would otherwise spin.
  if (open) enqueue.raise({ type: "_close" }, { id: "close", delay: Math.min(closesAt(open) - now, 2 ** 31 - 1) });
};

const announce = (enqueue, c) => {
  const picture = body(c);
  enqueue.assign({ open: picture.open });
  enqueue.emit({ type: "journal.changed", ...picture });
};

// --- The outbox (5) -------------------------------------------------------------------

// What the server keeps of a record: not its version (the server's to assign), the tab's
// undo marks, the tombstone flag (sent beside it) or an answer's key (the server keys an
// answer by its question and its text).
const DROPPED = new Set(["removing", "version", "deleted", "key"]);
const wire = (r) => JSON.parse(JSON.stringify(r, (k, v) => (DROPPED.has(k) ? undefined : v)));

// One outbox for every kind, so three offline edits of a record become one write. The base stays the one the first unsynced change was on, which is
// what the server compares a day's write against.
const enqueueRow = (c, enqueue, table, r, base) => {
  const key = rowKey(table, r);
  const existing = c.outbox.get(key);
  const row = { key, table, record: wire(r), baseVersion: existing ? existing.baseVersion : base };
  if (r.deleted) row.deleted = true;
  c.outbox.set(key, row);
  enqueue(() => c.store.outboxPut(row).catch(() => {}));
};

// Queues every record whose content changed between `held` and `next`.
const enqueueChanges = (c, enqueue, held, next) => {
  for (const table of TABLES) {
    if (!next[table]) continue;
    const was = new Map(held[table].map((r) => [idOf(table, r), r]));
    for (const r of next[table]) {
      const old = was.get(idOf(table, r));
      if (!old || content(old) !== content(r)) enqueueRow(c, enqueue, table, r, old ? old.version : null);
    }
  }
};

// An example record nobody has changed. Every device seeds the same ids, so uploading one
// would overwrite, last write wins, a change the account already holds for it; the
// account's own copy, pulled, is always newer.
const SEEDS = new Map([...SEED.projects, ...SEED.detectors].map((r) => [r.id, r]));
const untouchedSeed = (r) => r.version === 1 && SEEDS.has(r.id) && content(SEEDS.get(r.id)) === content(r);

// Signing in makes the journal kept in this browser the account's (5): every record,
// tombstones too, goes up, and one the server has never seen goes on the version this
// browser numbered, so the server continues its history. A day's row pinned to a
// version the server gave keeps that base, so an edit made while signed out is still
// compared with what the server holds; the other kinds are last write wins, so their
// base only numbers a record the server has not seen. The pull starts over for the new
// user.
const adopt = (c, enqueue, userId) => {
  enqueue.assign({ userId, cursor: 0 });
  enqueue(() => c.store.metaPut("userId", userId).catch(() => {}));
  enqueue(() => c.store.metaPut("cursor", 0).catch(() => {}));
  for (const table of TABLES) {
    for (const r of c[table]) {
      const key = rowKey(table, r);
      const row = c.outbox.get(key);
      if ((table === "days" && row?.baseVersion != null) || (!row && untouchedSeed(r))) continue;
      if (!row) {
        enqueueRow(c, enqueue, table, r, r.version);
        continue;
      }
      const adopted = { ...row, baseVersion: r.version };
      c.outbox.set(key, adopted);
      enqueue(() => c.store.outboxPut(adopted).catch(() => {}));
    }
  }
  enqueue.raise({ type: "_sync", pull: true });
};

// Signed in, the versions are the server's: a change keeps the version it was made on
// until the server acknowledges it, rather than the one minted for a signed-out journal.
const unmint = (c, change) =>
  Object.fromEntries(
    Object.entries(change).map(([table, list]) => {
      const was = new Map(c[table].map((r) => [idOf(table, r), r]));
      return [table, list.map((r) => (was.has(idOf(table, r)) ? { ...r, version: was.get(idOf(table, r)).version } : r))];
    }),
  );

// Applies a candidate change: record lists, and the asking state beside them. Only a
// record that changed is stored, and the journal is announced only when a reader would
// see something new, so a repeat stores and emits nothing. A changed record is queued in
// the outbox signed in or not, so its row keeps the last version the server gave as its
// base; only signed in is a drain asked for.
const update = (context, enqueue, change) => {
  let records = Object.fromEntries(TABLES.filter((t) => change[t] && !same(change[t], context[t])).map((t) => [t, change[t]]));
  const rest = Object.fromEntries(Object.entries(change).filter(([k]) => !TABLES.includes(k)));
  const changed = Object.keys(records).length > 0;
  if (changed) {
    if (context.userId) records = unmint(context, records);
    enqueueChanges(context, enqueue, context, records);
    if (context.userId) enqueue.raise({ type: "_drain" });
    persist(context.store, context, records, enqueue);
    arm(enqueue, records.days ?? context.days, context.now());
  }
  const next = { ...context, ...records, ...rest };
  enqueue.assign({ ...records, ...rest });
  if (changed || !same(body(next), body(context))) announce(enqueue, next);
};

// Each gesture becomes a candidate change, or null.
const commit = (next) =>
  enqueueActions(({ context, event, enqueue }) => {
    const change = next(context, event, context.now());
    if (change) update(context, enqueue, change);
  });

// A gesture that may give Jev something new to read starts a queue an error stopped.
const resuming = (next) => (c, event, now) => ({ ...next(c, event, now), error: null });

// A save says whether the writing box was left, which finishes its last paragraph.
const saved = resuming((c, event, now) => ({ ...daySaved(c, event, now), left: event.left === true ? event.id : null }));

// Judge this day queues the day's paragraphs not answered with the current wording; a
// paragraph already queued is not queued twice.
const judgeDay = resuming((c, { id }) => {
  const day = alive(c.days, id);
  if (!day) return {};
  const texts = unanswered(day, editing(c, openDay(c.days, c.now()), day), onQuestions(c), answersByKey(c));
  return { requested: [...c.requested, ...texts.filter((t) => !c.requested.includes(t))] };
});

// Applies a sync's summary: the acknowledged records, the conflicts, what was pulled,
// the cursor, and a session the server no longer knows.
const applySync = (context, output, enqueue) => {
  const { acks = [], conflicts = [], pulled = {}, newCursor, authFailed } = output;
  const lists = Object.fromEntries(TABLES.map((t) => [t, [...context[t]]]));
  const held = (table, id) => lists[table].find((r) => idOf(table, r) === id);
  const keep = (table, r) => {
    const id = idOf(table, r);
    const i = lists[table].findIndex((x) => idOf(table, x) === id);
    if (i < 0) lists[table].push(r);
    else lists[table][i] = r;
  };
  // A record from the server, keeping this tab's undo mark on it.
  const adopted = (table, record) => {
    const r = normal[table](record);
    const was = r && held(table, idOf(table, r));
    return r && was?.removing ? { ...r, removing: true } : r;
  };
  const dropRow = (key) => {
    context.outbox.delete(key);
    enqueue(() => context.store.outboxDelete(key).catch(() => {}));
  };

  for (const { row, record } of acks) {
    const r = adopted(row.table, record);
    if (!r) continue;
    const current = context.outbox.get(row.key);
    // Drained when the server holds what is pending now; a change made during the sync
    // leaves a newer row, which stays and moves its base to the acknowledged version.
    // A record the server holds as a tombstone is gone whatever was pending (5).
    const drained =
      current && (r.deleted || (same(current.record, row.record) && Boolean(current.deleted) === Boolean(row.deleted)));
    if (drained) dropRow(row.key);
    else if (current) {
      const advanced = { ...current, baseVersion: r.version };
      context.outbox.set(row.key, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    const was = held(row.table, idOf(row.table, r));
    keep(row.table, drained || !was ? r : { ...was, version: r.version });
  }

  // Only a day conflicts: its text was written on a version another device had moved
  // past. The server's copy is kept and both copies are announced, so a view can show
  // the user what they wrote rather than lose it.
  for (const { row, record } of conflicts) {
    const theirs = adopted("days", record);
    if (!theirs) continue;
    const mine = context.outbox.get(row.key) ?? row;
    dropRow(row.key);
    keep("days", theirs);
    enqueue.emit({
      type: "journal.conflicted",
      id: theirs.id,
      mine: { text: mine.record.text, baseVersion: mine.baseVersion },
      theirs: { text: theirs.text, version: theirs.version, editedAt: theirs.editedAt },
    });
  }

  for (const table of TABLES) {
    for (const record of pulled[table] ?? []) {
      const r = adopted(table, record);
      if (!r) continue;
      const was = held(table, idOf(table, r));
      if (was && r.version <= was.version) continue;
      // A delete always wins (5): a live copy never brings back a local tombstone.
      if (was?.deleted && !r.deleted) continue;
      // A change still in the outbox goes up next: a day's comes back as a conflict
      // carrying this copy, the other kinds' overwrite it, last write wins.
      if (context.outbox.has(rowKey(table, r))) continue;
      keep(table, r);
    }
  }

  const change = Object.fromEntries(TABLES.filter((t) => !same(lists[t], context[t])).map((t) => [t, lists[t]]));
  if (Object.keys(change).length) {
    persist(context.store, context, change, enqueue);
    enqueue.assign(change);
    announce(enqueue, { ...context, ...change });
    const now = context.now();
    arm(enqueue, change.days ?? context.days, now);
  }
  if (newCursor !== undefined) {
    enqueue.assign({ cursor: newCursor });
    enqueue(() => context.store.metaPut("cursor", newCursor).catch(() => {}));
  }
  if (authFailed) {
    enqueue.assign({ userId: null });
    enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
  }
};

// The llm picture matters here only for the reason and what that lets Jev read, so it
// is announced only when those change. News from llm (a key added, a sign-in) starts a
// queue an error stopped.
const follow = (picture) =>
  enqueueActions(({ context, event, enqueue }) => {
    const llm = picture(event);
    if (!llm || typeof llm.signedIn !== "boolean") return;
    update(context, enqueue, { llm, error: null });
  });

const GESTURES = {
  "day.saved": saved,
  "day.judging.requested": judgeDay,
  "detector-project.saved": resuming(projectSaved),
  "detector-project.switched": resuming(projectSwitched),
  "detector.saved": resuming(detectorSaved),
  "detector.switched": resuming(detectorSwitched),
  "removal.started": mark(true),
  "removal.undone": mark(false),
  "removal.settled": settle,
};

// What llm: decide's reply was: answers, busy (another asker's decide is open), or an error.
const answered = ({ event }) => Array.isArray(event.output?.answers);
const busy = ({ event }) => event.output?.error === "busy";

// A reply lands: each answer replaces the earlier one for its paragraph and question, and
// the paragraph leaves Judge this day's queue. A reply that leaves out a question asked
// would leave the paragraph unanswered and asked again at once, so it stops the queue.
const landed = enqueueActions(({ context, event, enqueue }) => {
  const { text, questions } = context.asking;
  const added = answersOf(text, questions, event.output.answers, context.now());
  if (added.length < questions.length) return stop(context, enqueue, "unavailable");
  update(context, enqueue, {
    answers: replaceAnswers(context.answers, added),
    asking: null,
    requested: context.requested.filter((t) => t !== text),
  });
});

// An error stops the queue and keeps the reason; Judge this day's paragraphs are dropped,
// the open day's come back with the next gesture that resumes it.
const stop = (context, enqueue, error) => update(context, enqueue, { asking: null, requested: [], error: failure(error) });

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

// What arrived while the store loaded, replayed in order once it is ready.
const replay = (context, enqueue) => {
  for (const message of context.queued) enqueue.raise(message);
  enqueue.assign({ queued: [] });
};

// The pause in typing the network waits for (5): a save restarts the window, so a run of
// saves drains once, as one coalesced write per record, after the typing stops. A load,
// a sign-in, a tab regaining focus or going to the background does not wait.
const SYNC_IDLE_MS = 2000;

export const machine = setup({
  guards: {
    syncable: ({ context }) => Boolean(context.userId) && context.api != null,
    // A pull is always worth the round trip; a bare drain only when the outbox holds something.
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0,
  },
  actors: {
    load: fromPromise(async ({ input: { store, ask } }) => {
      const [days, projects, detectors, answers, outbox, seed, cursor, userId, session] = await Promise.all([
        store.all("days"),
        store.all("projects"),
        store.all("detectors"),
        store.all("answers"),
        store.outboxAll(),
        store.metaGet("seed"),
        store.metaGet("cursor"),
        store.metaGet("userId"),
        // Who is signed in now. Without an answer (no session on the page, or a Node
        // test without one) the user this browser last synced for is assumed.
        ask ? ask("session", "read", {}).catch(() => null) : null,
      ]);
      const known = session && typeof session === "object" && "userId" in session;
      return {
        days,
        projects,
        detectors,
        answers,
        outbox,
        seed: Number.isInteger(seed) ? seed : 0,
        cursor: Number.isInteger(cursor) ? cursor : 0,
        stored: userId ?? null,
        userId: known ? session.userId : userId ?? null,
      };
    }),
    decide: fromPromise(({ input }) => input.ask("llm", "decide", input.payload)),
    // No llm on the page, or a Node test without an ask, reads as nobody signed in.
    llm: fromPromise(({ input }) => (input.ask ? input.ask("llm", "read", {}) : Promise.resolve(null))),
    // One sync: drain the outbox, then pull what changed since the cursor. It returns a
    // summary the machine applies and never emits (4.3). A network error stops it with
    // what it had; 401 reports the session is gone. A drained row is deleted from the
    // store here, so it is durably gone; one changed during the sync is put back.
    sync: fromPromise(async ({ input: { api, store, rows, cursor, pull } }) => {
      const acks = [];
      const conflicts = [];
      for (const row of [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
        let result;
        try {
          result = await api.put(row);
        } catch {
          return { acks, conflicts, networkError: true };
        }
        if (result.error === "unauthorized") return { acks, conflicts, authFailed: true };
        await store.outboxDelete(row.key).catch(() => {});
        (result.conflict ? conflicts : acks).push({ row, record: result.record });
      }
      // A save-triggered drain does not pull: nothing this device needs changed on the
      // server, and a pull per pause in typing would be a poll (5).
      if (!pull) return { acks, conflicts };
      let pulled;
      try {
        pulled = await api.pull(cursor);
      } catch {
        return { acks, conflicts, networkError: true };
      }
      if (pulled.error === "unauthorized") return { acks, conflicts, authFailed: true };
      const { cursor: newCursor, ...records } = pulled;
      return { acks, conflicts, pulled: records, newCursor };
    }),
  },
}).createMachine({
  id: "journal",
  meta: {
    description:
      "Owns the journal: one entry per day, the journal's own projects and detectors, and what " +
      "Jev answered. It works offline and syncs to the account when signed in, the same way notes " +
      "do; signed out it is kept in this browser, and signing in moves it to the account. A day's " +
      "date is the local date when its first character was typed and never changes. Only one " +
      "day can be edited: the one whose date is today, or that was edited less than an hour ago, " +
      "so writing past midnight keeps going in the same entry; a save to any other day is " +
      "refused. When no day can be edited, the journal opens an empty page for today. A " +
      "detector reads the writing only when " +
      "it and its project are both ticked, and unticking a project keeps each detector's own " +
      "tick. A first visit starts with two example projects, \"Cognitive Distortion\" and " +
      "\"Goals and values\". Deleting a project or a detector, or removing a question or an " +
      "option, waits out the undo window. Each finished paragraph of the open day is sent to " +
      "Jev once, in one request carrying every question that is on, one paragraph at a time; a " +
      "paragraph that already has answers with the current wording is never sent again. Every " +
      "answer keeps the wording of the question it answered. Rewording a question re-asks " +
      "today's paragraphs; earlier days keep their answers, marked as an earlier wording, and " +
      "are asked only when the user presses Judge this day. A failed request stops the queue " +
      "and keeps the reason; the next save, Judge this day, change to the detectors, sign-in " +
      "or change in Settings starts it again. While another request to Jev is open, the " +
      "journal waits its turn.",
    kind: "fact",
    shape: "replicated",
    owns: "the journal's days, its projects and detectors, and Jev's answers",
    emits: ["journal.changed", "journal.conflicted"],
    asks: ["session: read", "llm: read", "llm: decide"],
  },
  context: ({ input }) => ({
    days: [],
    projects: [],
    detectors: [],
    answers: [],
    llm: null,
    // Why the last request failed, in decide's words; it stops the queue until a gesture.
    error: null,
    // The paragraph being asked, with the questions as they were asked; the paragraphs
    // Judge this day asked for, in order; and the day whose writing box was left.
    asking: null,
    requested: [],
    left: null,
    open: null,
    userId: null,
    cursor: 0,
    outbox: new Map(),
    queued: [],
    // What a trigger that arrives mid-sync is owed: resync means sync again, pull
    // whether that next sync must also pull.
    resync: false,
    pull: false,
    store: input.store,
    now: input.now,
    ask: input.ask,
    api: input.api,
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
            const { output } = event;
            const before = {
              days: output.days.map(dayRecord).filter(Boolean),
              projects: catchUp("projects", output.projects.map(projectRecord).filter(Boolean), output.seed),
              detectors: catchUp("detectors", output.detectors.map(detectorRecord).filter(Boolean), output.seed),
              answers: output.answers.map(answerRecord).filter(Boolean),
            };
            const held = settleAll(before);
            persist(context.store, output, held, enqueue);
            if (output.seed < SEED_VERSION) enqueue(() => context.store.metaPut("seed", SEED_VERSION).catch(() => {}));
            const outbox = new Map(output.outbox.map((row) => [row.key, row]));
            const c = { ...context, ...held, outbox };
            const { userId } = output;
            // A removal settled at load is a change like any other, and goes up.
            enqueueChanges(c, enqueue, before, held);
            const now = context.now();
            enqueue.assign({ ...held, outbox, userId, cursor: output.cursor, open: openDay(held.days, now)?.id ?? null });
            arm(enqueue, held.days, now);
            // Signed in since this browser last synced, perhaps in another tab, is a
            // sign-in like any other.
            if (userId && userId !== output.stored) adopt(c, enqueue, userId);
            else if (userId) enqueue.raise({ type: "_sync", pull: true });
            replay(context, enqueue);
          }),
        },
        // A store that cannot open still takes writing for this page, rather than
        // refusing every keystroke.
        onError: {
          target: "ready",
          actions: enqueueActions(({ context, enqueue }) => {
            enqueue.assign({ projects: structuredClone(SEED.projects), detectors: structuredClone(SEED.detectors) });
            replay(context, enqueue);
          }),
        },
      },
      on: {
        ...Object.fromEntries(Object.keys(GESTURES).map((type) => [type, { actions: queue }])),
        "session.changed": { actions: queue },
        "llm.changed": { actions: assign({ llm: ({ event }) => event }) },
        "read?": { actions: queue },
      },
    },
    // Two regions: syncing with the server, and asking Jev, each at its own pace.
    ready: {
      type: "parallel",
      invoke: {
        src: "llm",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: { actions: follow((event) => event.output) },
      },
      on: {
        ...Object.fromEntries(Object.entries(GESTURES).map(([type, next]) => [type, { actions: commit(next) }])),
        "llm.changed": { actions: follow((event) => event) },
        // The outbox drains only while someone is signed in (5); signing out keeps it,
        // to go up at the next sign-in.
        "session.changed": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            update(context, enqueue, { error: null });
            if (event.userId === context.userId) return;
            if (event.userId) return adopt(context, enqueue, event.userId);
            enqueue.assign({ userId: null });
            enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
          }),
        },
        _close: {
          actions: enqueueActions(({ context, enqueue }) => {
            const now = context.now();
            if ((openDay(context.days, now)?.id ?? null) !== context.open) announce(enqueue, context);
            arm(enqueue, context.days, now);
          }),
        },
        "read?": { actions: ({ context, event }) => event.reply(body(context)) },
      },
      states: {
        sync: {
          initial: "idle",
          states: {
            idle: {
              on: {
                _drain: { guard: "syncable", target: "debouncing" },
                _sync: { guard: and(["syncable", "needed"]), target: "syncing" },
              },
            },
            // A _drain re-enters this state, which restarts the window, so the drain waits
            // until typing has paused for all of it. Signed out mid-window, it returns to
            // idle rather than sync with no user.
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
                // pull comes from the triggering event: the entry assign above runs before
                // the input is read and would otherwise wipe it from context.
                input: ({ context, event }) => ({
                  api: context.api,
                  store: context.store,
                  rows: [...context.outbox.values()],
                  cursor: context.cursor,
                  pull: Boolean(event.pull),
                }),
                onDone: {
                  target: "idle",
                  actions: [
                    enqueueActions(({ context, event, enqueue }) => applySync(context, event.output, enqueue)),
                    // A trigger that arrived mid-sync is owed a follow-up, unless the session
                    // went away or the network failed, when the next trigger retries. A focus
                    // mid-sync syncs at once with its pull; a save mid-sync waits out the window.
                    enqueueActions(({ context, event, enqueue }) => {
                      const { authFailed, networkError } = event.output;
                      if (authFailed || networkError) return;
                      if (context.resync) enqueue.raise({ type: "_sync", pull: context.pull });
                      else if (context.outbox.size > 0) enqueue.raise({ type: "_drain" });
                    }),
                  ],
                },
                onError: { target: "idle" },
              },
              on: {
                _sync: { actions: assign({ resync: true, pull: ({ context, event }) => context.pull || Boolean(event.pull) }) },
              },
            },
          },
        },
        // One paragraph asked at a time, in order, because llm keeps one decide open.
        jev: {
          initial: "idle",
          states: {
            idle: {
              always: { guard: ({ context }) => queued(context).length > 0, target: "asking" },
            },
            asking: {
              entry: enqueueActions(({ context, enqueue }) =>
                update(context, enqueue, { asking: { text: queued(context)[0], questions: onQuestions(context) } }),
              ),
              invoke: {
                src: "decide",
                input: ({ context }) => ({ ask: context.ask, payload: payload(context.asking.text, context.asking.questions) }),
                onDone: [
                  { guard: answered, target: "idle", actions: landed },
                  { guard: busy, target: "pausing", actions: enqueueActions(({ context, enqueue }) => update(context, enqueue, { asking: null })) },
                  { target: "idle", actions: enqueueActions(({ context, event, enqueue }) => stop(context, enqueue, event.output?.error)) },
                ],
                onError: { target: "idle", actions: enqueueActions(({ context, enqueue }) => stop(context, enqueue, "unavailable")) },
              },
            },
            // Another asker's decide is open; the paragraph stays queued and is tried again.
            pausing: {
              after: { [BUSY_RETRY_MS]: { target: "idle" } },
            },
          },
        },
      },
    },
  },
});
