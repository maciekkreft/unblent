import { setup, assign, emit, enqueueActions, fromPromise, spawnChild, stopChild } from "xstate";

// The view component that shows the client's values on a journal day (6.4). It owns only
// UI state — the day shown, that day's version as the fact last said it, whether the sheet
// is open, its drafts, which values wait out their undo window, and which other version is
// being looked at — and points at one fact: it asks values: read for the shown day and
// values: versions for the days the values changed, and follows values.changed after (4.3,
// fourth rule). The day comes from day.shown, so the rule for which day the journal shows
// stays in journal-entry. Writing leaves as values.saved, the whole list (4.3, third rule).
// It also asks settings: read for the "Vim keys" preference (12) and follows
// settings.changed; and value-checks: read and evaluators: list for Jev's marks, following
// values.checked, value-checks.changed, evaluator.changed and evaluator.deleted; and
// generators: results for Could be's suggestions, following generation.changed. The ask,
// the id minting, the clock, the throttle, the undo window and the hash arrive through
// input, so the machine is importable in Node.

export const FIELDS = ["name", "meaning"];

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the
// journal page first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// A day as the footer says it, "12 October" as the journal dates its pages, with the year
// only when it is not this one.
export function dayName(day, today) {
  const [y, m, d] = day.split("-").map(Number);
  const name = `${d} ${MONTHS[m - 1]}`;
  return today && today.slice(0, 4) === day.slice(0, 4) ? name : `${name} ${y}`;
}

// Each value's checked lines, by value id, as values.checked carries them.
const reportsOf = (values) => Object.fromEntries((Array.isArray(values) ? values : []).map((v) => [v.id, v.lines]));

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

// Only today's page writes the values (the values fact ignores any other day): not
// yesterday's in the hour after midnight the journal keeps its text open, so a version
// never changes after its day. A day the journal says cannot be written is read only too.
export const writable = (context) => context.day === dateOf(context.now()) && context.dayWritable !== false;

// Your values is added to a day or taken off it only where the values fact accepts it:
// on today's page, by the same rule as a save.
export const placeable = (context) => writable(context);

// Whether the shown day shows the panel: as the fact says, and before it has, as a page
// without placements always did.
export const isPlaced = (context) => context.placed !== false;

const blank = (id) => ({ id, name: "", meaning: "" });
const copy = (values) => values.map((v) => ({ id: v.id, name: v.name, meaning: v.meaning }));

export const isEmpty = (v) => !v.name.trim() && !v.meaning.trim();

// What a save sends: every row with a name or a sentence, in the sheet's order. A value
// waiting out its undo window is still kept until the window ends.
export const savedValues = (drafts) => copy(drafts.filter((d) => !isEmpty(d)));

// `finished` names the rows the user has just left, of those saved, so their lines can be
// checked once they are written and not while they are typed.
const save = (enqueue, context, values, finished = []) => {
  if (!writable(context)) return;
  const left = finished.filter((id) => values.some((v) => v.id === id));
  enqueue.emit({ type: "values.saved", day: context.day, values, ...(left.length ? { finished: left } : {}) });
};

// The values the folded card names: the sheet's own while it is open, otherwise the
// version the fact said, without those waiting to be removed.
export function shownValues(context) {
  const list = context.open && writable(context) ? context.drafts : (context.version?.values ?? []);
  return list.filter((v) => !context.removing.includes(v.id) && !isEmpty(v));
}

// The days the values changed before the version the shown day holds, newest first:
// what "Earlier versions" lists.
export function earlierDays(context) {
  const before = context.version?.day ?? context.day;
  return context.days.filter((d) => d < before).sort().reverse();
}

// What the footer says about when the shown version was written.
export function changedLine(context) {
  const day = context.version?.day;
  if (!day) return "";
  const today = dateOf(context.now());
  return day === today ? "Changed today" : `Last changed ${dayName(day, today)}`;
}

// The open sheet follows a version from the fact only while nothing typed waits to be
// saved and no value waits out its undo window, so a change never overwrites what is on
// screen. Rows keep their order; a value the fact no longer has goes, unless it is an
// empty row the user has just added; a value new to the sheet joins at the end.
function merged(drafts, values) {
  const by = new Map(values.map((v) => [v.id, v]));
  const kept = drafts.filter((d) => by.has(d.id) || isEmpty(d)).map((d) => (by.has(d.id) ? { ...by.get(d.id) } : d));
  const ids = new Set(kept.map((d) => d.id));
  return [...kept, ...copy(values.filter((v) => !ids.has(v.id)))];
}

// A version for the shown day, or an earlier one newer than what is held, is the shown
// day's. Which days are worth listing, and whether the values changed since, only the fact
// can say, since a change can make an earlier version read as today's: they are asked
// again (recount).
// A change of whether the shown day shows the panel arrives as that day with the values in
// force on it, unchanged; the version it holds is kept, so its day stays when it was written
// (the values fact ignores a save that changes nothing, so equal values are no new version).
const follow = enqueueActions(({ context, event, enqueue }) => {
  if (!isDay(event.day) || !Array.isArray(event.values)) return;
  enqueue.stopChild("recount");
  enqueue.spawnChild("recount", { id: "recount", input: { ask: context.ask, day: context.day } });
  if (event.day === context.day && typeof event.placed === "boolean") enqueue.assign({ placed: event.placed });
  const version = context.version;
  if (!version || event.day > context.day) return;
  if (version.day && event.day < version.day) return;
  if (JSON.stringify(copy(event.values)) === JSON.stringify(version.values)) return;
  enqueue.assign({ version: { day: event.day, values: copy(event.values), changedSince: version.changedSince } });
  if (context.open && !context.dirty && !context.removing.length) enqueue.assign({ drafts: merged(context.drafts, event.values) });
});

