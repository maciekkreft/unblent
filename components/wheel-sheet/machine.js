import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that shows the Wheels of Life of the journal day on the page (6.4). It
// owns only UI state — the day shown, every wheel as the fact last announced it, the one
// sheet open, which score a key or a click sets, which area's questions are open, and whether
// a change waits to be saved —
// and points at one fact: it asks wheels: list once, for every day, and follows wheel.changed
// and wheel.deleted after (4.3, fourth rule), because the shown day's wheels and the wheel
// a new one is copied from are all read from that one list. The day comes from
// day.shown, so the rule for which day the journal shows stays in journal-entry; `wheels` does
// not refuse a closed day, so read only is decided here. Writing leaves as wheel.saved, at a
// throttle while rating or typing and at once on fold or when a box loses the keyboard (4.3,
// third rule). It also asks settings: read for the "Vim keys" preference (12) and follows
// settings.changed. The ask, the id minting, the clock and the throttle arrive through input,
// so the machine is importable in Node.

// The fixed order of wheel.saved's two lists.
export const AREAS = ["Health", "Work", "Money", "Family", "Love", "Friends", "Growth", "Fun"];

const LAST_AREA = AREAS.length - 1;
const NONE = AREAS.map(() => null);
const NOFOCUS = AREAS.map(() => false);

// The scale the sheet offers: three sections of three. `wheels` still accepts a 10 from before
// the scale was 1 to 9, which reads here as 9 (7.1: a contract is never narrowed).
export const STEPS = 9;
export const shown = (v) => (v === null || v === undefined ? null : Math.min(STEPS, v));

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the
// journal page first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// A day as the key says it, "6 October" as the journal dates its pages, with the year only
// when it is not this one.
export function dayName(day, today) {
  const [y, m, d] = day.split("-").map(Number);
  const name = `${d} ${MONTHS[m - 1]}`;
  return today && today.slice(0, 4) === day.slice(0, 4) ? name : `${name} ${y}`;
}

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

// A wheel is written exactly while the day's own text is: the journal page says so in
// day.shown, which keeps yesterday open until 2:00 (13, Journal). Before it has said, only
// today's date is written on.
export const writable = (context) => context.dayWritable ?? context.day === dateOf(context.now());

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const held = (context, id) => context.wheels.find((w) => w.id === id);
const same = (a, b) => a.every((v, i) => v === b[i]);
const allNull = (scores) => scores.every((v) => v === null);

// Announced objects are shared by reference, so the draft holds its own copy.
const draftOf = (w) => ({
  id: w.id,
  day: w.day,
  actual: w.actual.map(shown),
  wanted: w.wanted.map(shown),
  answers: AREAS.map((_, i) => ({ ...w.answers?.[i] })),
  focus: AREAS.map((_, i) => w.focus?.[i] === true),
  rated: false,
});

// The wheels of the shown day, oldest first.
export const dayWheels = (context) => context.wheels.filter((w) => w.day === context.day);

// The wheel a new one on this day is copied from: the newest of those before it.
export function carriedFrom(context, day) {
  let newest = null;
  for (const w of context.wheels) {
    if (w.day >= day) continue;
    if (!newest || w.day > newest.day || (w.day === newest.day && w.id > newest.id)) newest = w;
  }
  return newest;
}

const blank = () => ({ actual: [...NONE], wanted: [...NONE], answers: AREAS.map(() => ({})), focus: [...NOFOCUS] });

// A new wheel starts as a whole copy of the one before it, so a wheel can be filled in over
// several days, as Your values is.
const copyOf = (context, from) => ({ ...(from ? draftOf(from) : blank()), id: context.mint(), day: context.day, rated: false });

// Whether a wheel holds anything: a score, or an answer with text, as `wheels` keeps a wheel.
// The areas chosen alone keep nothing.
export const holdsAny = ({ actual, wanted, answers }) =>
  !allNull(actual) || !allNull(wanted) || AREAS.some((_, area) => QUESTIONS.some((q) => hasText(answerOf(answers, area, q))));

// Whether a wheel reads as the one it was copied from, so the sheet can say where it came from.
const sameAs = (draft, from) =>
  same(draft.actual, from.actual.map(shown)) &&
  same(draft.wanted, from.wanted.map(shown)) &&
  same(draft.focus, AREAS.map((_, i) => from.focus?.[i] === true)) &&
  AREAS.every((_, area) => QUESTIONS.every((q) => answerOf(draft.answers, area, q) === answerOf(from.answers, area, q)));

