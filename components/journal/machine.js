import { setup, enqueueActions, fromPromise, and, assign } from "xstate";
import { ulid } from "ulid";

// The fact component that owns the journal (3.1), replicated (5): its days. journal-entry,
// where the user writes, emits day.saved (4.3, fifth rule); this fact keeps it, stores
// each changed day, announces the whole journal as journal.changed and answers
// journal: read for the starting picture. The "today only" rule lives here, in how
// day.saved is handled, and nowhere else. While signed out it numbers versions itself,
// as notes does (5). Everything with a side effect (the store, the clock, the ask)
// arrives through `input`, so the machine is a pure definition importable in Node.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v) => typeof v === "string" && ULID.test(v);
const str = (v) => (typeof v === "string" ? v : "");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A journal day ends at this local hour of the next night (13, Journal). The one copy of
// the rule: every other part takes today from journal.changed's `today`.
export const DAY_ENDS = 2;

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD: "today" is the user's day, not UTC's.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Today's journal day at `now`: the calendar date, or the one before it until DAY_ENDS.
export const todayOf = (ms) => (new Date(ms).getHours() < DAY_ENDS ? dateOf(new Date(ms).setHours(-1, 0, 0, 0)) : dateOf(ms));

// The local DAY_ENDS that ends `day`, the night after it. Built from the calendar date, so
// a day that is 23 or 25 hours long across a clock change still ends at its own hour.
const endOf = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d + 1, DAY_ENDS).getTime();
};

// --- Two days of one date --------------------------------------------------------------

// One device never starts a second day beside the open one, but two devices can each
// start the same date offline, and a journal added to an account can hold a date the
// account already has; each record keeps its own id, so both arrive live. The journal
// still shows one day per date: the newest, while the other waits for the user to keep
// one of the two (journal.conflicted).
const newest = (a, b) => (a.editedAt !== b.editedAt ? b.editedAt - a.editedAt : a.id < b.id ? 1 : -1);

// The live records of each date, newest first.
const byDate = (days) => {
  const dates = new Map();
  for (const d of days) {
    if (d.deleted) continue;
    if (!dates.has(d.day)) dates.set(d.day, []);
    dates.get(d.day).push(d);
  }
  for (const list of dates.values()) list.sort(newest);
  return dates;
};

// The days with a second record of a date that holds nothing the user could lose
// deleted: an empty one beside a written one, and a copy of the same text, the newest
// kept. Both stay as tombstones (5), so nothing is gone from the server.
export const tidy = (days) => {
  const gone = new Set();
  for (const list of byDate(days).values()) {
    if (list.length < 2) continue;
    const written = list.filter((d) => d.text !== "");
    const keep = written.length ? written : list.slice(0, 1);
    const texts = new Set();
    for (const d of list) {
      if (!keep.includes(d) || texts.has(d.text)) gone.add(d.id);
      else texts.add(d.text);
    }
  }
  return gone.size ? days.map((d) => (gone.has(d.id) ? { ...d, deleted: true } : d)) : days;
};

// The days the journal shows: live, one per date, the newest.
export const visible = (days) => [...byDate(tidy(days)).values()].map((list) => list[0]);

// Two written records of one date, or null: the newest, which the journal shows, and
// the next, which waits for the user's choice.
export const clashOn = (days, date) => {
  const list = byDate(tidy(days)).get(date) ?? [];
  return list.length > 1 ? { kept: list[0], other: list[1] } : null;
};

// The day that can still be edited at `now`, or null: the one whose date is today's
// journal day, so writing past midnight keeps going in the same entry until DAY_ENDS.
// Two records of one date can both arrive (clashOn); the latest edited wins.
export const openDay = (days, now) =>
  visible(days)
    .filter((d) => d.day === todayOf(now))
    .reduce((a, b) => (a && a.editedAt >= b.editedAt ? a : b), null);

// The next moment today's journal day ends. Only a schedule: what is open is always
// decided by openDay, so a clock set back merely re-checks early.
const closesAt = (now) => endOf(todayOf(now));

const version = (v) => (Number.isInteger(v) && v >= 1 ? v : 1);

// A day in its stored shape, or null when it has no valid id. `deleted` marks a
// tombstone (5): kept so a later sync tells other devices, never shown.
const dayRecord = (d) =>
  d && isId(d.id) && /^\d{4}-\d{2}-\d{2}$/.test(d.day)
    ? {
        id: d.id,
        day: d.day,
        text: str(d.text),
        editedAt: Number.isInteger(d.editedAt) ? d.editedAt : 0,
        version: version(d.version),
        ...(d.deleted === true ? { deleted: true } : {}),
        // The step that last wrote the day in this browser (12, Undo); the server never has it.
        ...(typeof d.step === "string" ? { step: d.step } : {}),
      }
    : null;

