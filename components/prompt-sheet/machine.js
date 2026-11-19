import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that shows the journal prompts sheets of the journal day on the page
// (6.4). It owns only UI state — the day shown, that day's sheets as the fact last announced
// them, the account's prompt sets as `prompt-sets` last announced them, which sheets are open,
// their drafts, and which wait to be saved — and points at two facts: it asks
// prompt-sheets: list for the shown day and prompt-sets: list, and follows their events after
// (4.3, fourth rule). The day comes from day.shown, so the rule for which day the journal
// shows stays in journal-entry. Writing leaves as prompt-sheet.saved, at a throttle while
// typing and at once, with finished, when a box loses the keyboard or the sheet folds (4.3,
// third rule); a save with every answer empty is how `prompt-sheets` learns to remove a kept
// one, and deleted: true removes one whatever it holds. The ask, the send, the id minting,
// the clock and the throttle arrive through input, so the machine is importable in Node.

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the journal
// page first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A new sheet names no set until the user picks one; until then it shows the sets.
const blank = (id, day) => ({ id, day, setId: null, setName: "", basedOn: "", answers: [] });
const draftOf = (r) => ({
  id: r.id,
  day: r.day,
  setId: r.setId,
  setName: r.setName,
  basedOn: r.basedOn,
  answers: r.answers.map(({ prompt, answer }) => ({ prompt, answer })),
});

export const isEmpty = (d) => !d.setId || d.answers.every((a) => !a.answer.trim());

const held = (context, id) => context.sheets.find((r) => r.id === id);

// Sheets are written exactly while the day's own text is: the journal page says so in
// day.shown, which keeps yesterday open until 2:00 (13, Journal). Before it has said, only
// today's date is written on. An earlier day's sheets open to be read.
export const writable = (context) => context.dayWritable ?? context.day === dateOf(context.now());

export const draftIn = (context, id) => context.drafts.find((d) => d.id === id);

// A sheet with every answer empty is never saved while it is open: to `prompt-sheets` that
// save removes a kept one, and the user may be clearing a box only to write it again.
const saveOne = (enqueue, draft, finished = false) => {
  if (!draft || isEmpty(draft)) return false;
  const { id, day, setId, setName, basedOn, answers } = draft;
  enqueue.emit({ type: "prompt-sheet.saved", id, day, setId, setName, basedOn, answers, ...(finished ? { finished: true } : {}) });
  return true;
};

const without = (list, id) => list.filter((x) => (x.id ?? x) !== id);

// Every open sheet with typing that waits to be saved is saved, at the throttle's end. An
// emptied one stays waiting, so a change from the fact does not refill what was cleared.
const saveWaiting = enqueueActions(({ context, enqueue }) => {
  enqueue.assign({ dirty: context.dirty.filter((id) => !saveOne(enqueue, draftIn(context, id))) });
});

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byPosition = (a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : byId(a, b));

// The day's sheets after one change from the fact. Another day's change passes by; an older
// version than the one held is stale (4.3), and an equal one may carry a new pending flag or
// a judgement, so it is taken.
const changedList = (context, event) => {
  if (event.type === "prompt-sheet.deleted") return context.sheets.filter((r) => r.id !== event.id);
  const r = event.sheet;
  if (r.day !== context.day) return context.sheets;
  const was = held(context, r.id);
  if (was && r.version < was.version) return context.sheets;
  return [...context.sheets.filter((x) => x.id !== r.id), r].sort(byId);
};

// Each open sheet follows a change only while nothing typed in it waits to be saved, so a
// change never overwrites what is on screen. One that is gone closes.
const follow = enqueueActions(({ context, event, enqueue }) => {
  const sheets = changedList(context, event);
  let { drafts, dirty, touched } = context;
  for (const draft of context.drafts) {
    const record = sheets.find((r) => r.id === draft.id);
    if (!record && held(context, draft.id)) {
      drafts = without(drafts, draft.id);
      dirty = without(dirty, draft.id);
      touched = without(touched, draft.id);
    } else if (record && !dirty.includes(draft.id)) drafts = drafts.map((d) => (d.id === draft.id ? draftOf(record) : d));
  }
  enqueue.assign({ sheets, drafts, dirty, touched });
});