const saveWaiting = enqueueActions(({ context, enqueue }) => {
  if (!context.dirty) return;
  save(enqueue, context, savedValues(context.drafts));
  enqueue.assign({ dirty: false });
});

// Leaving rows typed in since they were last left: the save names them as finished, even
// when the throttle already saved their text (the values fact ignores a save that changes
// nothing). Leaving any other row only saves what waits.
const leaveRows = (rows) =>
  enqueueActions(({ context, event, enqueue }) => {
    const left = rows({ context, event }).filter((id) => context.edited.includes(id));
    if (!left.length) {
      if (context.dirty) {
        save(enqueue, context, savedValues(context.drafts));
        enqueue.assign({ dirty: false });
      }
      return;
    }
    save(enqueue, context, savedValues(context.drafts), left);
    enqueue.assign({ dirty: false, edited: context.edited.filter((id) => !left.includes(id)) });
  });
const leaveAll = leaveRows(({ context }) => context.edited);

const timerOf = (id) => `gone:${id}`;

// Leaving the day ends every undo window at once: the values waiting are removed and
// saved, so a removal the user asked for is never left half done.
const finishRemovals = enqueueActions(({ context, enqueue }) => {
  if (!context.removing.length) return;
  for (const id of context.removing) enqueue.cancel(timerOf(id));
  if (writable(context)) {
    const list = context.open ? context.drafts : (context.version?.values ?? []);
    save(enqueue, context, savedValues(list.filter((v) => !context.removing.includes(v.id))));
  }
  enqueue.assign({ removing: [], dirty: false });
});

// --- Jev's marks ----------------------------------------------------------------------
// What value-checks announced is turned into marks here, so the view only draws them, as
// choice-point-cards does (copied, since components never import each other). The value
// line is checked by the evaluator Settings names for values, the example by the one it
// names for examples; every answer of a checked line is a mark.

// Which line of a value each box holds, and which setting names its evaluator.
const LINE_OF = { name: "value", meaning: "example" };
const SETTING_OF = { name: "values", meaning: "examples" };

// Why Jev could not check, in one plain sentence in the footer.
export const ERROR_SENTENCES = {
  "signed-out": "Jev could not check: sign in to have your values checked.",
  "no-key": "Jev could not check: add your Jev key in Settings.",
  "bad-key": "Jev could not check: your Jev key was refused. Check it in Settings.",
  "rate-limited": "Jev could not check: too many requests. It tries again at your next change.",
  overloaded: "Jev could not check: Jev is busy. It tries again at your next change.",
  busy: "Jev could not check: Jev is busy. It tries again at your next change.",
  invalid: "Jev could not check: the evaluator's questions could not be asked.",
  unavailable: "Jev could not be reached. It tries again at your next change.",
};

const questionOf = (evaluator, id) => evaluator?.questions?.find((q) => q.id === id);
const optionOf = (evaluator, id, option) => questionOf(evaluator, id)?.options?.find((o) => o.id === option);

// The answer a question expects, while it names one still offered; null when none is.
const expectOf = (q) => {
  const want = q?.expect;
  if (want === "yes" || want === "no") return q.kind === "pick" ? null : want;
  return q?.kind === "pick" && q.options?.some((o) => o.id === want && !o.removing) ? want : null;
};

const expectedName = (evaluator, id, option) => {
  if (option === "yes") return "Yes";
  if (option === "no") return "No";
  return optionOf(evaluator, id, option)?.name || "another answer";
};

// How sure Jev is, as the mark's opacity: solid from 90% up, fading to a third at an even
// chance, so an unsure answer is seen as one without a number to read.
export const sureOf = (p) => Math.round((1 / 3 + (2 / 3) * Math.min(1, Math.max(0, (p - 0.5) / 0.4))) * 100) / 100;

// The marks of one checked line: a dot while Jev is checking, then one per answer, green
// when it is the answer its question expects, red when not, uncoloured when none is
// expected; its glyph is the icon the evaluator gives the option answered, else a warning
// for a red mark and a check for any other.
export function marksOf(line, evaluator) {
  if (!line) return [];
  if (line.status === "pending") return [{ pending: true }];
  if (line.status !== "done") return [];
  return line.answers.map((a) => {
    const expect = expectOf(questionOf(evaluator, a.question));
    const tone = expect == null ? "plain" : a.option === expect ? "right" : "wrong";
    return {
      question: a.question,
      name: a.name,
      tone,
      icon: optionOf(evaluator, a.question, a.option)?.icon || (tone === "wrong" ? "warning" : "check"),
      expected: expect == null ? null : expectedName(evaluator, a.question, expect),
      sure: sureOf(a.p),
    };
  });
}