// Every save names all eight areas' answers, because a list replaces what is stored and a new
// wheel's first save must carry its scale; a hidden answer stays in it.
const saved = ({ id, day, actual, wanted, answers, focus }, finished) => ({ type: "wheel.saved", id, day, actual, wanted, answers, focus, ...(finished ? { finished: true } : {}) });
const emptied = ({ id, day }) => ({ type: "wheel.saved", id, day, ...blank(), finished: true });

// What folding the sheet sends, or null. A wheel never kept is sent only once it holds
// something. A kept one the user just emptied is deleted, and the save held
// back while it was empty (saveWaiting) ends here. One looked at and not changed sends nothing;
// otherwise the save says finished, so the next change is an Undo step of its own (12, Undo).
function foldSave(context) {
  const { draft, dirty } = context;
  if (!draft || !writable(context)) return null;
  const own = holdsAny(draft);
  if (!held(context, draft.id)) return own ? saved(draft, true) : null;
  if (dirty && !own) return emptied(draft);
  return dirty || draft.rated ? saved(draft, true) : null;
}

const settle = enqueueActions(({ context, enqueue }) => {
  const save = foldSave(context);
  if (save) enqueue.emit(save);
  enqueue.assign({ draft: null, dirty: false });
});

// The throttle's end. A wheel emptied while rating or typing is not saved: to `wheels` that save
// removes it, and the user may be clearing a score or an answer only to write another. It stays
// waiting, so a change from the fact does not refill what was cleared.
const saveWaiting = enqueueActions(({ context, enqueue }) => {
  const { draft } = context;
  if (!context.dirty || !draft || !holdsAny(draft)) return;
  enqueue.emit(saved(draft));
  enqueue.assign({ dirty: false, draft: { ...draft, rated: true } });
});

// A box taking or losing the keyboard ends the stretch so far: a save that says finished, so
// `wheels` starts a new Undo step for what comes next (12, Undo). A stretch there is per wheel,
// so without this a rating and a typing, or two boxes, would merge. An emptied wheel waits for
// the fold, as at the throttle's end.
const endStretch = enqueueActions(({ context, enqueue }) => {
  const { draft, dirty } = context;
  if (!(dirty || draft.rated) || !holdsAny(draft)) return;
  enqueue.emit(saved(draft, true));
  enqueue.assign({ dirty: false, draft: { ...draft, rated: false } });
});

// Delete takes the wheel away whatever it holds. What waits goes first, so the Undo brings
// back all of it; a wheel holding nothing that was never kept sends nothing.
const discard = enqueueActions(({ context, enqueue }) => {
  const { draft, dirty } = context;
  const own = holdsAny(draft);
  if (dirty && own) enqueue.emit(saved(draft));
  if (held(context, draft.id) || own) enqueue.emit(emptied(draft));
  enqueue.assign({ draft: null, dirty: false });
});

// The day closing to writing (the journal's day ends at 2:00) keeps what was rated or typed while
// it was open, and the open sheet stays, now to be read. A wheel held back empty goes back to
// what was last saved, and one never kept has nothing to read, so it goes.
const closeDay = enqueueActions(({ context, event, enqueue }) => {
  const { draft, dirty } = context;
  if (draft && writable(context) && event.writable === false) {
    const record = held(context, draft.id);
    if ((dirty || draft.rated) && holdsAny(draft)) {
      enqueue.emit(saved(draft, true));
      enqueue.assign({ draft: { ...draft, rated: false } });
    } else enqueue.assign({ draft: record ? draftOf(record) : null });
    enqueue.assign({ dirty: false });
  }
  enqueue.assign({ dayWritable: typeof event.writable === "boolean" ? event.writable : null });
});

// The open sheet follows a change only while nothing rated or typed waits to be saved, so a
// change never overwrites what is on screen; an Undo or Redo arrives this way. An older version
// than the one held is stale (4.3), and an equal one may carry a new pending flag, so it is
// taken. Undo brings a deleted wheel back under its own id, so this also shows it again.
const follow = assign(({ context, event }) => {
  const w = event.wheel;
  const was = held(context, w.id);
  if (was && w.version < was.version) return {};
  const wheels = [...context.wheels.filter((x) => x.id !== w.id), w].sort(byId);
  if (context.draft?.id !== w.id || context.dirty) return { wheels };
  return { wheels, draft: { ...draftOf(w), rated: context.draft.rated } };
});

