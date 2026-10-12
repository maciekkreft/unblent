import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component where the user writes the journal (6.4), the stage of the journal
// app. It owns only UI state — which day is shown, the text being typed as a draft,
// whether typing is waiting to be saved, whether the box has the keyboard, and a
// conflict the user has not settled — and points at three facts: it asks journal: read,
// llm: read and settings: read for the starting picture and follows journal.changed,
// llm.changed and settings.changed after (4.3, fourth rule); settings only for the "Vim
// keys" preference (12). Writing leaves as day.saved, at a throttle while typing and at once
// on blur with `left`, so the paragraph being written counts as finished (4.3, third
// rule); whether a save lands is the journal's to decide, because the "today only" rule
// lives there. The ask, the id minting, the clock and the throttle arrive through input,
// so the machine is importable in Node.

const HOUR = 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, "0");

// The device's local date at `ms`, as YYYY-MM-DD, as the journal dates a day.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A local time as HH:MM on the 24-hour clock whatever the browser's locale, so the
// banner and the Days list name the same moment the same way.
export const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const calendar = (day) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
};

// A day's title, "Monday 12 October".
export const longDate = (day) =>
  calendar(day).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }).replace(",", "");

// The paragraphs of a day's text, in order, trimmed. A line break ends a paragraph; while
// the box is being typed in, the line at the end is unfinished, otherwise every paragraph
// is finished. Copied from journal's paragraphs, because components never import each
// other (11.2): the margin must split the text the way the fact asks Jev about it. `line`
// (1-based) is this view's addition: where the editor draws the paragraph's margin.
export const paragraphs = (text, editing) => {
  const lines = text.split("\n");
  const out = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t) out.push({ text: t, finished: !editing || i < lines.length - 1, line: i + 1 });
  });
  return out;
};

const live = (items) => items.filter((x) => !x.removing);

// A question the journal asks Jev: not blank, and a pick question with at least two options.
const askable = (q) => q.text.trim() !== "" && (q.kind !== "pick" || live(q.options).length >= 2);

// The projects that read the writing now, each with its detectors that do and their
// questions, in stored order; a project or detector with nothing to ask is left out.
export const reading = (projects, detectors) =>
  live(projects)
    .filter((p) => p.on)
    .map((p) => ({
      id: p.id,
      name: p.name.trim() || "Untitled project",
      detectors: live(detectors)
        .filter((d) => d.on && d.project === p.id)
        .map((d) => ({ id: d.id, name: d.name.trim() || "Untitled detector", questions: live(d.questions).filter(askable) }))
        .filter((d) => d.questions.length > 0),
    }))
    .filter((p) => p.detectors.length > 0);

const pct = (p) => Math.round(p * 100);

// The pick by the name it had when Jev was asked, so an option renamed or removed since
// still reads as what Jev answered.
const pickName = (q, a) => {
  const found = a.wording.options.find((o) => o.id === a.answer.choice) ?? q.options.find((o) => o.id === a.answer.choice);
  return found ? found.name.trim() || "Untitled option" : "Removed option";
};

// The wording an answer was asked with, as its "earlier wording" tag shows it on hover:
// the question, and its options or what yes and no meant, since a change to those alone
// also makes the wording earlier.
export const asked = (kind, w) => {
  const lines = [`Asked as: ${w.text}`];
  if (kind === "pick" && w.options.length) lines.push(`Options: ${w.options.map((o) => o.name).join(", ")}`);
  if (kind === "yesno" && w.yes) lines.push(`Yes means: ${w.yes}`);
  if (kind === "yesno" && w.no) lines.push(`No means: ${w.no}`);
  return lines.join("\n");
};