const opened = (context, event) => Boolean(draftIn(context, event.id));

// The sheets left unfolded on the day before a reload open again, in the order they were
// opened; one no longer kept, or not of this day, is skipped.
const reopened = (context, sheets) =>
  context.unfolded
    .read(context.day)
    .map((id) => sheets.find((r) => r.id === id && r.day === context.day))
    .filter(Boolean)
    .map(draftOf);

const typable = ({ context, event }) => {
  const draft = draftIn(context, event.id);
  return writable(context) && Boolean(draft?.setId) && Number.isInteger(event.index) && event.index >= 0 && event.index < draft.answers.length && typeof event.value === "string";
};

const edit = assign(({ context, event }) => ({
  drafts: context.drafts.map((d) =>
    d.id === event.id ? { ...d, answers: d.answers.map((a, i) => (i === event.index ? { ...a, answer: event.value } : a)) } : d,
  ),
  dirty: context.dirty.includes(event.id) ? context.dirty : [...context.dirty, event.id],
  touched: context.touched.includes(event.id) ? context.touched : [...context.touched, event.id],
}));

// Remove from this day takes the sheet away whatever it holds, which `prompt-sheets` makes a
// step Undo takes back with the short notice (12, Undo). What was typed and waits goes first,
// so the Undo brings back all of it. A new one with nothing written was never kept, so
// nothing is sent.
const discard = enqueueActions(({ context, event, enqueue }) => {
  const draft = draftIn(context, event.id);
  if (context.dirty.includes(draft.id)) saveOne(enqueue, draft);
  if (held(context, draft.id) || !isEmpty(draft)) {
    const { id, day, setId, setName, basedOn, answers } = draft;
    enqueue.emit({ type: "prompt-sheet.saved", id, day, setId, setName, basedOn, answers, deleted: true });
  }
  enqueue.assign({ drafts: without(context.drafts, event.id), dirty: without(context.dirty, event.id), touched: without(context.touched, event.id) });
});

// Done folds the one sheet, saving it with its stretch of typing finished. Folded with every
// answer empty, a kept one is deleted by that save (12, Undo); a new one, or one still
// showing the sets, was never kept, so nothing is sent.
const fold = enqueueActions(({ context, event, enqueue }) => {
  const draft = draftIn(context, event.id);
  const changed = context.touched.includes(draft.id) || context.dirty.includes(draft.id);
  if (writable(context) && draft.setId && isEmpty(draft) && held(context, draft.id)) {
    const { id, day, setId, setName, basedOn, answers } = draft;
    enqueue.emit({ type: "prompt-sheet.saved", id, day, setId, setName, basedOn, answers, finished: true });
  } else if (writable(context) && changed) saveOne(enqueue, draft, true);
  enqueue.assign({ drafts: without(context.drafts, event.id), dirty: without(context.dirty, event.id), touched: without(context.touched, event.id) });
});

// A box losing the keyboard saves its sheet at once and ends the stretch of typing, so the
// fact records one step for it and checks its answers.
const settle = enqueueActions(({ context, event, enqueue }) => {
  const draft = draftIn(context, event.id);
  if (!writable(context) || !context.touched.includes(draft.id)) return;
  if (saveOne(enqueue, draft, true)) enqueue.assign({ dirty: without(context.dirty, draft.id), touched: without(context.touched, draft.id) });
});

// Picking a set gives the sheet its prompts, each with an empty answer; it is kept once
// something is written.
const pick = assign(({ context, event }) => {
  const set = context.sets.find((s) => s.id === event.setId);
  return {
    drafts: context.drafts.map((d) =>
      d.id === event.id ? { ...d, setId: set.id, setName: set.name, basedOn: set.basedOn, answers: set.prompts.map((prompt) => ({ prompt, answer: "" })) } : d,
    ),
  };
});

// --- What the view draws, decided here --------------------------------------------------

// The sets a new sheet offers: those with a prompt, in the list's order.
export const offeredSets = (context) => context.sets.filter((s) => s.prompts.length > 0);