// One that is gone closes, and nothing waiting in it is saved after: a save after a delete
// would be ignored by the fact anyway.
const gone = assign(({ context, event }) => {
  const wheels = context.wheels.filter((w) => w.id !== event.id);
  return context.draft?.id === event.id ? { wheels, draft: null, dirty: false } : { wheels };
});

// Pressing the current score clears it.
export const pressed = (current, value) => (current === value ? null : value);

// A key's next score: up from none to 1, up to 9 at most, and down from 1 to none.
export const stepped = (current, more) => (more ? Math.min(STEPS, (current ?? 0) + 1) : current === null || current <= 1 ? null : current - 1);

const scoresKey = (mode) => (mode === "wanted" ? "wanted" : "actual");

const setScore = (draft, mode, area, value) => {
  const key = scoresKey(mode);
  const list = [...draft[key]];
  list[area] = value;
  return { ...draft, [key]: list };
};

const isArea = (n) => Number.isInteger(n) && n >= 0 && n <= LAST_AREA;
const rating = ({ context }) => Boolean(context.draft) && writable(context);

const press = assign(({ context, event }) => ({
  draft: setScore(context.draft, context.mode, event.area, pressed(context.draft[scoresKey(context.mode)][event.area], event.value)),
  cursor: event.area,
  dirty: true,
}));

const stepNext = (context, event) => stepped(context.draft[scoresKey(context.mode)][context.cursor], event.more);

const stepScore = assign(({ context, event }) => ({
  draft: setScore(context.draft, context.mode, context.cursor, stepNext(context, event)),
  dirty: true,
}));

// An emptied box leaves no key, as `wheels` keeps none, so what is compared later is the same.
const setAnswer = (draft, area, question, text) => {
  const answers = draft.answers.map((a, i) => (i === area ? { ...a } : a));
  if (text === "") delete answers[area][question];
  else answers[area][question] = text;
  return { ...draft, answers };
};

const typeAnswer = assign(({ context, event }) => ({
  draft: setAnswer(context.draft, event.area, event.question, event.value),
  dirty: true,
}));

const choose = assign(({ context, event }) => ({
  draft: { ...context.draft, focus: context.draft.focus.map((c, i) => (i === event.area ? !c : c)) },
  dirty: true,
}));

const reset = assign(({ context }) => ({ draft: { ...context.draft, ...blank() }, dirty: true, mode: "actual" }));

// The handlers that change a score, an answer, a choice or the whole wheel (Reset): the same in both states of rating, except that
// only idle starts the throttle. A throttle, not a debounce, so the targetless changes while it
// runs never restart the timer.
const scoring = (next) => ({
  _edit: {
    guard: ({ context, event }) =>
      rating({ context }) &&
      isArea(event.area) &&
      QUESTIONS.includes(event.question) &&
      typeof event.value === "string" &&
      event.value !== answerOf(context.draft.answers, event.area, event.question),
    actions: typeAnswer,
    ...next,
  },
  _press: {
    guard: ({ context, event }) => rating({ context }) && isArea(event.area) && Number.isInteger(event.value) && event.value >= 1 && event.value <= STEPS,
    actions: press,
    ...next,
  },
  _step: {
    guard: ({ context, event }) => rating({ context }) && stepNext(context, event) !== context.draft[scoresKey(context.mode)][context.cursor],
    actions: stepScore,
    ...next,
  },
  _choose: { guard: ({ context, event }) => rating({ context }) && isArea(event.area), actions: choose, ...next },
  // A wheel already blank has nothing to reset.
  _reset: { guard: ({ context }) => rating({ context }) && (holdsAny(context.draft) || context.draft.focus.some(Boolean)), actions: reset, ...next },
});

// --- What the view draws ---------------------------------------------------------------

// "Friends and Fun", or "Health, Love and Fun", in the wheel's order.
const joined = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// The areas the user chose to focus on, as the folded card names them.
export const chosenOf = (wheel) => joined(AREAS.filter((_, i) => wheel.focus?.[i] === true));