// One answer as the margin shows it: a pick and "sure n%", or "unsure" below 40%; a yes /
// no question with the chance of yes, toned yes at 60% or more and no at 40% or less, as
// Judge colours it. `earlier` is the wording it was asked with, when that has changed.
export const entry = (q, a) => {
  const earlier = a.earlier ? asked(q.kind, a.wording) : null;
  const n = pct(a.answer.p);
  if (q.kind === "pick") return { id: q.id, kind: "pick", pick: pickName(q, a), sure: n < 40 ? "unsure" : `sure ${n}%`, earlier };
  return { id: q.id, kind: "yesno", text: q.text.trim(), pct: n, tone: n >= 60 ? "yes" : n <= 40 ? "no" : "", earlier };
};

// One row per paragraph of the shown text: the paragraph, and in its margin either "Not
// finished yet", "Judging…", or Jev's answers to the questions that read the writing now,
// grouped by detector and, when more than one project reads, under each project's name.
// `editing` is true only while the open day's box is being typed in.
export const margins = (text, editing, day, picture) => {
  const groups = reading(picture.projects, picture.detectors);
  const byKey = new Map(picture.answers.map((a) => [`${a.answer.id}\n${a.text}`, a]));
  const named = groups.length > 1;
  return paragraphs(text, editing).map((p) => {
    if (!p.finished) return { text: p.text, line: p.line, state: "unfinished" };
    if (day.waiting.includes(p.text)) return { text: p.text, line: p.line, state: "waiting" };
    const projects = groups
      .map((g) => ({
        id: g.id,
        name: named ? g.name : null,
        detectors: g.detectors
          .map((d) => ({
            id: d.id,
            name: d.name,
            entries: d.questions.flatMap((q) => {
              const a = byKey.get(`${q.id}\n${p.text}`);
              return a ? [entry(q, a)] : [];
            }),
          }))
          .filter((d) => d.entries.length > 0),
      }))
      .filter((g) => g.detectors.length > 0);
    return { text: p.text, line: p.line, state: "answered", projects };
  });
};

// The day the entry shows: the earlier day picked in the Days list, read only; else the
// open day; else a new page for today under a fresh id, which becomes a day at its
// first character.
export const shown = (picture, selected, fresh, now) => {
  const open = picture.days.find((d) => d.id === picture.open);
  const picked = selected && selected !== picture.open ? picture.days.find((d) => d.id === selected) : null;
  if (picked) return { day: picked, editable: false };
  if (open) return { day: open, editable: true };
  return { day: { id: fresh, day: dateOf(now), text: "", editedAt: now, version: 1, waiting: [], unanswered: [] }, editable: true };
};

// Past midnight the open day stays open until an hour after its last edit; the banner
// names that moment. Before midnight, or on a day that is not open, there is none.
export const banner = (day, editable, now) =>
  editable && day.day < dateOf(now) ? `Keep writing. This entry closes at ${clock(day.editedAt + HOUR)}.` : null;

// What Judge this day would ask about: the paragraphs of an earlier day that some
// detector on now has not answered with its current wording. None on the open day,
// which is asked about as it is written.
export const toJudge = (day, editable) => (editable ? 0 : day.unanswered.length);

// The line beside Judge once a new account has used its starter requests (12): case-editor's sentence.
const USED_UP = "The 100 starter requests are used up. Add your Jev key in Settings.";

// Why Jev is not reading the writing, in Judge's words (case-editor's lines), or null.
// The journal reports one reason for no detector on; the picture tells which of Judge's
// three lines fits.
export const reasonLine = (picture, usedUp) => {
  switch (picture.reason) {
    case null:
      return null;
    case "signed-out":
      return "Sign in to judge.";
    case "no-key":
      return usedUp ? USED_UP : "Add your Jev key in Settings.";
    case "no-detector": {
      const on = new Set(live(picture.projects).filter((p) => p.on).map((p) => p.id));
      const mine = live(picture.detectors).filter((d) => on.has(d.project));
      if (!mine.length) return "Make a detector in Detectors to judge.";
      if (!mine.some((d) => d.on)) return "Switch on a detector in Detectors to judge.";
      return "Add a question to a detector to judge.";
    }
    case "bad-key":
      return "Jev did not accept the key. Replace it in Settings.";
    case "rate-limited":
      return "Jev is rate-limiting; try again in a moment.";
    case "overloaded":
      return "Jev is overloaded; try again in a moment.";
    case "invalid":
      return "Jev refused the questions.";
    default:
      return "Jev is unavailable.";
  }
};