// The hint of one line's marks: each answer's name, and for a red one the answer expected.
export function sayMarks(marks) {
  if (!marks.length) return null;
  if (marks[0].pending) return "Jev is checking…";
  return marks.map((m) => (m.tone === "wrong" ? `${m.name} · you expect ${m.expected}` : m.name)).join(" · ");
}

// The checked lines of one box of a value, each with its marks, for the view to put at the
// end of the line of the same text; a line edited since it was checked matches none.
export function boxMarks(context, id, field) {
  const { checks } = context;
  const evaluatorId = checks.settings?.[SETTING_OF[field]];
  if (!evaluatorId) return [];
  const evaluator = context.evaluators.find((e) => e.id === evaluatorId);
  return (checks.reports[id] ?? [])
    .filter((l) => l.line === LINE_OF[field])
    .map((l) => ({ text: l.text, marks: marksOf(l, evaluator) }))
    .filter((l) => l.marks.length);
}

// The marks a box of a value shows for its text now.
export const marksFor = (context, value, field) => boxMarks(context, value.id, field).find((l) => l.text === value[field])?.marks ?? [];

// Whether the folded card warns beside a value: a line of it as written now has a red mark.
export const warned = (context, value) => FIELDS.some((f) => marksFor(context, value, f).some((m) => m.tone === "wrong"));

// The values the sheet shows now: what is being looked at, the drafts, or the version.
const onScreen = (context) => context.viewing?.values ?? (context.open ? context.drafts : (context.version?.values ?? []));

// The footer's status line: the hint of the mark the pointer is over, the mark last tapped,
// or the line the text cursor is on, in that order; otherwise why Jev could not check.
export function statusOf(context) {
  const values = onScreen(context);
  for (const at of [context.pointed.hover, context.pointed.tap, context.pointed.cursor]) {
    const value = at && values.find((v) => v.id === at.id);
    if (!value || value[at.field] !== at.text) continue;
    const said = sayMarks(marksFor(context, value, at.field));
    if (said) return said;
  }
  return ERROR_SENTENCES[context.checks.error] ?? "";
}

const POINTS = new Set(["hover", "tap", "cursor"]);

// --- Could be --------------------------------------------------------------------------
// The generator Could be (generators, value-suggestion) writes one value for each of
// today's values whose value line Jev answered with a red mark. A suggestion is shown only
// while it was made from what the row says now: its result's source is the SHA-256 of the
// same compact JSON the generator hashes, worked out here from the row and the report.

const SUGGESTER = "value-suggestion";

// What the generator reads for a value, keys in its order, or null when the value line as
// written now is not answered with a red mark.
export function sourceOf(context, value) {
  const line = (context.checks.reports[value.id] ?? []).find((l) => l.line === "value");
  if (!line || line.status !== "done" || line.text !== value.name || !line.unexpected?.length) return null;
  return { value: value.name, example: value.meaning, reads: line.unexpected.join(", ") };
}

// A suggestion as Use puts it in the value line: trimmed, without a closing full stop.
export const cleaned = (text) => text.trim().replace(/[.\s]+$/, "");

// The suggestion to show under a value line, or null.
export function suggestionFor(context, value) {
  const source = sourceOf(context, value);
  const result = source && context.suggestions[value.id];
  if (!result || context.hashes[JSON.stringify(source)] !== result.source) return null;
  return cleaned(result.text) || null;
}

const summaryOf = (r) => ({ text: r.text, source: r.source, version: r.version });

// The hash of every source on screen that has none yet, sent back as _hashed.
const hashSources = enqueueActions(({ context, enqueue }) => {
  const hashes = { ...context.hashes };
  let asked = false;
  for (const v of context.open ? context.drafts : (context.version?.values ?? [])) {
    const source = sourceOf(context, v);
    const text = source && JSON.stringify(source);
    if (!text || text in hashes) continue;
    hashes[text] = null;
    asked = true;
    enqueue(({ self }) => Promise.resolve(context.sha256(text)).then((hex) => self.send({ type: "_hashed", text, hex }), () => {}));
  }
  if (asked) enqueue.assign({ hashes });
});

// SHA-256 hex of the UTF-8 of a text, through Web Crypto, which the browser and Node both
// have.
async function sha256(text) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Use or Undo puts `name` in a value line and saves the row as finished, so Jev checks
// the line as it now reads.
function rename(enqueue, context, id, name) {
  const drafts = context.drafts.map((d) => (d.id === id ? { ...d, name } : d));
  enqueue.assign({ drafts, dirty: false, edited: context.edited.filter((e) => e !== id) });
  save(enqueue, context, savedValues(drafts), [id]);
}

const endUse = enqueueActions(({ context, enqueue }) => {
  if (!context.used) return;
  enqueue.cancel("used");
  enqueue.assign({ used: null });
});

// --- Reordering ------------------------------------------------------------------------

// The drafts with one row moved to stand at index `to`.
export function moved(drafts, id, to) {
  const from = drafts.findIndex((d) => d.id === id);
  if (from < 0) return drafts;
  const rest = drafts.filter((d) => d.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), drafts[from], ...rest.slice(at)];
}