// The card's next steps: each chosen area with an answer to "one point closer".
export const nextSteps = (wheel) =>
  AREAS.map((name, i) => ({ name, text: answerOf(wheel.answers, i, "closer") })).filter((s, i) => wheel.focus?.[i] === true && hasText(s.text));

// What a screen reader is told about the wheel, which is drawn and has no text of its own.
export const wheelLabel = ({ actual, wanted }) =>
  AREAS.map((a, i) => `${a}: actual ${shown(actual[i]) ?? "not rated"}, wanted ${shown(wanted[i]) ?? "not rated"}`).join("; ");

export function caption(context) {
  if (!writable(context)) return "Your scores on this day.";
  return context.mode === "wanted" ? "Where do you want each area to be, from 1 to 9?" : "How is each area of your life today, from 1 to 9?";
}

// The line under the rows that names the wheel this one was copied from, while it still reads
// the same; empty after any change, and on an earlier day, which is only read.
export function copiedLabel(context, wheel) {
  const from = writable(context) ? carriedFrom(context, wheel.day) : null;
  if (!from || !sameAs(wheel, from)) return "";
  return `Copied from your wheel of ${dayName(from.day, context.day)}.`;
}

// --- The questions -----------------------------------------------------------------------

// The fixed keys of one area's answers, as wheel.saved and `wheels: list` hold them.
export const QUESTIONS = ["one", "ten", "lower", "higher", "closer"];

// What a 1 and a 9 could look like (the stored key of a 9 is still `ten`), one pair per area in AREAS' order: a faint start for
// someone who has not said it yet.
export const EXAMPLES = [
  ["I feel unwell most days.", "I have energy for everything I want to do."],
  ["I dread going in every morning.", "My work feels worth doing, and it suits me."],
  ["I worry about paying for the basics.", "I cover what I need and rarely think about it."],
  ["We hardly speak, or we mostly argue.", "We are close and enjoy our time together."],
  ["I feel alone, even with someone beside me.", "I feel loved, and I show my love freely."],
  ["I have no one to call.", "I have people I can call at any time."],
  ["I feel stuck, and nothing new comes in.", "I keep learning, and I can see myself changing."],
  ["I cannot remember when I last enjoyed myself.", "Something I enjoy fills part of most days."],
];

// Whether a question means anything at these scores. A question that does not apply keeps its
// answer stored, and it comes back when the score lets it apply again.
export function applies(question, actual, wanted) {
  if (question === "one" || question === "ten") return true;
  if (actual === null) return false;
  if (question === "lower") return actual > 1;
  if (question === "higher") return actual < STEPS;
  return wanted !== null && actual < wanted;
}

export const wording = (question, actual) =>
  ({
    one: "What does a 1 look like for you?",
    ten: "What does a 9 look like for you?",
    lower: `What makes it a ${actual}, and not lower?`,
    higher: "What keeps it from being higher?",
    closer: "What would move it one point closer to Wanted?",
  })[question];

export const answerOf = (answers, area, question) => {
  const text = answers?.[area]?.[question];
  return typeof text === "string" ? text : "";
};

const hasText = (text) => text.trim() !== "";

// The mark on an area's arrow: an answer to a question that applies now.
export const hasAnswer = ({ actual, wanted, answers }, area) =>
  QUESTIONS.some((q) => applies(q, actual[area], wanted[area]) && hasText(answerOf(answers, area, q)));

// What the panel shows for the area under the cursor. Where the day can be written every
// question that applies is listed; an earlier day lists only what was written.
export function panelOf(context, draft) {
  const area = context.cursor;
  const name = AREAS[area];
  const actual = draft.actual[area];
  const wanted = draft.wanted[area];
  const write = writable(context);
  const item = (question) => ({
    question,
    text: wording(question, actual),
    value: answerOf(draft.answers, area, question),
    hint: question === "one" ? EXAMPLES[area][0] : question === "ten" ? EXAMPLES[area][1] : "",
  });
  const items = (questions) =>
    questions
      .filter((q) => applies(q, actual, wanted))
      .map(item)
      .filter((x) => write || hasText(x.value));
  const scoreNote = actual === null ? `Give ${name} an Actual score to answer these.` : null;
  const groups = [
    { title: "The scale", note: null, items: items(["one", "ten"]) },
    { title: "Your score", note: write ? scoreNote : null, items: items(["lower", "higher", "closer"]) },
  ].filter((g) => write || g.items.length);
  return {
    name,
    label: `Questions about ${name}`,
    groups,
    emptyLine: groups.length ? null : `Nothing written about ${name} on this day.`,
  };
}