// --- Changes --------------------------------------------------------------------------

// A day as another device would be told it: the version and the step are not part of it.
const content = (r) => JSON.stringify(r, (k, v) => (k === "version" || k === "step" ? undefined : v));

// The next list with versions minted locally (5, while signed out): a day whose content
// changed takes the next version; a new one starts at 1.
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
const daySaved = (days, { id, text }, now) => {
  const open = openDay(days, now);
  const was = days.find((d) => d.id === id);
  if (was) {
    if (open?.id !== id || was.text === text) return null;
    return mint(days, days.map((d) => (d.id === id ? { ...d, text, editedAt: now } : d)));
  }
  if (open || text === "") return null;
  return [...days, { id, day: todayOf(now), text, editedAt: now, version: 1 }];
};

// The user kept one of the two copies journal.conflicted showed: a save, not left, of
// one copy's exact text to the day the conflict named. That day takes the text, also
// when it has closed, since the user only chose between what was already written, and
// keeps its time of last edit unless it is the open day; the other record of the same
// date, if there was one, becomes a tombstone (5). Anything else is an ordinary save.
const kept = (context, { id, text, left }) => {
  const choice = context.pending.get(id);
  const day = context.days.find((d) => d.id === id && !d.deleted);
  if (left || !choice || !day || !choice.copies.includes(text)) return null;
  const now = context.now();
  const open = openDay(context.days, now)?.id === id;
  return mint(
    context.days,
    context.days.map((d) => {
      if (d.id === id) return d.text === text ? d : { ...d, text, editedAt: open ? now : d.editedAt };
      return d.id === choice.other && !d.deleted ? { ...d, deleted: true } : d;
    }),
  );
};

// --- The picture ----------------------------------------------------------------------

// journal.changed and journal: read keep the fields of the journal's detectors and Jev's
// answers, because contracts only grow (7.1); the journal holds none, so they are empty,
// and the reason Jev is not reading is that no detector is on.
const body = (c) => {
  const now = c.now();
  const open = openDay(c.days, now);
  return {
    days: visible(c.days)
      .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id))
      .map(({ id, day, text, editedAt, version }) => ({ id, day, text, editedAt, version, waiting: [], unanswered: [] })),
    projects: [],
    detectors: [],
    answers: [],
    open: open?.id ?? null,
    today: todayOf(now),
    reason: "no-detector",
  };
};

// --- Tools (7.7) ----------------------------------------------------------------------

// journal: open. The shown day is the one journal-entry last announced in day.shown;
// which day the page shows is that view's rule, so this fact only remembers it. Its text
// is the day's record, or empty for today's page not yet written on. A day.shown without
// `writable` counts only today as writable, as that event says.
const opened = (c) => {
  if (!c.shown) return { shown: null };
  const { day, writable } = c.shown;
  const record = visible(c.days).find((d) => d.day === day);
  return { shown: { day, text: record?.text ?? "", writable: writable ?? day === todayOf(c.now()) } };
};

// journal: days, oldest first and at most DAYS_MAX of them. `from` alone names one day;
// both ends are included.
const between = (c, { from, to } = {}) => {
  const last = to ?? from;
  const all = visible(c.days)
    .filter((d) => d.text !== "" && (!from || d.day >= from) && (!last || d.day <= last))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
  const reply = { days: all.slice(0, DAYS_MAX).map(({ day, text }) => ({ day, text })) };
  // Only a range longer than DAYS_MAX carries `more`, so the reply of a short one is as before.
  if (all.length > DAYS_MAX) reply.more = all.length - DAYS_MAX;
  return reply;
};

// journal: days answers at most this many days per ask, so a long range cannot fill the
// chat (7.7); the days left out are counted in `more`.
export const DAYS_MAX = 7;

// journal: index, the short list (7.7): at most INDEX_MAX entries, INDEX_LIMIT unless
// the asker names a limit, and a first line cut at FIRST_WORDS words.
export const INDEX_LIMIT = 20;
export const INDEX_MAX = 50;
const FIRST_WORDS = 25;

// A word is a run of characters between whitespace, as 7.7 counts the excerpt's words; a
// level marker (# ## ###) is not one.
const words = (text) => text.split(/\s+/).filter(Boolean);