// The keys of a row that has the keyboard (12, "Vim keys"): `afterG` and `afterD` are
// whether a g or a d was pressed just before; "g" and "d" alone wait for their second.
const plainKey = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
export function rowKey(e, { afterG = false, afterD = false } = {}) {
  if (!plainKey(e)) return null;
  if (e.key === "g") return afterG ? "first" : "g";
  if (e.key === "d") return afterD ? "cut" : "d";
  return (
    {
      ArrowDown: "down",
      j: "down",
      ArrowUp: "up",
      k: "up",
      G: "last",
      Enter: "edit",
      i: "edit",
      p: "below",
      P: "above",
      u: "undo",
      o: "add-below",
      O: "add-above",
      Escape: "escape",
    }[e.key] ?? null
  );
}

const opened = ({ context }) => context.open;
const held = (context, id) => context.drafts.some((d) => d.id === id);

const typable = ({ context, event }) =>
  context.open && writable(context) && held(context, event.id) && FIELDS.includes(event.field) && typeof event.value === "string";

// A box holds one line: a line break typed or pasted becomes a space.
// Typing in a value line Use replaced ends its Undo, so Undo never takes back what was
// typed since.
const edit = enqueueActions(({ context, event, enqueue }) => {
  enqueue.assign({
    drafts: context.drafts.map((d) => (d.id === event.id ? { ...d, [event.field]: event.value.replace(/\s*\n+\s*/g, " ") } : d)),
    dirty: true,
    edited: context.edited.includes(event.id) ? context.edited : [...context.edited, event.id],
  });
  if (context.used?.id === event.id && event.field === "name") {
    enqueue.cancel("used");
    enqueue.assign({ used: null });
  }
});

// A row of today's open sheet that is not waiting out its undo window can be moved.
const movable = (context, id) => context.open && writable(context) && held(context, id) && !context.removing.includes(id);

function reorderNow(enqueue, context, id, to) {
  const drafts = moved(context.drafts, id, to);
  enqueue.assign({ drafts, dirty: false });
  save(enqueue, context, savedValues(drafts));
}
const reorder = (where) =>
  enqueueActions(({ context, event, enqueue }) => {
    const { id, to } = where({ context, event });
    enqueue.assign({ pasted: null });
    reorderNow(enqueue, context, id, to);
  });

// Opening shows the shown day's version; today with none yet opens on one empty row.
const openSheet = assign(({ context }) => {
  const values = copy(context.version?.values ?? []);
  return { open: true, drafts: values.length || !writable(context) ? values : [blank(context.mint())], browsing: false, viewing: null };
});

// Folding saves what was typed; a value waiting out its undo window keeps waiting, so Undo
// is still there when the sheet opens again.
const fold = enqueueActions(({ enqueue }) => {
  enqueue(leaveAll);
  enqueue(endUse);
  enqueue.assign({ open: false, drafts: [], edited: [], browsing: false, viewing: null, cut: null, pasted: null, pointed: { hover: null, tap: null, cursor: null } });
  enqueue.stopChild("lookup");
});

const unplace = enqueueActions(({ context, enqueue }) => {
  enqueue.emit({ type: "values.placed", day: context.day, placed: false });
  enqueue.assign({ placed: false });
});