export const panelHint = (context) =>
  writable(context) ? "Press an area’s arrow to write about it." : "Press an area’s arrow to read what you wrote.";

// --- Keys --------------------------------------------------------------------------------

const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

// The keys of an open sheet that can be written (12, "Vim keys"): the arrows always, and with
// Vim keys on j, k, gg, G, h and l. A plain left or right changes the score of the chosen tab,
// and with Shift, or Vim's Shift+H and Shift+L, it chooses the tab and changes no score, so a
// key never moves the user off the tab they chose. `afterG` is whether a g was pressed just
// before, which makes this g the second of gg; "g" alone waits for its second press.
export function sheetKey(e, vimKeys, afterG = false) {
  if (!plain(e)) return null;
  const arrow = {
    ArrowDown: { move: "down" },
    ArrowUp: { move: "up" },
    ArrowRight: e.shiftKey ? { choose: "wanted" } : { step: true, more: true },
    ArrowLeft: e.shiftKey ? { choose: "actual" } : { step: true, more: false },
  }[e.key];
  if (arrow || !vimKeys) return arrow ?? null;
  if (e.key === "g") return afterG ? { move: "first" } : { wait: true };
  return (
    {
      // Only j and k walk through an open panel's boxes (panelTarget): an arrow in a box moves
      // its cursor and cannot leave it, so an arrow must not lead in.
      j: { move: "down", walk: true },
      k: { move: "up", walk: true },
      G: { move: "last" },
      l: { step: true, more: true },
      h: { step: true, more: false },
      L: { choose: "wanted" },
      H: { choose: "actual" },
    }[e.key] ?? null
  );
}

// Where a move lands inside an open sheet, or "leave" past either end, where the key goes on
// to the next row of the list or, with none, is left to the page around (journal-entry moves
// on from there). `on` is what holds the keyboard: "tabs", "area", "choose" for the row of
// areas to focus on, "close", or "button" for Delete, Reset and Done, which Tab reaches and up
// or down leave for the area the keys act on. The path runs from the tabs through the areas to
// the choice row where the sheet can be written, and on an earlier day, with no tabs, through
// the areas to Close (12, "Vim keys").
export function sheetTarget(move, on, cursor, write) {
  if (move === "first") return 0;
  if (move === "last") return LAST_AREA;
  const down = move === "down";
  if (on === "tabs") return down ? 0 : "leave";
  if (on === "close") return down ? "leave" : cursor;
  if (on === "choose") return down ? "leave" : LAST_AREA;
  if (on === "button") return cursor;
  const to = cursor + (down ? 1 : -1);
  if (isArea(to)) return to;
  if (down) return write ? "choose" : "close";
  return write ? "tabs" : "leave";
}

// Where j or k on an area lands while its panel is open on a day that can be written: its first
// box, or the last box of the area before, so that k takes back the j past that box (12, "Vim
// keys"). Null above the first area, where the path goes on to the tabs as sheetTarget says.
export function panelTarget(step, cursor) {
  if (step === "down") return { area: cursor, edge: "first" };
  return isArea(cursor - 1) ? { area: cursor - 1, edge: "last" } : null;
}

// Where j past an area's last box lands: the next area, or the choice row past the last one.
export const pastLastBox = (cursor) => (isArea(cursor + 1) ? cursor + 1 : "choose");

// The keys between the cards, and on a sheet only read: the arrows always, and with Vim keys
// on j, k, gg and G. Enter needs nothing here: a card and Close are buttons, and an area takes
// it before this.
export function rowKey(e, vimKeys, afterG = false) {
  if (!plain(e)) return null;
  const arrow = { ArrowDown: { move: "down" }, ArrowUp: { move: "up" } }[e.key];
  if (arrow || !vimKeys) return arrow ?? null;
  if (e.key === "g") return afterG ? { move: "first" } : { wait: true };
  return { j: { move: "down" }, k: { move: "up" }, G: { move: "last" } }[e.key] ?? null;
}