// Judge this day cannot ask while signed out or without a key; after a failed request,
// pressing it is how the user tries again.
export const canJudge = (picture) => picture.reason !== "signed-out" && picture.reason !== "no-key";

// A conflict on the shown day, or null. Keeping one's own copy saves it over the other,
// which the journal accepts only while the day is open; a closed day keeps the other.
export const conflictOn = (conflict, day, editable) =>
  conflict && conflict.id === day.id ? { mine: conflict.mine.text, theirs: conflict.theirs.text, keepable: editable } : null;

const EMPTY = { days: [], projects: [], detectors: [], answers: [], open: null, reason: null };

const picture = (event) => ({
  days: event.days,
  projects: event.projects,
  detectors: event.detectors,
  answers: event.answers,
  open: event.open,
  reason: event.reason,
});

const isPicture = (r) => Array.isArray(r?.days) && Array.isArray(r?.answers);

// The draft follows the day the box edits. While typing waits to be saved, the same day
// keeps what is on screen; another day starts from what the journal holds. A fresh id
// that has become a day is replaced, so the next new page is a new day.
const settle = (context, next, dirty) => {
  const fresh = next.days.some((d) => d.id === context.fresh) ? context.mint() : context.fresh;
  const view = shown(next, context.selected, fresh, context.now());
  const editable = view.editable ? view.day : null;
  const same = Boolean(editable) && context.draft?.id === editable.id;
  return {
    picture: next,
    fresh,
    draft: dirty && same ? context.draft : editable ? { id: editable.id, text: editable.text } : null,
    // The box is still being typed in until it is left, whatever the journal echoes.
    ...(same ? {} : { editing: false }),
  };
};

// A save the journal can use: an existing day's, or a new page with something written.
const savable = (context) =>
  Boolean(context.draft) && (context.picture.days.some((d) => d.id === context.draft.id) || context.draft.text !== "");

const save = (left) =>
  enqueueActions(({ context, enqueue }) => {
    if (!savable(context)) return;
    const { id, text } = context.draft;
    enqueue.emit(left ? { type: "day.saved", id, text, left: true } : { type: "day.saved", id, text });
  });

const edit = assign(({ context, event }) => ({ draft: { ...context.draft, text: event.text }, editing: true }));

const follow = (dirty) => assign(({ context, event }) => settle(context, picture(event), dirty));

// Another day picked: what is being typed is saved first, then the entry follows.
const select = (dirty) => ({
  target: "clean",
  actions: [
    ...(dirty ? [save(false)] : []),
    assign(({ context, event }) => ({ ...settle({ ...context, selected: event.id }, context.picture, false), selected: event.id })),
  ],
});