export const machine = setup({
  actors: {
    // The shown day's version and the days the values changed; the day rides along so a
    // reply for a day left meanwhile is dropped.
    load: fromPromise(async ({ input }) => {
      const [read, versions] = await Promise.all([
        input.ask("values", "read", { day: input.day }),
        input.ask("values", "versions", {}),
      ]);
      return { read, versions };
    }),
    // After a change: the days worth listing and whether the shown day's values changed
    // since, for the day asked about.
    recount: fromPromise(async ({ input }) => {
      const [read, versions] = await Promise.all([
        input.ask("values", "read", { day: input.day }),
        input.ask("values", "versions", {}),
      ]);
      return { day: input.day, read, versions };
    }),
    // The day's checks, and the evaluators, each asked on its own so each reply is kept
    // the moment it lands, before the events it holds back (4.2). The day rides along so a
    // reply for a day left meanwhile is dropped. On a page without value-checks the reply
    // is no-answerer and no line is marked.
    checks: fromPromise(({ input }) =>
      input.ask("value-checks", "read", { day: input.day }).then((reply) => ({ day: input.day, reply })),
    ),
    evaluators: fromPromise(({ input }) =>
      input.ask("evaluators", "list", { day: input.day }).then((reply) => ({ day: input.day, reply })),
    ),
    // Could be's suggestions, every one kept; on a page without generators the reply is
    // no-answerer and nothing is suggested.
    suggestions: fromPromise(({ input }) => input.ask("generators", "results", { generator: SUGGESTER })),
    // On a page without a settings fact the ask replies no-answerer and Vim stays off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Another version looked at in place: the current one, or an earlier day's.
    lookup: fromPromise(({ input }) =>
      input
        .ask("values", "read", input.asked ? { day: input.asked } : {})
        .then((reply) => ({ day: input.day, kind: input.kind, reply })),
    ),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "values-sheet",
  meta: {
    description:
      "Shows the client's values on the journal days the user added them to, under the day's " +
      "text and above the choice points, in a section headed \"Your values\": a folded card " +
      "that lists the values' names on one line; pressing it, or anywhere on the folded " +
      "section, opens the sheet. Whether a day shows the panel is the values fact's (values: " +
      "read's placed, and values.changed after, also from another device). Today's page " +
      "without it shows a muted + Your values row, which adds the panel to the day " +
      "(values.placed) and opens the sheet; the open sheet's Remove from this day folds it and " +
      "takes it off the day again, leaving the values untouched, so + Your values is the one " +
      "step back, and Done on an added panel with no values takes it off too. An earlier day " +
      "shows the panel, read only, only if it was added on that day, and never offers + Your " +
      "values. Open, each value is a row of its name " +
      "and an optional example of living it, with a New value row after them; with " +
      "no values yet today's added panel shows a muted Write your values row, and an earlier " +
      "day with none shows nothing. The boxes take Vim's keys when Vim keys is on, where p pastes " +
      "text or a link copied in the reader with Vim keys, its paragraphs joined into the " +
      "box's one line; Enter or Tab " +
      "moves on to the next box. A day shows the values as they stood on that day. They are " +
      "written on today's page only, as the journal page says from day.shown; from midnight " +
      "yesterday's sheet is read only, even in the hour its text stays open. On an earlier " +
      "day the sheet is read only, with Close instead of Done, and says Changed since · see " +
      "today's when the values changed after that day, which shows the current values in " +
      "place, read only, with Back. Done, or Escape, folds the sheet; with Vim keys on, the " +
      "first Escape in a box leaves insert mode and the next puts the keyboard on the row. Removing a value strikes it through with " +
      "Undo and a draining bar for the undo window; once it ends the value is gone from " +
      "today's version, and earlier days keep theirs. The window goes on while the sheet is " +
      "folded, and moving to another day ends it at once. A row whose name and sentence are " +
      "both empty is not saved. The footer says Changed today when today's version was " +
      "written today, or when the shown version was written, and Earlier versions with how " +
      "many there are, which lists their days; picking one shows that version, read only. " +
      "Which days are listed, and whether Changed since is offered, is the values fact's to " +
      "say, and is asked again after every change. " +
      "What is written is saved a short time into typing and at once when a box loses focus " +
      "or the sheet folds; a save made as the user leaves a row they typed in (Enter or Tab " +
      "on to the next row, the box losing focus, or Done) names that row as finished, so its " +
      "lines are checked then and not while they are typed. When the page hands it the keyboard, it lands on the folded card, " +
      "the + Your values row or the Write your values row, or, open, on the first box, or on a button when the " +
      "sheet is only read. When Settings names an evaluator to check the values or the " +
      "examples, and the account has its own Jev key, Jev's marks stand at the right end of " +
      "a line the user has finished, inside its box: a pulsing dot while Jev is checking, " +
      "then a mark per answer, green when it is the answer the evaluator's question expects, " +
      "red when not, uncoloured when it expects none, solid when Jev is sure and faded when " +
      "it is not, with the icon the evaluator gives the option answered, or a check, or a " +
      "warning for a red one. A line edited since it was checked has no mark until it is " +
      "checked again. The answer's name, and for a red mark the expected one (\"A goal · you " +
      "expect A way of acting\"), is said in a status line in the footer while the pointer is " +
      "over a mark, after a mark is tapped until something else is pressed, or while the text " +
      "cursor is in a checked line; otherwise it says why Jev could not check, or nothing. A " +
      "read-only row, on an earlier day or waiting out its undo window, shows its marks after " +
      "the text. The folded card shows a red warning beside a value whose value or example " +
      "has a red mark. Today's values can be put in another order: each row has up and down " +
      "buttons, shown while the pointer or the keyboard is on the row and always on a phone, " +
      "and Alt+Up or Alt+Down in a box moves its row and keeps the cursor where it was; the " +
      "opposite move undoes one. With Vim keys on, Escape in a box in normal mode puts the " +
      "keyboard on the row; there j, k or the arrow keys, gg and G move between rows, Enter " +
      "or i goes back into the value, o and O add a value below or above, and Escape folds " +
      "the sheet; dd cuts the row, shown greyed as Cut, p puts it below the row the keyboard " +
      "is on and P above, u on the cut row puts it back, and u after a paste undoes it; " +
      "Escape while a row is cut removes it, with Undo and the draining bar. A move is saved " +
      "with the order and asks Jev nothing. On today's sheet, under the example of a value whose " +
      "line Jev answered with a red mark, a muted line says Could be and the value the generator Could be " +
      "suggested (`generators: results` and generation.changed), with Use; it shows only while " +
      "the suggestion was made from the value, its example and the red answers as they are now. " +
      "Use puts the suggestion in the value line, trimmed and without a closing full stop, " +
      "keeps the example, and saves the row as finished, so Jev checks the new value; then " +
      "Was and the old value, with Undo and the draining bar, stand there for the undo window, " +
      "and Undo puts the old value back, saved the same way. Typing in that line, folding the " +
      "sheet or moving to another day ends the Undo. Earlier days show no suggestion.",
    kind: "view",
    emits: ["values.saved", "values.placed"],
    asks: ["values: read", "values: versions", "settings: read", "value-checks: read", "evaluators: list", "generators: results"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Puts text copied in the reader in Vim's unnamed register, so p pastes it.
    pushRegister: input.pushRegister,
    mint: input.mint,
    now: input.now,
    throttleMs: input.throttleMs ?? 400,
    undoMs: input.undoMs ?? 3000,
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
    // The shown day's version as the fact last said it: { day, values, changedSince },
    // null until the reply lands.
    version: null,
    // Whether the shown day shows Your values, as the fact last said it; null until it has.
    placed: null,
    // The days a version was written, oldest first.
    days: [],
    // Changes that arrived before the starting picture, applied after it.
    early: [],
    open: false,
    drafts: [],
    dirty: false,
    // The ids of the rows typed in since the user last left them (values.saved's finished).
    edited: [],
    // The ids of the values waiting out their undo window.
    removing: [],
    // The list of earlier versions is shown, or another version is looked at:
    // { kind: "current" | "earlier", day, values }.
    browsing: false,
    viewing: null,
    vimKeys: false,
    // What value-checks last said for the shown day: the settings, each value's checked
    // lines, and why the last check failed; and the evaluators, for what each answer means.
    checks: { settings: null, reports: {}, error: null },
    evaluators: [],
    // The line whose answers the status line says, by how it was pointed at: each
    // { id, field, text } or null.
    pointed: { hover: null, tap: null, cursor: null },
    // The id of the row cut with dd, waiting for p or P; and the place a row had before
    // the last paste, { id, index }, so u can take the paste back.
    cut: null,
    pasted: null,
    // Could be: its results by value id ({ text, source, version }), the hash of each
    // source worked out so far (null while it is being worked out), and the value line
    // just replaced by Use, { id, was, now }, while its Undo lasts.
    suggestions: {},
    hashes: {},
    used: null,
    sha256: input.sha256 ?? sha256,
  }),
  // Beside the states, so the preference arrives whatever the sheet is doing; a
  // settings.changed that races it is held until the reply lands (4.2).
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    onError: { actions: [] },
  },
  entry: [
    spawnChild("checks", { id: "checks", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
    spawnChild("evaluators", { id: "evaluators", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
    spawnChild("suggestions", { id: "suggestions", input: ({ context }) => ({ ask: context.ask }) }),
  ],
  initial: "loading",
  on: {
    "xstate.done.actor.checks": {
      guard: ({ context, event }) => event.output?.day === context.day && Array.isArray(event.output.reply?.values),
      actions: [
        assign({ checks: ({ event }) => ({ settings: event.output.reply.settings, reports: reportsOf(event.output.reply.values), error: null }) }),
        hashSources,
      ],
    },
    // A result announced while the ask was open is held until the reply lands (4.2), so
    // the reply never overwrites a newer one.
    "xstate.done.actor.suggestions": {
      guard: ({ event }) => Array.isArray(event.output?.results),
      actions: [
        assign({
          suggestions: ({ context, event }) => {
            const out = { ...context.suggestions };
            for (const r of event.output.results) if (r.generator === SUGGESTER && !(out[r.item]?.version > r.version)) out[r.item] = summaryOf(r);
            return out;
          },
        }),
        hashSources,
      ],
    },
    "generation.changed": {
      guard: ({ context, event }) => event.result?.generator === SUGGESTER && !(context.suggestions[event.result.item]?.version > event.result.version),
      actions: [assign({ suggestions: ({ context, event }) => ({ ...context.suggestions, [event.result.item]: summaryOf(event.result) }) }), hashSources],
    },
    _hashed: { actions: assign({ hashes: ({ context, event }) => ({ ...context.hashes, [event.text]: event.hex }) }) },
    "xstate.done.actor.evaluators": {
      guard: ({ context, event }) => event.output?.day === context.day && Array.isArray(event.output.reply?.evaluators),
      actions: assign({ evaluators: ({ event }) => event.output.reply.evaluators }),
    },
    "values.checked": {
      guard: ({ context, event }) => event.day === context.day,
      actions: [assign({ checks: ({ context, event }) => ({ ...context.checks, reports: reportsOf(event.values), error: event.error ?? null }) }), hashSources],
    },
    "value-checks.changed": { actions: assign({ checks: ({ context, event }) => ({ ...context.checks, settings: event.settings }) }) },
    "evaluator.changed": {
      actions: assign({ evaluators: ({ context, event }) => [...context.evaluators.filter((e) => e.id !== event.evaluator.id), event.evaluator] }),
    },
    "evaluator.deleted": { actions: assign({ evaluators: ({ context, event }) => context.evaluators.filter((e) => e.id !== event.id) }) },
    // The view says which line the pointer is over, which mark was tapped, and which line
    // the text cursor is on; a null field clears that one.
    _point: {
      guard: ({ event }) => POINTS.has(event.source),
      actions: assign({
        pointed: ({ context, event }) => ({
          ...context.pointed,
          [event.source]:
            FIELDS.includes(event.field) && typeof event.text === "string" && typeof event.id === "string"
              ? { id: event.id, field: event.field, text: event.text }
              : null,
        }),
      }),
    },
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the
    // system clipboard, so it goes there too, as copied; the box makes it one line (edit).
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // Moving to another day settles the sheet and asks for the new day's version. The
    // same day saying it can no longer be written saves what was typed while it could.
    "day.shown": [
      {
        guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
        target: ".loading",
        actions: [
          leaveAll,
          finishRemovals,
          endUse,
          stopChild("lookup"),
          stopChild("recount"),
          assign(({ context, event }) => ({
            day: event.day,
            dayWritable: typeof event.writable === "boolean" ? event.writable : null,
            version: null,
            placed: null,
            early: [],
            open: false,
            drafts: [],
            dirty: false,
            edited: [],
            browsing: false,
            viewing: null,
            checks: { settings: context.checks.settings, reports: {}, error: null },
            pointed: { hover: null, tap: null, cursor: null },
            cut: null,
            pasted: null,
          })),
          stopChild("checks"),
          spawnChild("checks", { id: "checks", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
          stopChild("evaluators"),
          spawnChild("evaluators", { id: "evaluators", input: ({ context }) => ({ ask: context.ask, day: context.day }) }),
        ],
      },
      {
        guard: ({ event }) => isDay(event.day),
        actions: [saveWaiting, assign({ dayWritable: ({ event }) => (typeof event.writable === "boolean" ? event.writable : null) })],
      },
    ],
    "xstate.done.actor.recount": {
      guard: ({ context, event }) => event.output?.day === context.day && context.version != null,
      actions: assign(({ context, event }) => {
        const { read, versions } = event.output;
        return {
          days: Array.isArray(versions?.days) ? [...versions.days].sort() : context.days,
          version: typeof read?.changedSince === "boolean" ? { ...context.version, changedSince: read.changedSince } : context.version,
          placed: typeof read?.placed === "boolean" ? read.placed : context.placed,
        };
      }),
    },
    "xstate.done.actor.lookup": {
      guard: ({ context, event }) => event.output?.day === context.day && Array.isArray(event.output.reply?.values),
      actions: assign({
        viewing: ({ event }) => ({ kind: event.output.kind, day: event.output.reply.day, values: copy(event.output.reply.values) }),
        browsing: false,
      }),
    },
  },
  states: {
    // A change the fact makes meanwhile is held for these asks and arrives once their
    // replies have landed (4.2); one let through between the two replies waits in `early`.
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, day: context.day }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.read?.values),
            target: "ready",
            actions: [
              assign(({ event }) => {
                const { read, versions } = event.output;
                return {
                  version: { day: read.day, values: copy(read.values), changedSince: read.changedSince === true },
                  placed: read.placed !== false,
                  days: Array.isArray(versions?.days) ? [...versions.days].sort() : [],
                };
              }),
              enqueueActions(({ context, enqueue }) => {
                for (const e of context.early) enqueue.raise(e);
                enqueue.assign({ early: [] });
              }),
              hashSources,
            ],
          },
          // The fact could not answer: an honest failure rather than no values.
          { target: "failed" },
        ],
        onError: "failed",
      },
      on: {
        "values.changed": { actions: assign({ early: ({ context, event }) => [...context.early, event] }) },
      },
    },
    ready: {
      initial: "idle",
      on: {
        "values.changed": { actions: [follow, hashSources] },
        _open: {
          guard: ({ context }) => !context.open && isPlaced(context),
          actions: openSheet,
        },
        // + Your values adds the panel to today's page and opens it.
        _place: {
          guard: ({ context }) => !context.open && !isPlaced(context) && placeable(context),
          actions: [
            emit(({ context }) => ({ type: "values.placed", day: context.day, placed: true })),
            assign({ placed: true }),
            openSheet,
          ],
        },
        // Remove from this day folds the sheet and takes the panel off today's page; the
        // values are the account's and are not touched, so + Your values brings it back.
        _unplace: {
          guard: ({ context }) => context.open && isPlaced(context) && placeable(context),
          actions: [fold, unplace],
        },
        // Use puts the suggestion in the value line, keeping the example, and offers Undo
        // for the undo window.
        _use: {
          guard: ({ context, event }) => {
            const draft = context.open && writable(context) && !context.removing.includes(event.id) && context.drafts.find((d) => d.id === event.id);
            return Boolean(draft && suggestionFor(context, draft));
          },
          actions: enqueueActions(({ context, event, enqueue }) => {
            const draft = context.drafts.find((d) => d.id === event.id);
            const now = suggestionFor(context, draft);
            rename(enqueue, context, draft.id, now);
            enqueue.cancel("used");
            enqueue.assign({ used: { id: draft.id, was: draft.name, now } });
            enqueue.raise({ type: "_used" }, { delay: context.undoMs, id: "used" });
          }),
        },
        // Undo puts back the value line Use replaced.
        _unuse: {
          guard: ({ context }) => context.used !== null && context.open && writable(context) && held(context, context.used.id),
          actions: enqueueActions(({ context, enqueue }) => {
            rename(enqueue, context, context.used.id, context.used.was);
            enqueue.cancel("used");
            enqueue.assign({ used: null });
          }),
        },
        _used: { actions: assign({ used: null }) },
        _add: {
          guard: ({ context }) => context.open && writable(context),
          // At the end, or at index `at` (Vim's o and O on a row).
          actions: assign(({ context, event }) => {
            const at = Number.isInteger(event.at) ? Math.max(0, Math.min(context.drafts.length, event.at)) : context.drafts.length;
            return { drafts: [...context.drafts.slice(0, at), blank(context.mint()), ...context.drafts.slice(at)] };
          }),
        },
        // A box lost focus: its row is left unless the keyboard went to the other box of
        // the same row (`to` names the row it went to, null for anywhere else).
        _blur: { guard: opened, actions: leaveRows(({ event }) => (event.id && event.to !== event.id ? [event.id] : [])) },
        // Done folds the sheet, saving what was typed; a value waiting out its undo window
        // keeps waiting, so Undo is still there when the sheet opens again.
        // An added panel left with no values holds nothing, so Done also takes it off the
        // day, as folding an empty choice point removes it.
        _done: {
          guard: opened,
          actions: [
            enqueueActions(({ context, enqueue }) => {
              const empty = placeable(context) && !savedValues(context.drafts).length && !(context.version?.values ?? []).length;
              enqueue(fold);
              if (empty) enqueue(unplace);
            }),
          ],
        },
        // An empty row holds nothing to lose, so it goes at once; a value waits out the
        // undo window.
        _remove: {
          guard: ({ context, event }) => context.open && writable(context) && held(context, event.id) && !context.removing.includes(event.id),
          actions: enqueueActions(({ context, event, enqueue }) => {
            const draft = context.drafts.find((d) => d.id === event.id);
            if (context.cut === event.id) enqueue.assign({ cut: null });
            if (isEmpty(draft)) {
              enqueue.assign({ drafts: context.drafts.filter((d) => d.id !== event.id) });
              return;
            }
            enqueue.assign({ removing: [...context.removing, event.id] });
            enqueue.raise({ type: "_gone", id: event.id }, { delay: context.undoMs, id: timerOf(event.id) });
          }),
        },
        _undo: {
          guard: ({ context, event }) => context.removing.includes(event.id),
          actions: enqueueActions(({ context, event, enqueue }) => {
            enqueue.cancel(timerOf(event.id));
            enqueue.assign({ removing: context.removing.filter((id) => id !== event.id) });
          }),
        },
        // The undo window ran out: the value goes from today's version, folded or not.
        _gone: {
          guard: ({ context, event }) => context.removing.includes(event.id),
          actions: enqueueActions(({ context, event, enqueue }) => {
            const removing = context.removing.filter((id) => id !== event.id);
            const drafts = context.drafts.filter((d) => d.id !== event.id);
            const values = (context.open ? drafts : (context.version?.values ?? [])).filter((v) => v.id !== event.id);
            enqueue.assign({ removing, drafts, dirty: false });
            if (context.version) enqueue.assign({ version: { ...context.version, values: savedValues(values) } });
            save(enqueue, context, savedValues(values));
          }),
        },
        // A row moved to stand at index `to` (the up and down buttons, Alt+Up and Alt+Down)
        // is saved with the new order at once, naming no row as finished: Jev's answers
        // are kept by text, so a move asks nothing.
        _move: {
          guard: ({ context, event }) =>
            movable(context, event.id) && Number.isInteger(event.to) && context.drafts.findIndex((d) => d.id === event.id) !== event.to,
          actions: reorder(({ event }) => ({ id: event.id, to: event.to })),
        },
        // dd on a row: it stays where it is, greyed as Cut, until p, P, u or Escape.
        _cut: {
          guard: ({ context, event }) => movable(context, event.id),
          actions: assign({ cut: ({ event }) => event.id, pasted: null }),
        },
        // u on the cut row puts it back: it never left its place.
        _uncut: { guard: ({ context }) => context.cut !== null, actions: assign({ cut: null }) },
        // p or P on a row places the cut row below or above it.
        _paste: {
          guard: ({ context, event }) => context.cut !== null && held(context, event.at),
          actions: enqueueActions(({ context, event, enqueue }) => {
            const id = context.cut;
            const index = context.drafts.findIndex((d) => d.id === id);
            const rest = context.drafts.filter((d) => d.id !== id);
            const at = event.at === id ? index : rest.findIndex((d) => d.id === event.at) + (event.below ? 1 : 0);
            enqueue.assign({ cut: null, pasted: at === index ? null : { id, index } });
            if (at !== index) reorderNow(enqueue, context, id, at);
          }),
        },
        // u after a paste puts the row back where it stood before it.
        _unpaste: {
          guard: ({ context }) => context.pasted !== null && held(context, context.pasted.id),
          actions: enqueueActions(({ context, enqueue }) => {
            enqueue.assign({ pasted: null });
            reorderNow(enqueue, context, context.pasted.id, context.pasted.index);
          }),
        },
        _browse: { guard: opened, actions: assign({ browsing: true, viewing: null }) },
        _see: {
          guard: opened,
          actions: [
            stopChild("lookup"),
            spawnChild("lookup", {
              id: "lookup",
              input: ({ context, event }) => ({
                ask: context.ask,
                day: context.day,
                kind: isDay(event.day) ? "earlier" : "current",
                asked: isDay(event.day) ? event.day : null,
              }),
            }),
          ],
        },
        _back: { actions: [stopChild("lookup"), assign({ browsing: false, viewing: null })] },
      },
      states: {
        idle: {
          on: { _edit: { guard: typable, target: "typing", actions: edit } },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        typing: {
          on: { _edit: { guard: typable, actions: edit } },
          after: { throttle: { target: "idle", actions: saveWaiting } },
        },
      },
    },
    failed: {},
  },
});