// A move out of a box, as the other sheets decide it: j on its last line or k on its first, in
// Vim's normal mode, with no operator or count waiting, so dj and 2k stay Vim's.
export function boxEdge(e, vim, line, { first, last }) {
  if (!vim || vim.insertMode || vim.visualMode || !plain(e)) return null;
  const s = vim.inputState;
  if (s && (s.operator || s.keyBuffer?.length || s.prefixRepeat?.length || s.motionRepeat?.length)) return null;
  if (e.key === "j" && line >= last) return "down";
  if (e.key === "k" && line <= first) return "up";
  return null;
}

// The keyboard goes back to the row under the sheets (4.3, one view instructing another).
const handBack = ({ context }) => context.send?.("sheet-picker", "focus", {});

// An add that arrived during the load acts now that the wheels are in. + Add sheet is pressed
// and its list closed by then, so a lost add would leave the keyboard with nothing.
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

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("wheels", "list", {})),
    // On a page without a settings fact the ask replies no-answerer and Vim stays off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "wheel-sheet",
  meta: {
    description:
      "Shows the Wheels of Life of the journal day on the page, under the day's text, in a section " +
      "headed Wheel of Life; a day with none, and none being rated, shows nothing and takes no " +
      "room. Open, a sheet holds Actual and Wanted tabs across its whole width that decide what a " +
      "click or a key sets, the wheel, and eight rows, one per area, each a thin bar of nine steps," +
      " the scale running from 1 to 9 in three sections of three: thin marks part the steps and " +
      "wide marks part the sections, so the user first decides low, middle or high and then the " +
      "step. On the wheel, nine rings, the filled part is Actual and the dark line is Wanted, and " +
      "the part of the area the keys act on is lit; on a bar the accent fills up to Actual, a " +
      "lighter accent shows the gap up to Wanted, and a dark line drawn over the marks stands at " +
      "Wanted. Each step is one target to click, as tall as the row. No number is shown. A small " +
      "key says Actual, Gap and Wanted. A 10 saved before the scale was 1 to 9 shows as 9 and is " +
      "saved as 9 only when the wheel changes. Under the rows, Which areas will you focus on? lists" +
      " the eight names as buttons; a press chooses an area or drops it, and several can be chosen." +
      " A new wheel is a whole copy of the wheel before it, its scores, answers and chosen areas, " +
      "so a wheel can be filled in over several days as Your values is; a line under the rows names" +
      " the day it was copied from while it still reads the same. The add command opens the wheel " +
      "the day already has, or adds the copy and saves it at once, one step whose Undo takes it " +
      "away, with the keyboard on the first area; the very first wheel starts empty and is saved " +
      "once something is set. Reset, between Delete and Done, empties the whole wheel, as the very " +
      "first one starts. Clicking the current score clears it. Each area's name has an arrow, one " +
      "button with the name, that opens one panel of questions about that area: The scale (what a 1" +
      " and a 9 look like) and Your score (what makes it this number and not lower, what keeps it " +
      "from being higher, what would move it one point closer to Wanted). The panel starts closed " +
      "whenever a sheet opens, pressing the open area closes it, and while it is open it follows " +
      "the area the keys act on. At a score of 1 the not lower question is hidden, at 9 the higher " +
      "one, and with Actual at or above Wanted, or no Wanted, the closer one; with no Actual the " +
      "Your score group says to give one first. A hidden answer stays stored and comes back when " +
      "its question applies again. An area with an answer to a question that applies shows its " +
      "arrow white on a filled accent circle. Each question has its own text box, which can hold " +
      "several lines, with a faint example under the scale's two until something is written, and " +
      "the panel's boxes follow the area. What is typed is saved a short time into typing and at " +
      "once when the box loses the keyboard; one stretch of typing in one box is one Undo step, " +
      "apart from any stretch of rating. A change from another device or from Undo reaches a box " +
      "only while it holds nothing unsaved. With Vim keys on a box takes the keyboard in insert " +
      "mode from Enter and in normal mode from j or k, and p pastes what was copied in the reader. " +
      "An earlier day's panel lists only what was written, as text, with a list drawn as a list, " +
      "and says so when nothing was. The up and down arrows, and with Vim keys on j, k, gg and G, " +
      "move along the keyboard path: the tabs are its first row, above the first area, and the row " +
      "of areas to focus on its last, below the last area. On the tabs left and right, or h and l, " +
      "switch the tab. On an area they change the score of the chosen tab, and from any area " +
      "Shift+Left or Shift+H chooses Actual and Shift+Right or Shift+L chooses Wanted, changing no " +
      "score. On the row of areas to focus on they move between the names, and Space or Enter " +
      "chooses or drops one. These keys also work with the keyboard on Delete, Reset or Done, and " +
      "up or down from one first goes to the area the keys act on. Enter on an area opens its " +
      "panel, and Enter again goes into its first box. With Vim keys on and the panel open on a day" +
      " that can be written, j and k walk through the panel, and the arrows still move from area to" +
      " area: j on an area goes into its first box, and in a box j on the last line and k on the " +
      "first, in Vim's normal mode, go to the next or the previous box. k on the first box goes " +
      "back onto the area, j on the last box goes on to the next area, whose panel then shows, and " +
      "k on an area goes to the last box of the area before. Past the last area's last box j goes " +
      "to the row of areas to focus on, and k comes back into that box. With the panel closed j and" +
      " k go from area to area. Escape takes one step at a time: out of Vim's insert mode, out of " +
      "the box onto its area, closing the panel, and folding the sheet; Done folds it too. Tab goes" +
      " from Actual to Wanted, to that area, to the open panel's boxes, to the areas to focus on " +
      "and to the buttons; the steps and the arrows take no Tab, so a sheet is not seventy stops " +
      "long. A press on the sheet's own text or blank part leaves the keyboard on the area the keys" +
      " act on. Folded, a sheet is a card with a small wheel with the eight names around it, the " +
      "chosen ones bold in the accent color, and beside it You chose to focus on with the chosen " +
      "areas, and under it Your next step with each chosen area's answer to what would move it one " +
      "point closer; with none chosen it says to open the wheel to choose them, or on an earlier " +
      "day that none were chosen. Pressing the card opens it again, with Actual chosen. One sheet " +
      "is open at a time: opening another card folds the first. Delete takes the wheel away with " +
      "the short notice whose Undo shows it again with its answers; one emptied while rating or " +
      "typing, or by Reset, is deleted only when the sheet folds, so a score or an answer can be " +
      "cleared and set again. After a key, a wheel that goes this way puts the keyboard on the + " +
      "Add sheet row; after a press nothing moves. Past the tabs and past the row of areas to focus" +
      " on, j and k go on to the card next to the sheet or the page around, and coming back they " +
      "land on the tabs from above and from below on that row. A wheel is written exactly while the" +
      " day's own text is, as the journal page says: until 2:00 the next night, when a sheet open " +
      "on a day the page stays on becomes read only, what was typed saved and the keyboard moved " +
      "from a box onto its area; an earlier day is read only, with no tabs, no row to choose from " +
      "and with Close, its areas taking j, k, gg, G and Enter, with Close after the last. The sheet" +
      " and the card fill the page. On a wide page the wheel and the rows stay at a fixed size on " +
      "the left, so the bars do not stretch, with the panel on the right, its two groups side by " +
      "side, or a muted line saying to press an arrow while it is closed. On a normal page the " +
      "panel stands below the wheel and the rows, its groups side by side when there is room. A " +
      "narrow page, such as a phone, stacks the wheel above the rows, with larger targets, and the " +
      "panel opens directly under its row, which stays in view when moving; narrower still, each " +
      "area's name stands above its bar, and the card's wheel stands above its text.",
    kind: "view",
    emits: ["wheel.saved"],
    asks: ["wheels: list", "settings: read"],
    sends: ["sheet-picker: focus"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    send: input.send,
    mint: input.mint,
    now: input.now,
    pushRegister: input.pushRegister,
    throttleMs: input.throttleMs ?? 400,
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
    // Every wheel of every day as the fact last said it, oldest first.
    wheels: [],
    // The one open sheet: { id, day, actual, wanted, answers, rated }, rated being whether
    // the stretch still open has saved anything; null when none is open.
    draft: null,
    dirty: false,
    // Which score a click or a key sets, the area the keys act on, and whether that area's
    // questions are open. Every opening of a sheet starts with them closed.
    mode: "actual",
    cursor: 0,
    panel: false,
    // Counts each add, so the view knows to give the sheet the keyboard: a command has no
    // reply, and the view is not who sent it.
    landing: 0,
    // Whether an add arrived while the wheels were still loading; it acts once they are in.
    addWaiting: false,
    vimKeys: false,
  }),
  // Beside the states, so the preference arrives whatever the sheet is doing; a
  // settings.changed that races it is held until the reply lands (4.2).
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    onError: { actions: [] },
  },
  initial: "loading",
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // Text or a link copied in the reader: Vim's p reads Vim's own register, not the system
    // clipboard, so it goes there too.
    "text.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    "link.copied": { actions: ({ context, event }) => context.pushRegister?.(event.text) },
    // What held the keyboard went: the row after the sheets is its natural place (4.3, one view
    // instructing another).
    _handBack: { actions: handBack },
    // Moving to another day folds the open sheet, as Done does. Nothing is asked: every
    // day's wheels are already held.
    "day.shown": [
      {
        guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
        actions: [
          settle,
          assign({
            day: ({ event }) => event.day,
            dayWritable: ({ event }) => (typeof event.writable === "boolean" ? event.writable : null),
            addWaiting: false,
          }),
        ],
      },
      { guard: ({ event }) => isDay(event.day), actions: closeDay },
    ],
  },
  states: {
    // A change the fact makes meanwhile is held for this ask and arrives once the reply has
    // landed (4.2).
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.wheels),
            target: "ready",
            actions: [assign({ wheels: ({ event }) => [...event.output.wheels].sort(byId) }), addNow],
          },
          // The fact could not answer: an honest failure rather than a day with no wheel.
          { target: "failed", actions: addRefused },
        ],
        onError: { target: "failed", actions: addRefused },
      },
      on: { add: { actions: assign({ addWaiting: true }) } },
    },
    ready: {
      initial: "idle",
      on: {
        // A day holds one wheel in the interface: the one open stays, one kept opens, and only
        // a day with none gets a new one.
        // A new one is a copy of the wheel before it and is saved at once, as one step whose
        // Undo takes it away, so the day keeps it even when nothing is changed.
        add: {
          guard: ({ context }) => writable(context),
          actions: enqueueActions(({ context, enqueue }) => {
            const kept = dayWheels(context).at(-1);
            const fresh = !context.draft && !kept ? copyOf(context, carriedFrom(context, context.day)) : null;
            enqueue.assign({
              draft: context.draft ?? (kept ? draftOf(kept) : fresh),
              mode: "actual",
              cursor: 0,
              panel: false,
              landing: context.landing + 1,
            });
            if (fresh && holdsAny(fresh)) enqueue.emit(saved(fresh, true));
          }),
        },
        _open: {
          guard: ({ context, event }) => Boolean(held(context, event.id)) && context.draft?.id !== event.id,
          actions: [settle, assign(({ context, event }) => ({ draft: draftOf(held(context, event.id)), mode: "actual", cursor: 0, panel: false }))],
        },
        _mode: {
          guard: ({ context, event }) => rating({ context }) && (event.mode === "actual" || event.mode === "wanted"),
          actions: assign({ mode: ({ event }) => event.mode }),
        },
        _cursor: { guard: ({ event }) => isArea(event.to), actions: assign({ cursor: ({ event }) => event.to }) },
        _toggle: {
          guard: ({ context, event }) => Boolean(context.draft) && isArea(event.area),
          actions: assign(({ context, event }) => (context.panel && context.cursor === event.area ? { panel: false } : { panel: true, cursor: event.area })),
        },
        _enter: { guard: ({ context }) => Boolean(context.draft), actions: assign({ panel: true }) },
        // Escape takes one step back at a time: the panel first, then the sheet.
        _escape: [
          { guard: ({ context }) => Boolean(context.draft) && context.panel, actions: assign({ panel: false }) },
          { guard: ({ context }) => Boolean(context.draft), actions: settle },
        ],
        _done: { guard: ({ context }) => Boolean(context.draft), actions: settle },
        _delete: { guard: rating, actions: discard },
        _boxIn: { guard: rating, actions: endStretch },
        _boxOut: { guard: rating, actions: endStretch },
        "wheel.changed": { actions: follow },
        "wheel.deleted": { actions: gone },
      },
      states: {
        idle: { on: scoring({ target: "throttling" }) },
        throttling: {
          on: scoring({}),
          after: { throttle: { target: "idle", actions: saveWaiting } },
        },
      },
    },
    failed: { on: { add: { actions: handBack } } },
  },
});