const view = (context) => shown(context.picture, context.selected, context.fresh, context.now());

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("journal", "read", {})),
    llm: fromPromise(({ input }) => input.ask("llm", "read", {})),
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "journal-entry",
  meta: {
    description:
      "The journal's page: the day picked in the Days list, or the day that can still be " +
      "edited, or an empty page for today. The day's text is shown once, in one editor, read only " +
      "on an earlier day, with Vim when the Vim keys setting is on. Each paragraph has Jev's " +
      "answers in a margin beside it, level with its first line, or under it on a phone, grouped under each project's name when more than one project " +
      "is on. A pick-one question shows the pick and \"sure n%\", or \"unsure\" below 40%; a yes / " +
      "no question shows the chance of yes in Judge's colours. A paragraph waiting for Jev says " +
      "\"Judging…\", and the paragraph being written says \"Not finished yet\": a paragraph is " +
      "finished at a line break, and every paragraph is finished when the box loses focus or the " +
      "entry closes. An answer to a question whose wording has changed since is tagged " +
      "\"earlier wording\", and hovering shows the old wording. The status line says the entry " +
      "is open until midnight or an hour after the last edit, and past midnight a banner says " +
      "when it closes. Earlier days are read only, with Judge this day when something is not " +
      "answered with the current wording. One line says why Jev is not reading, in Judge's " +
      "words. The text is saved a short time into typing and when the box loses focus, and that " +
      "last save says the box was left, so the paragraph being written counts as finished. When " +
      "a day was saved on two devices at once, the entry shows both copies and the user keeps " +
      "one.",
    kind: "view",
    emits: ["day.saved", "day.judging.requested"],
    attributes: [],
    asks: ["journal: read", "llm: read", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    now: input.now,
    throttleMs: input.throttleMs ?? 200,
    picture: EMPTY,
    // The id a new page for today is saved under, once something is written on it.
    fresh: input.mint(),
    // The day picked in the Days list; null follows the open day.
    selected: null,
    draft: null,
    editing: false,
    usedUp: false,
    conflict: null,
    // The "Vim keys" device preference (12), owned by `settings`: off until it says
    // otherwise, and off on a page without it (the ask replies no-answerer).
    vimKeys: false,
  }),
  // Each fact's starting picture is asked on its own, so an event that follows one
  // reply is never overwritten by that reply arriving with the other.
  invoke: [
    {
      src: "llm",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign(({ event }) => ({ usedUp: event.output?.jev?.starterLeft === 0 })) },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    },
  ],
  initial: "loading",
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => isPicture(event.output),
            target: "ready",
            actions: assign(({ context, event }) => settle(context, picture(event.output), false)),
          },
          // The journal could not answer: an honest failure rather than an empty page.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      initial: "clean",
      states: {
        clean: {
          on: {
            _edit: { guard: ({ context }) => Boolean(context.draft), target: "dirty", actions: edit },
            _blur: { guard: ({ context }) => context.editing, actions: [save(true), assign({ editing: false })] },
            "journal.changed": { actions: follow(false) },
            "day.selected": select(false),
          },
        },
        // Typing within the window joins the one save at its end: a throttle, not a
        // debounce, so the targetless edits below never restart the timer.
        dirty: {
          on: {
            _edit: { actions: edit },
            _blur: { target: "clean", actions: [save(true), assign({ editing: false })] },
            "journal.changed": { actions: follow(true) },
            "day.selected": select(true),
          },
          after: { throttle: { target: "clean", actions: save(false) } },
        },
      },
      on: {
        _judge: {
          guard: ({ context }) => {
            const { day, editable } = view(context);
            return toJudge(day, editable) > 0 && canJudge(context.picture);
          },
          actions: enqueueActions(({ context, enqueue }) => enqueue.emit({ type: "day.judging.requested", id: view(context).day.id })),
        },
        // A conflict is settled in one step. Keeping one's own copy saves it over the
        // other while the day is open; keeping the other's saves nothing, because the
        // journal already holds it.
        _keepMine: {
          guard: ({ context }) => Boolean(context.conflict) && context.picture.open === context.conflict.id,
          target: ".clean",
          actions: [
            assign(({ context }) => ({ draft: { id: context.conflict.id, text: context.conflict.mine.text }, conflict: null, editing: false })),
            save(false),
          ],
        },
        _keepTheirs: { actions: assign({ conflict: null }) },
      },
    },
    failed: {},
  },
  // The facts' news (4.3, fourth rule). Each read is superseded by its fact's event (4.2),
  // so none arrives before the starting picture it updates.
  on: {
    "journal.changed": { actions: assign(({ event }) => ({ picture: picture(event) })) },
    "journal.conflicted": { actions: assign(({ event }) => ({ conflict: { id: event.id, mine: event.mine, theirs: event.theirs } })) },
    "llm.changed": { actions: assign(({ event }) => ({ usedUp: event.jev?.starterLeft === 0 })) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "day.selected": { actions: assign(({ event }) => ({ selected: event.id })) },
  },
});