// How many sets the chooser shows before "N more sets"; all once that is pressed.
export const FIRST_SETS = 4;

export function chooserOf(context, id) {
  const sets = offeredSets(context);
  const all = context.more.includes(id) || sets.length <= FIRST_SETS + 1;
  return { shown: all ? sets : sets.slice(0, FIRST_SETS), more: all ? 0 : sets.length - FIRST_SETS };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The line under a set's name in the chooser.
export const setLine = (set) => `${plural(set.prompts.length, "prompt", "prompts")}${set.basedOn ? ` · based on ${set.basedOn}` : ""}`;

export const moreLine = (n, one, many) => plural(n, one, many);

// A set's occasion, from the set as it is now; none once it is gone.
export const occasionOf = (context, setId) => context.sets.find((s) => s.id === setId)?.occasion ?? "";

// How many answers a folded card lists before "N more answers".
export const CARD_ANSWERS = 3;

// The folded card: the set's name and every answered prompt with its answer, unanswered
// ones left out, the first few listed and the rest counted.
export function cardOf(record) {
  const answered = record.answers.filter((a) => a.answer.trim());
  return { name: record.setName, shown: answered.slice(0, CARD_ANSWERS), more: Math.max(0, answered.length - CARD_ANSWERS) };
}

// Whether the set now asks other prompts than the sheet was answered with; never for a set
// that is gone, which has nothing to compare.
export function changedSince(context, record) {
  const set = context.sets.find((s) => s.id === record.setId);
  if (!set) return false;
  const asked = record.answers.map((a) => a.prompt);
  return asked.length !== set.prompts.length || asked.some((p, i) => p !== set.prompts[i]);
}

// Whether the answer in one box was judged not to respond to its prompt. The judgement is
// the fact's, on the words it holds; once the words on screen differ it no longer applies.
export function offTopic(context, id, index) {
  const kept = held(context, id)?.answers[index];
  const draft = draftIn(context, id);
  const answer = draft ? draft.answers[index]?.answer : kept?.answer;
  return kept?.fits === false && kept.answer === answer && kept.prompt === (draft?.answers[index]?.prompt ?? kept.prompt);
}

// The keys of the list (12, "Vim keys"): the arrows always, and with Vim keys on j, k, gg,
// G, and o to add a sheet. `afterG` is whether a g was pressed just before, which makes this
// g the second of gg; "g" alone waits for its second press. Enter needs nothing here: a
// card, a set and a button are buttons.
const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;
export function rowAction(e, vimKeys, afterG = false) {
  if (!plain(e)) return null;
  const arrow = { ArrowDown: "down", ArrowUp: "up" }[e.key];
  if (arrow || !vimKeys) return arrow ?? null;
  if (e.key === "g") return afterG ? "first" : "g";
  return { j: "down", k: "up", G: "last", o: "add" }[e.key] ?? null;
}

// The row a move lands on, or "leave" past either end, where the key is left to what is
// around (the list, then journal-entry).
export function rowTarget(action, at, count) {
  const to = { down: at + 1, up: at - 1, first: 0, last: count - 1 }[action];
  if (to === undefined) return null;
  return to < 0 || to >= count ? "leave" : to;
}

// j in Vim's normal mode on a box's last line, or k on its first, moves to the next or the
// previous box (12, "Vim keys"). A count, an operator or a half-typed command keeps the key
// Vim's.
export function boxEdge(e, vim, line, { first, last }) {
  if (!vim || vim.insertMode || vim.visualMode || !plain(e)) return null;
  const s = vim.inputState;
  if (s && (s.operator || s.keyBuffer?.length || s.prefixRepeat?.length || s.motionRepeat?.length)) return null;
  if (e.key === "j" && line >= last) return "down";
  if (e.key === "k" && line <= first) return "up";
  return null;
}

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

// The keyboard goes back to the row under the sheets (4.3, one view instructing another).
const handBack = ({ context }) => context.send?.("sheet-picker", "focus", {});

// An add that arrived during the load acts now that the day is in. + Add sheet is pressed and
// its list closed by then, so a lost add would leave the keyboard with nothing.
const addNow = enqueueActions(({ context, enqueue }) => {
  if (!context.addWaiting) return;
  enqueue.assign({ addWaiting: false });
  enqueue.raise({ type: "add" });
});

// No load, so no sheet: the keyboard goes back where the user pressed.
const addRefused = enqueueActions(({ context, enqueue }) => {
  if (!context.addWaiting) return;
  enqueue.assign({ addWaiting: false });
  enqueue(handBack);
});

const setsOf = (reply) => (Array.isArray(reply?.sets) ? [...reply.sets].sort(byPosition) : null);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("prompt-sheets", "list", { day: input.day })),
    sets: fromPromise(({ input }) => input.ask("prompt-sets", "list", {})),
    // On a page without a settings fact the ask replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "prompt-sheet",
  meta: {
    description:
      "Shows the journal prompts sheets of the journal day on the page, under the day's text, " +
      "each under the caption Journal prompts; a day with none shows nothing, takes no room and " +
      "takes no keyboard. The add command, from Journal prompts under + Add sheet, opens a new " +
      "sheet on a day that can be written, with the keyboard on the first of the user's prompt " +
      "sets: each set by its name, with how many prompts it has and the book it is based on " +
      "under it and its occasion on the right, the first four and then a row \"N more sets\" " +
      "that shows the rest, and under them the line \"Change your sets in Settings › Prompts.\" " +
      "Picking a set shows its name, \"Based on\" the book, its occasion, and each of its " +
      "prompts, in semibold, with an answer box under it that grows with what is written and " +
      "takes Vim's keys when Vim keys is on. What is written is saved a short time into typing " +
      "and at once when a box loses focus; the sheet does not say so. An answer the check judged " +
      "not to respond to its prompt shows the question icon, muted, at the end of its box, with " +
      "the hint \"This may answer something other than the question\", and the prompt repeated " +
      "in muted text under the box; an answer that fits, or one not judged, shows nothing. Done, " +
      "or Escape, folds the sheet into a card with the set's name and each answered prompt with " +
      "its answer, unanswered prompts left out, the first three and then \"N more answers\"; a " +
      "sheet still showing the sets just goes. Pressing the card opens it again. Each sheet folds " +
      "and unfolds on its own; the ones left open stay open after a reload, kept per day in this " +
      "browser. Remove from this day, on a sheet that can be written, takes the sheet away " +
      "whatever it holds, with the short notice whose Undo brings it back; a sheet folded with " +
      "every answer empty goes the same way. A sheet is written exactly while the day's own text " +
      "is; an earlier day's card opens to be read, with Close in place of Done and Remove, and " +
      "says \"The set has changed since. This day keeps the prompts it was answered with.\" when " +
      "the set now asks other prompts. The arrow keys, and with Vim keys on j, k, gg and G, step " +
      "through the cards, the sets and the open sheets, and o adds a sheet; in a box, in Vim's " +
      "normal mode, j on the last line goes to the next box and k on the first line to the one " +
      "before, and from the last or first box on to the row after or before the sheet. A move " +
      "past the first row or the last is left to the journal page around the list.",
    kind: "view",
    emits: ["prompt-sheet.saved"],
    asks: ["prompt-sheets: list", "prompt-sets: list", "settings: read"],
    sends: ["sheet-picker: focus"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    send: input.send,
    mint: input.mint,
    now: input.now,
    throttleMs: input.throttleMs ?? 400,
    // Which sheets were unfolded, per day, kept by the view across reloads (3.1); without it
    // every sheet starts folded.
    unfolded: input.unfolded ?? { read: () => [] },
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
    sheets: [],
    sets: [],
    // The open sheets as typed, in the order they were opened; the ids of those whose typing
    // waits to be saved, and of those whose stretch of typing has not finished.
    drafts: [],
    dirty: [],
    touched: [],
    // The new sheets whose chooser shows every set.
    more: [],
    vimKeys: false,
    // Counts each add, so the view knows to give the new sheet the keyboard: a command has no
    // reply, and the view is not who sent it.
    landing: 0,
    addWaiting: false,
  }),
  // Beside the states, so the preference and the sets arrive whatever the sheet is doing; an
  // event that races them is held until the reply lands (4.2).
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "sets",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { guard: ({ event }) => setsOf(event.output) !== null, actions: assign({ sets: ({ event }) => setsOf(event.output) }) },
      onError: { actions: [] },
    },
  ],
  initial: "loading",
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "prompt-set.changed": {
      actions: assign({ sets: ({ context, event }) => [...context.sets.filter((s) => s.id !== event.set.id), event.set].sort(byPosition) }),
    },
    "prompt-set.deleted": { actions: assign({ sets: ({ context, event }) => context.sets.filter((s) => s.id !== event.id) }) },
    // What held the keyboard went: the row after the sheets is its natural place.
    _handBack: { actions: handBack },
    // Moving to another day saves what waits and asks for the new day's sheets. The same day
    // closing to writing (the journal's day ends at 2:00) saves what was typed while it was
    // open, and the open sheets stay, now to be read.
    "day.shown": [
      {
        guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
        target: ".loading",
        actions: [
          saveWaiting,
          assign(({ event }) => ({
            day: event.day,
            dayWritable: typeof event.writable === "boolean" ? event.writable : null,
            drafts: [],
            dirty: [],
            touched: [],
            more: [],
            sheets: [],
            addWaiting: false,
          })),
        ],
      },
      {
        guard: ({ event }) => isDay(event.day),
        actions: [saveWaiting, assign({ dayWritable: ({ event }) => (typeof event.writable === "boolean" ? event.writable : null) })],
      },
    ],
  },
  states: {
    // A change the fact makes meanwhile is held for this ask and arrives once the reply has
    // landed (4.2).
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, day: context.day }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.sheets),
            target: "ready",
            actions: [
              assign(({ context, event }) => {
                const sheets = [...event.output.sheets].sort(byId);
                return { sheets, drafts: reopened(context, sheets) };
              }),
              addNow,
            ],
          },
          // The fact could not answer: an honest failure rather than an empty day.
          { target: "failed", actions: addRefused },
        ],
        onError: { target: "failed", actions: addRefused },
      },
      on: { add: { actions: assign({ addWaiting: true }) } },
    },
    ready: {
      initial: "idle",
      on: {
        // A new one opens beside any already open, showing the sets.
        _add: { guard: ({ context }) => writable(context), actions: assign(({ context }) => ({ drafts: [...context.drafts, blank(context.mint(), context.day)] })) },
        add: {
          guard: ({ context }) => writable(context),
          actions: assign(({ context }) => ({ drafts: [...context.drafts, blank(context.mint(), context.day)], landing: context.landing + 1 })),
        },
        _more: { guard: ({ context, event }) => opened(context, event), actions: assign({ more: ({ context, event }) => [...without(context.more, event.id), event.id] }) },
        _pick: {
          guard: ({ context, event }) =>
            writable(context) && draftIn(context, event.id)?.setId === null && offeredSets(context).some((s) => s.id === event.setId),
          actions: pick,
        },
        _open: {
          guard: ({ context, event }) => Boolean(held(context, event.id)) && !opened(context, event),
          actions: assign(({ context, event }) => ({ drafts: [...context.drafts, draftOf(held(context, event.id))] })),
        },
        _blur: { guard: ({ context, event }) => opened(context, event), actions: settle },
        _done: { guard: ({ context, event }) => opened(context, event), actions: fold },
        _delete: { guard: ({ context, event }) => writable(context) && opened(context, event), actions: discard },
        "prompt-sheet.changed": { actions: follow },
        "prompt-sheet.deleted": { actions: follow },
      },
      states: {
        idle: {
          on: { _edit: { guard: typable, target: "typing", actions: edit } },
        },
        // Typing within the window, in any open sheet, joins the one save at its end: a
        // throttle, not a debounce, so the targetless edits below never restart the timer.
        typing: {
          on: { _edit: { guard: typable, actions: edit } },
          after: { throttle: { target: "idle", actions: saveWaiting } },
        },
      },
    },
    failed: { on: { add: { actions: handBack } } },
  },
});