// The day's first line with writing on it, without the level markers (# ## ###) the text
// keeps, cut to FIRST_WORDS words: what stands in for a summary the generator has not
// written (a day still open, a day signed out, a page without generators).
export const firstLine = (text) => {
  const line = str(text).split("\n").map((l) => l.replace(/^#{1,3}\s+/, "").trim()).find(Boolean) ?? "";
  const w = words(line);
  return w.length > FIRST_WORDS ? `${w.slice(0, FIRST_WORDS).join(" ")}…` : line;
};

// The written days that match, newest first. `from` and `to` are each an end of the range,
// both included, so `from` alone is every day since it; `contains` is matched in the day's
// text, ignoring case. A day's summary is the journal-summary generator's, read only while
// signed in, since signed out the generators hold none of the account's (book-toc's rule).
export const indexOf = (c, { from, to, contains, limit } = {}) => {
  const needle = typeof contains === "string" && contains.trim() !== "" ? contains.trim().toLocaleLowerCase() : null;
  const all = visible(c.days)
    .filter((d) => d.text.trim() !== "" && (!from || d.day >= from) && (!to || d.day <= to))
    .filter((d) => !needle || d.text.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.day.localeCompare(a.day) || b.id.localeCompare(a.id));
  const shown = all.slice(0, Math.min(limit ?? INDEX_LIMIT, INDEX_MAX));
  const summaries = c.userId ? c.summaries : {};
  return {
    days: shown.map((d) => ({
      id: d.id,
      day: d.day,
      summary: summaries[d.day]?.text?.trim() || firstLine(d.text),
      words: words(d.text.replace(/^#{1,3}\s+/gm, "")).length,
    })),
    total: all.length,
    more: all.length - shown.length,
  };
};

// What journal: index needs of a generators result: its text and version, so an older
// announcement never replaces a newer one.
const isSummary = (r) => r?.generator === "journal-summary" && typeof r.item === "string";
const summarised = assign({
  summaries: ({ context, event }) =>
    !isSummary(event.result) || context.summaries[event.result.item]?.version > event.result.version
      ? context.summaries
      : { ...context.summaries, [event.result.item]: { text: str(event.result.text), version: event.result.version } },
});

const shownOf = (event) => ({ day: event.day, ...(typeof event.writable === "boolean" ? { writable: event.writable } : {}) });
const remember = assign({ shown: ({ event }) => shownOf(event) });

// --- The actor ------------------------------------------------------------------------

// A day's row in the outbox, keyed by kind and id; the kind is the server's route.
const TABLE = "days";
const rowKey = (r) => `${TABLE}\n${r.id}`;

// Stores every day that differs from what was held, so a keystroke writes one day, not
// the journal.
const persist = (store, held, next, enqueue) => {
  const was = new Map(held.map((r) => [r.id, r]));
  for (const r of next) if (!same(was.get(r.id), r)) enqueue(() => store.put(TABLE, r).catch(() => {}));
};

// Today's journal day ends by time alone, with nobody acting, so a timer wakes the fact
// then to announce the new today and the open day's closing.
const arm = (enqueue, days, now) => {
  enqueue.cancel("close");
  // setTimeout fires at once past 2^31 ms, so a clock set far back would otherwise spin.
  enqueue.raise({ type: "_close" }, { id: "close", delay: Math.min(closesAt(now) - now, 2 ** 31 - 1) });
};

// Two records of the date the page shows are put to the user as a conflict, the way a
// day saved on two devices is: the newest is the day the page shows, "theirs", and the
// other is offered as "mine", on the newest's version, so keeping it is a save of its
// text to the shown day (kept). Its time of last edit rides along, which is what tells
// the page this is two records of one date and lets it label each copy by its time. It is told when the page shows that date and again only
// when either copy changes, so typing elsewhere does not repeat it.
const tell = (enqueue, c, again = false) => {
  const clash = c.shown && clashOn(c.days, c.shown.day);
  if (!clash) return;
  const { kept: day, other } = clash;
  const copies = [day.text, other.text];
  const was = c.pending.get(day.id);
  if (!again && was?.other === other.id && same(was.copies, copies)) return;
  const told = {
    id: day.id,
    mine: { text: other.text, baseVersion: day.version, editedAt: other.editedAt },
    theirs: { text: day.text, version: day.version, editedAt: day.editedAt },
  };
  enqueue.assign({ pending: new Map(c.pending).set(day.id, { copies, other: other.id, told }) });
  enqueue.emit({ type: "journal.conflicted", ...told });
};

// `settled` names the day whose conflict this change settled, so a page still showing the
// two copies hides them, as after a Redo of keeping one (12, Undo).
const announce = (enqueue, c, settled = null) => {
  const picture = body(c);
  enqueue.assign({ open: picture.open, today: picture.today });
  enqueue.emit({ type: "journal.changed", ...picture, ...(settled ? { settled } : {}) });
  tell(enqueue, c);
};

// --- The outbox (5) -------------------------------------------------------------------

// What the server keeps of a day: not its version (the server's to assign) or the
// tombstone flag (sent beside it).
const wire = ({ version: _, deleted: __, step: ___, ...r }) => r;

// One row per day, so three offline edits become one write. The base stays the one the
// first unsynced change was on, which is what the server compares the write against.
const enqueueRow = (c, enqueue, r, base) => {
  const key = rowKey(r);
  const existing = c.outbox.get(key);
  const row = { key, table: TABLE, record: wire(r), baseVersion: existing ? existing.baseVersion : base };
  if (r.deleted) row.deleted = true;
  c.outbox.set(key, row);
  enqueue(() => c.store.outboxPut(row).catch(() => {}));
};

// Queues every day whose content changed between `held` and `next`.
const enqueueChanges = (c, enqueue, held, next) => {
  const was = new Map(held.map((r) => [r.id, r]));
  for (const r of next) {
    const old = was.get(r.id);
    if (!old || content(old) !== content(r)) enqueueRow(c, enqueue, r, old ? old.version : null);
  }
};

// Signing in makes the journal kept in this browser the account's (5): every day,
// tombstones too, goes up, and one the server has never seen goes on the version this
// browser numbered, so the server continues its history. A row pinned to a version the
// server gave keeps that base, so an edit made while signed out is still compared with
// what the server holds. The pull starts over for the new user.
const adopt = (c, enqueue, userId) => {
  enqueue.assign({ userId, cursor: 0 });
  enqueue(() => c.store.metaPut("userId", userId).catch(() => {}));
  enqueue(() => c.store.metaPut("cursor", 0).catch(() => {}));
  for (const r of c.days) {
    const row = c.outbox.get(rowKey(r));
    if (row?.baseVersion != null) continue;
    if (!row) {
      enqueueRow(c, enqueue, r, r.version);
      continue;
    }
    const adopted = { ...row, baseVersion: r.version };
    c.outbox.set(row.key, adopted);
    enqueue(() => c.store.outboxPut(adopted).catch(() => {}));
  }
  enqueue.raise({ type: "_sync", pull: true });
};

// Applies a candidate list of days. Only a day that changed is stored, and a changed day
// is queued in the outbox signed in or not, so its row keeps the last version the server
// gave as its base; only signed in is a drain asked for. Signed in, the versions are the
// server's: a change keeps the version it was made on until the server acknowledges it.
const update = (context, enqueue, next, settled = null) => {
  if (same(next, context.days)) return;
  let days = next;
  if (context.userId) {
    const was = new Map(context.days.map((r) => [r.id, r]));
    days = days.map((r) => (was.has(r.id) ? { ...r, version: was.get(r.id).version } : r));
  }
  enqueueChanges(context, enqueue, context.days, days);
  if (context.userId) enqueue.raise({ type: "_drain" });
  persist(context.store, context.days, days, enqueue);
  arm(enqueue, days, context.now());
  enqueue.assign({ days });
  announce(enqueue, { ...context, days }, settled);
};

// Applies a sync's summary: the acknowledged days, the conflicts, what was pulled, the
// cursor, and a session the server no longer knows.
const applySync = (context, output, enqueue) => {
  const { acks = [], conflicts = [], pulled = {}, newCursor, authFailed } = output;
  const days = [...context.days];
  const held = (id) => days.find((r) => r.id === id);
  const keep = (r) => {
    const i = days.findIndex((x) => x.id === r.id);
    if (i < 0) days.push(r);
    else days[i] = r;
  };
  const dropRow = (key) => {
    context.outbox.delete(key);
    enqueue(() => context.store.outboxDelete(key).catch(() => {}));
  };

  for (const { row, record } of acks) {
    const r = dayRecord(record);
    if (!r) continue;
    const current = context.outbox.get(row.key);
    // Drained when the server holds what is pending now; a change made during the sync
    // leaves a newer row, which stays and moves its base to the acknowledged version.
    // A day the server holds as a tombstone is gone whatever was pending (5).
    const drained =
      current && (r.deleted || (same(current.record, row.record) && Boolean(current.deleted) === Boolean(row.deleted)));
    if (drained) dropRow(row.key);
    else if (current) {
      const advanced = { ...current, baseVersion: r.version };
      context.outbox.set(row.key, advanced);
      enqueue(() => context.store.outboxPut(advanced).catch(() => {}));
    }
    const was = held(r.id);
    // The server now holds what this browser wrote, so the step that wrote it still can be undone.
    const stamp = was?.step && content(was) === content(r) ? { step: was.step } : {};
    keep(drained || !was ? { ...r, ...stamp } : { ...was, version: r.version });
  }

  // A day's text was written on a version another device had moved past. The server's
  // copy is kept and both copies are announced, so a view can show the user what they
  // wrote rather than lose it, and keep either (kept).
  const pending = new Map(context.pending);
  for (const { row, record } of conflicts) {
    const theirs = dayRecord(record);
    if (!theirs) continue;
    const mine = context.outbox.get(row.key) ?? row;
    dropRow(row.key);
    keep(theirs);
    const told = {
      id: theirs.id,
      mine: { text: mine.record.text, baseVersion: mine.baseVersion },
      theirs: { text: theirs.text, version: theirs.version, editedAt: theirs.editedAt },
    };
    pending.set(theirs.id, { copies: [mine.record.text, theirs.text], other: null, told });
    enqueue.emit({ type: "journal.conflicted", ...told });
  }

  for (const record of pulled.days ?? []) {
    const r = dayRecord(record);
    if (!r) continue;
    const was = held(r.id);
    if (was && r.version <= was.version) continue;
    // A change still in the outbox goes up next and comes back as a conflict carrying
    // this copy; a delete always wins there (5). Otherwise a live copy of a local
    // tombstone at a higher version is a restore write made elsewhere (5).
    if (context.outbox.has(rowKey(r))) continue;
    keep(r);
  }

  if (conflicts.length) enqueue.assign({ pending });
  if (!same(days, context.days)) {
    persist(context.store, context.days, days, enqueue);
    enqueue.assign({ days });
    announce(enqueue, { ...context, days, pending });
    arm(enqueue, days, context.now());
    enqueue.raise({ type: "_tidy" });
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

// --- Steps (12, Undo) -------------------------------------------------------------------

// A day as a step names it: its text, when it was last written, whether it is deleted, and
// `prior`, the step that wrote it before this one, so an Undo leaves the day as that step
// left it and the step before can be undone next.
const entry = (d, prior = d.step) => ({
  id: d.id,
  text: d.text,
  editedAt: d.editedAt,
  ...(d.deleted ? { deleted: true } : {}),
  ...(prior ? { prior } : {}),
});
// What a day undone back past every step this browser knows of is stamped with.
const before = (e, step) => e.prior ?? `^${step}`;

// A choice is one step, shown with the short notice since it deletes a copy (12, Undo).
const saved = enqueueActions(({ context, event, enqueue }) => {
  const choice = kept(context, event);
  if (choice) {
    const settled = context.pending.get(event.id);
    const pending = new Map(context.pending);
    pending.delete(event.id);
    const was = context.days.filter((d) => d.id === event.id || d.id === settled.other);
    const step = context.mintStep();
    const touched = new Set(was.map((d) => d.id));
    const next = choice.map((d) => (touched.has(d.id) ? { ...d, step } : d));
    enqueue.assign({ pending, stretch: null });
    update({ ...context, pending }, enqueue, next, event.id);
    enqueue.emit({
      type: "step.recorded",
      id: step,
      owner: "journal",
      label: "keep one copy of the day",
      // A copy saved on another device is put to the page again by the journal itself.
      undo: { kind: "days", days: was.map((d) => entry(d)), ...(settled.other ? {} : { conflict: settled.told }) },
      redo: { kind: "days", days: next.filter((d) => touched.has(d.id)).map((d) => entry(d, was.find((w) => w.id === d.id).step ?? null)) },
      notice: true,
    });
    return;
  }
  const days = daySaved(context.days, event, context.now());
  const open = context.stretch;
  if (!days) {
    if (event.left && open?.day === event.id) enqueue.assign({ stretch: null });
    return;
  }
  // One stretch of typing in today's page is one step, from the first save until the
  // editor says the user left it; a save while that stretch last wrote the day joins it.
  const was = context.days.find((d) => d.id === event.id);
  const joins = open != null && open.day === event.id && was?.step === open.id;
  const step = joins ? open.id : context.mintStep();
  const first = joins ? open.before : entry(was ?? { id: event.id, text: "" });
  const next = days.map((d) => (d.id === event.id ? { ...d, step } : d));
  update(context, enqueue, next);
  enqueue.emit({
    type: "step.recorded",
    id: step,
    owner: "journal",
    label: "edit the journal page",
    undo: { kind: "days", days: [{ id: first.id, text: first.text, ...(first.prior ? { prior: first.prior } : {}) }], open: true },
    redo: { kind: "days", days: [{ id: event.id, text: event.text, ...(first.prior ? { prior: first.prior } : {}) }], open: true },
  });
  enqueue.assign({ stretch: event.left ? null : { id: step, day: event.id, before: first } });
});

// An Undo or Redo of one of this fact's steps. It is applied only while every day it
// names is as the step left it, last written in this browser by that step; anything
// written since, here, in another tab or on another device, refuses it as changed. Text
// typed in a day can be taken back only while the day can still be written (13), so a
// closed day refuses it as closed; a kept copy can be taken back on any day, as it was
// kept. A deleted copy comes back with a restore write (5).
const applyStep = enqueueActions(({ context, event, enqueue }) => {
  if (event.owner !== "journal") return;
  const settle = (outcome, reason) =>
    enqueue.emit({ type: "step.settled", id: event.id, owner: "journal", outcome, ...(reason ? { reason } : {}) });
  enqueue.assign({ stretch: null });
  const p = event.payload ?? {};
  const undoing = event.type === "step.undone";
  const entries = Array.isArray(p.days) ? p.days.filter((e) => isId(e?.id) && typeof e.text === "string") : [];
  if (p.kind !== "days" || !entries.length || entries.length !== p.days.length) return settle("refused", "changed");
  const held = entries.map((e) => context.days.find((d) => d.id === e.id));
  const expected = (e) => (undoing ? event.id : before(e, event.id));
  if (held.some((d, i) => !d || d.step !== expected(entries[i]))) return settle("refused", "changed");
  const now = context.now();
  if (p.open && entries.some((e) => openDay(context.days, now)?.id !== e.id)) return settle("refused", "closed");
  const byId = new Map(entries.map((e) => [e.id, e]));
  const next = context.days.map((d) => {
    const e = byId.get(d.id);
    if (!e) return d;
    const { deleted: _, ...live } = d;
    const editedAt = Number.isInteger(e.editedAt) ? e.editedAt : now;
    return { ...live, text: e.text, editedAt, ...(e.deleted ? { deleted: true } : {}), step: undoing ? before(e, event.id) : event.id };
  });
  // Undoing a choice puts the conflict to the page again; two records of one date are told
  // again by update, as any clash is (tell). Making the choice again settles it.
  const pending = new Map(context.pending);
  const told = undoing && p.conflict && isId(p.conflict.id) ? p.conflict : null;
  if (told) pending.set(told.id, { copies: [told.mine.text, told.theirs.text], other: null, told });
  const settled = told ? null : (entries.find((e) => pending.has(e.id))?.id ?? null);
  if (!told) for (const e of entries) pending.delete(e.id);
  enqueue.assign({ pending });
  update({ ...context, pending }, enqueue, mint(context.days, next), settled);
  if (told) enqueue.emit({ type: "journal.conflicted", ...told });
  settle("applied");
});

const queue = assign({ queued: ({ context, event }) => [...context.queued, event] });

// What arrived while the store loaded, replayed in order once it is ready.
const replay = (context, enqueue) => {
  for (const message of context.queued) enqueue.raise(message);
  enqueue.assign({ queued: [] });
};

// The pause in typing the network waits for (5): a save restarts the window, so a run of
// saves drains once, as one coalesced write per day, after the typing stops. A load, a
// sign-in, a tab regaining focus or going to the background does not wait.
const SYNC_IDLE_MS = 2000;

// The browser changed account while this fact was not on the page (12): a copy kept for
// another account, with nothing of it left to upload, is emptied before it is read, so
// none of it is shown to the account now signed in or uploaded as its own. A copy marked
// to be added to the account (12, keep) is kept instead, and `keepFor` sends it.
async function claim(store, ask, api) {
  const session = ask ? await ask("session", "read", {}).catch(() => null) : null;
  const userId = typeof session?.userId === "string" ? session.userId : null;
  if (!userId) return;
  const [kept, outbox, from] = await Promise.all([store.metaGet("userId"), store.outboxAll(), store.metaGet("adopt")]);
  if (kept && kept !== userId && outbox.length === 0 && !from) await store.empty();
  await keepFor(store, from, userId, api);
}

// The browser joined an account keeping this copy (12, keep). The account is asked for
// every day it holds first: when it already holds a day with text that is not deleted,
// this copy is emptied, outbox included, and the pull from 0 brings the account's days.
// When it holds none, every day is queued for it on the version it holds, which the
// server adopts on first insert. Either way the cursor goes back to 0 and the copy is
// marked as the account's, so the sign-in path (adopt) does not queue the days again. A
// tombstone is not sent: the account never had the day, so there is nothing to delete.
// The mark is cleared only once every row is stored in the outbox, so a reload midway
// sends the copy again (one row per day) rather than losing it; when the account cannot
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
    if (!Array.isArray(held?.days)) {
      // Undecided: the copy follows the account now signed in, so the sign-in path does
      // not take it for another account's, and the mark stays for the next load.
      await store.metaPut("userId", userId);
      return;
    }
    if (held.days.map(dayRecord).some((r) => r && !r.deleted && r.text.trim() !== "")) {
      await store.empty();
    } else {
      const [stored, outbox] = await Promise.all([store.all(TABLE), store.outboxAll()]);
      const queued = new Set(outbox.map((row) => row.key));
      for (const r of stored.map(dayRecord).filter(Boolean)) {
        if (r.deleted || queued.has(rowKey(r))) continue;
        await store.outboxPut({ key: rowKey(r), table: TABLE, record: wire(r), baseVersion: r.version });
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
    // A pull is always worth the round trip; a bare drain only when the outbox holds something.
    needed: ({ context, event }) => Boolean(event.pull) || context.outbox.size > 0 || context.leaving,
    // The browser is changing account (12): empty the local copy once nothing is left
    // to upload.
    leftover: ({ context }) => context.leaving && context.outbox.size === 0,
  },
  actors: {
    load: fromPromise(async ({ input: { store, ask, api } }) => {
      await claim(store, ask, api);
      const [days, outbox, cursor, userId, session] = await Promise.all([
        store.all("days"),
        store.outboxAll(),
        store.metaGet("cursor"),
        store.metaGet("userId"),
        // Who is signed in now. Without an answer (no session on the page, or a Node
        // test without one) the user this browser last synced for is assumed.
        ask ? ask("session", "read", {}).catch(() => null) : null,
      ]);
      const known = session && typeof session === "object" && "userId" in session;
      return {
        days,
        outbox,
        cursor: Number.isInteger(cursor) ? cursor : 0,
        stored: userId ?? null,
        userId: known ? session.userId : userId ?? null,
      };
    }),
    // The journal-summary generator's results, for journal: index. Asked once the journal
    // is ready and never awaited by the load, since generators reads the journal at its own
    // start; generation.changed is held until the reply lands (4.2).
    summaries: fromPromise(({ input }) => input.ask("generators", "results", { generator: "journal-summary" })),
    // Empties the local copy in one transaction, outbox and cache together (12).
    // With keep (12) the copy stays and is marked, under the account it came from, to be
    // added to the account the browser joins after the reload.
    empty: fromPromise(({ input }) => (input.keep ? input.store.metaPut("adopt", input.from ?? true) : input.store.empty())),
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
      "Owns the journal: one entry per day. It works offline and syncs to the account when " +
      "signed in, the same way notes do; signed out it is kept in this browser, and signing in " +
      "moves it to the account. A journal day runs from 2:00 to 2:00 the next night, so " +
      "writing past midnight keeps going in the same entry until 2:00; a day's date is that " +
      "journal day when its first character was typed and never changes. Only today's day can " +
      "be edited; a save to any other day is refused, and the journal announces which day is " +
      "today, so nothing else reads the clock for it. When a day was saved on two devices at once, " +
      "or two records hold the same date (two devices each started it offline, or a journal was " +
      "added to an account that already had that date), the journal shows one day per date, the " +
      "newest, and puts both copies to the page showing that date; keeping one saves its text to " +
      "that day, also once it has closed, and deletes the other record. A second record that is " +
      "empty or holds the same text is deleted without asking. When no day can be edited, the journal opens " +
      "an empty page for today. The chat may read it through three lookups: the day the journal " +
      "page shows, with its text and whether it can still be written, remembered from what the " +
      "page last announced and kept only while the page is open; and the days in a range of " +
      "dates, oldest first, at most seven per ask, leaving out days with nothing written; and a short " +
      "list of the written days, newest first, each with its date, its summary (the journal summary " +
      "generator's sentence, or the day's first line when there is none or the reader is signed out) " +
      "and its length in words, narrowed by dates and by words the day contains, at most 20 unless " +
      "more are asked for (up to 50), with how many more match. Two changes are steps Undo and " +
      "Redo reverse (section 12): one stretch of typing in today's page, from the first save " +
      "until the editor says the user left it, and keeping one copy, which asks for the short " +
      "notice. Undo of a kept copy brings the day's text and the other copy back, the other " +
      "record with a restore write the server accepts, and puts both copies to the page again, " +
      "also on a closed day. Typing in a day can be undone only while the day can be written: " +
      "after 2:00 it is refused as closed. A step is refused when a day it names was written " +
      "since by anything else.",
    kind: "fact",
    shape: "replicated",
    owns: "the journal's days",
    steps: { "day.saved": "step", "day.shown": "navigation" },
    emits: ["journal.changed", "journal.conflicted", "step.recorded", "step.settled"],
    asks: ["session: read", "generators: results"],
  },
  context: ({ input }) => ({
    days: [],
    open: null,
    today: null,
    // The day the journal page shows (day.shown), in memory only, for journal: open.
    shown: null,
    // The journal-summary generator's texts by date, as { text, version }, for journal: index.
    summaries: {},
    // The conflicts announced and not yet settled, by the id they named: the two copies'
    // texts and, for two records of one date, the other record's id (kept).
    pending: new Map(),
    userId: null,
    cursor: 0,
    outbox: new Map(),
    queued: [],
    // The browser is changing account (12), from session.changed until it is over.
    leaving: false,
    // The browser joins the next account keeping this copy (12, keep).
    keep: false,
    // What a trigger that arrives mid-sync is owed: resync means sync again, pull
    // whether that next sync must also pull.
    resync: false,
    pull: false,
    store: input.store,
    now: input.now,
    mintStep: input.mintStep ?? ulid,
    // The stretch of typing still open (12, Undo): { id, day, before }, the step's id, the
    // day typed in and that day as it was before the stretch; null when none is.
    stretch: null,
    ask: input.ask,
    api: input.api,
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
            const { output } = event;
            const days = output.days.map(dayRecord).filter(Boolean);
            // Only days go to the server; a row of another kind an older journal queued
            // would be refused on every sync and hold back the days behind it.
            const rows = output.outbox.filter((row) => row.table === TABLE);
            for (const row of output.outbox) {
              if (row.table !== TABLE) enqueue(() => context.store.outboxDelete(row.key).catch(() => {}));
            }
            const outbox = new Map(rows.map((row) => [row.key, row]));
            const c = { ...context, days, outbox };
            const { userId } = output;
            const now = context.now();
            enqueue.assign({ days, outbox, userId, cursor: output.cursor, open: openDay(days, now)?.id ?? null, today: todayOf(now) });
            arm(enqueue, days, now);
            // Signed in since this browser last synced, perhaps in another tab, is a
            // sign-in like any other.
            if (userId && userId !== output.stored) adopt(c, enqueue, userId);
            else if (userId) enqueue.raise({ type: "_sync", pull: true });
            tell(enqueue, c);
            enqueue.raise({ type: "_tidy" });
            replay(context, enqueue);
          }),
        },
        // A store that cannot open still takes writing for this page, rather than
        // refusing every keystroke.
        onError: {
          target: "ready",
          actions: enqueueActions(({ context, enqueue }) => replay(context, enqueue)),
        },
      },
      on: {
        "day.saved": { actions: queue },
        "session.changed": { actions: queue },
        "read?": { actions: queue },
        "open?": { actions: queue },
        "days?": { actions: queue },
        "index?": { actions: queue },
        "day.shown": { actions: remember },
        "generation.changed": { actions: summarised },
        "step.undone": { actions: queue },
        "step.redone": { actions: queue },
      },
    },
    ready: {
      invoke: {
        src: "summaries",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: {
          actions: assign({
            summaries: ({ context, event }) => {
              const results = Array.isArray(event.output?.results) ? event.output.results.filter(isSummary) : [];
              const next = { ...context.summaries };
              for (const r of results) if (!(next[r.item]?.version > r.version)) next[r.item] = { text: str(r.text), version: r.version };
              return next;
            },
          }),
        },
        // No generators on the page, or no ask: every day shows its first line.
        onError: {},
      },
      on: {
        "generation.changed": { actions: summarised },
        "index?": { actions: ({ context, event }) => event.reply(indexOf(context, event.payload)) },
        "day.saved": { actions: saved },
        "step.undone": { actions: applyStep },
        "step.redone": { actions: applyStep },
        // The outbox drains only while someone is signed in (5); signing out keeps it,
        // to go up at the next sign-in.
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
            if (event.userId === context.userId) return;
            if (event.userId) return adopt(context, enqueue, event.userId);
            enqueue.assign({ userId: null });
            enqueue(() => context.store.metaPut("userId", null).catch(() => {}));
          }),
        },
        _close: {
          actions: enqueueActions(({ context, enqueue }) => {
            const now = context.now();
            if ((openDay(context.days, now)?.id ?? null) !== context.open || todayOf(now) !== context.today) announce(enqueue, context);
            arm(enqueue, context.days, now);
          }),
        },
        // Two records of one date that hold nothing to choose between keep only one (tidy).
        _tidy: {
          actions: enqueueActions(({ context, enqueue }) => {
            const next = tidy(context.days);
            if (next !== context.days) update(context, enqueue, mint(context.days, next));
          }),
        },
        "read?": { actions: ({ context, event }) => event.reply(body(context)) },
        "open?": { actions: ({ context, event }) => event.reply(opened(context)) },
        "days?": { actions: ({ context, event }) => event.reply(between(context, event.payload)) },
        "day.shown": {
          actions: enqueueActions(({ context, event, enqueue }) => {
            const shown = shownOf(event);
            enqueue.assign({ shown });
            tell(enqueue, { ...context, shown }, true);
          }),
        },
      },
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
        // A _drain re-enters this state, which restarts the window, so the drain waits
        // until typing has paused for all of it. Signed out mid-window, it returns to
        // idle rather than sync with no user.
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
            // pull comes from the triggering event: the entry assign above runs before
            // the input is read and would otherwise wipe it from context.
            input: ({ context, event }) => ({
              api: context.api,
              store: context.store,
              rows: [...context.outbox.values()],
              cursor: context.cursor,
              pull: Boolean(event.pull) && !context.leaving,
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
            _leave: { actions: assign({ resync: true }) },
            _sync: { actions: assign({ resync: true, pull: ({ context, event }) => context.pull || Boolean(event.pull) }) },
          },
        },
      },
    },
  },
});
