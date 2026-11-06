import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that shows the Wheels of Life of the journal day on the page (6.4). It
// owns only UI state — the day shown, every wheel as the fact last announced it, the one
// sheet open, which score a key or a click sets, which area's questions are open, and whether
// a change waits to be saved —
// and points at one fact: it asks wheels: list once, for every day, and follows wheel.changed
// and wheel.deleted after (4.3, fourth rule), because the shown day's wheels and the wheel
// Wanted carries over from are both read from that one list. The day comes from day.shown,
// so the rule for which day the journal shows stays in journal-entry; `wheels` does not refuse
// a closed day, so read only is decided here. Writing leaves as wheel.saved, at a throttle
// while rating and at once on fold (4.3, third rule). It also asks settings: read for the
// "Vim keys" preference (12) and follows settings.changed. The ask, the id minting, the clock
// and the throttle arrive through input, so the machine is importable in Node.

// The fixed order of wheel.saved's two lists.
export const AREAS = ["Health", "Work", "Money", "Family", "Love", "Friends", "Growth", "Fun"];

const LAST_AREA = AREAS.length - 1;
const NONE = AREAS.map(() => null);

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

// The answers ride along only to be shown: saved() below leaves them out, so a save keeps what
// `wheels` holds.
const draftOf = (w) => ({ id: w.id, day: w.day, actual: [...w.actual], wanted: [...w.wanted], answers: w.answers ?? [], rated: false });

// The wheels of the shown day, oldest first.
export const dayWheels = (context) => context.wheels.filter((w) => w.day === context.day);

// The wheel a new one on this day takes Wanted from: the newest of those before it.
export function carriedFrom(context, day) {
  let newest = null;
  for (const w of context.wheels) {
    if (w.day >= day) continue;
    if (!newest || w.day > newest.day || (w.day === newest.day && w.id > newest.id)) newest = w;
  }
  return newest;
}

// Whether a wheel holds anything of the user's own: not with no score at all, and not with
// no Actual and Wanted exactly as carried over.
export const ownScores = (context, { day, actual, wanted }) =>
  !allNull(actual) ? true : !allNull(wanted) && !same(wanted, carriedFrom(context, day)?.wanted ?? NONE);

const saved = ({ id, day, actual, wanted }, finished) => ({ type: "wheel.saved", id, day, actual, wanted, ...(finished ? { finished: true } : {}) });
const emptied = ({ id, day }) => ({ type: "wheel.saved", id, day, actual: NONE, wanted: NONE, finished: true });

// What folding the sheet sends, or null. A wheel never kept is sent only once it holds
// something of the user's own. A kept one the user just emptied is deleted, and the save held
// back while it was empty (saveWaiting) ends here. One looked at and not changed sends nothing;
// otherwise the save says finished, so the next change is an Undo step of its own (12, Undo).
function foldSave(context) {
  const { draft, dirty } = context;
  if (!draft || !writable(context)) return null;
  const own = ownScores(context, draft);
  if (!held(context, draft.id)) return own ? saved(draft, true) : null;
  if (dirty && !own) return emptied(draft);
  return dirty || draft.rated ? saved(draft, true) : null;
}

const settle = enqueueActions(({ context, enqueue }) => {
  const save = foldSave(context);
  if (save) enqueue.emit(save);
  enqueue.assign({ draft: null, dirty: false });
});

// The throttle's end. A wheel emptied while rating is not saved: to `wheels` that save removes
// it, and the user may be clearing a score only to set another. It stays waiting, so a change
// from the fact does not refill what was cleared.
const saveWaiting = enqueueActions(({ context, enqueue }) => {
  const { draft } = context;
  if (!context.dirty || !draft || !ownScores(context, draft)) return;
  enqueue.emit(saved(draft));
  enqueue.assign({ dirty: false, draft: { ...draft, rated: true } });
});

// Delete takes the wheel away whatever it holds. What waits goes first, so the Undo brings
// back all of it; a wheel with nothing of the user's own that was never kept sends nothing.
const discard = enqueueActions(({ context, enqueue }) => {
  const { draft, dirty } = context;
  const own = ownScores(context, draft);
  if (dirty && own) enqueue.emit(saved(draft));
  if (held(context, draft.id) || own) enqueue.emit(emptied(draft));
  enqueue.assign({ draft: null, dirty: false });
});

// The day closing to writing (the journal's day ends at 2:00) keeps what was rated while it
// was open, and the open sheet stays, now to be read. A wheel held back empty goes back to
// what was last saved, and one never kept has nothing to read, so it goes.
const closeDay = enqueueActions(({ context, event, enqueue }) => {
  const { draft, dirty } = context;
  if (draft && writable(context) && event.writable === false) {
    const record = held(context, draft.id);
    if ((dirty || draft.rated) && ownScores(context, draft)) {
      enqueue.emit(saved(draft, true));
      enqueue.assign({ draft: { ...draft, rated: false } });
    } else enqueue.assign({ draft: record ? draftOf(record) : null });
    enqueue.assign({ dirty: false });
  }
  enqueue.assign({ dayWritable: typeof event.writable === "boolean" ? event.writable : null });
});

// The open sheet follows a change only while nothing rated waits to be saved, so a change
// never overwrites what is on screen; an Undo or Redo arrives this way. An older version
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

// A key's next score: up from none to 1, up to 10 at most, and down from 1 to none.
export const stepped = (current, more) => (more ? Math.min(10, (current ?? 0) + 1) : current === null || current <= 1 ? null : current - 1);

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

// The handlers that change a score: the same in both states of rating, except that only
// idle starts the throttle. A throttle, not a debounce, so the targetless changes while it
// runs never restart the timer.
const scoring = (next) => ({
  _press: {
    guard: ({ context, event }) => rating({ context }) && isArea(event.area) && Number.isInteger(event.value) && event.value >= 1 && event.value <= 10,
    actions: press,
    ...next,
  },
  _step: {
    guard: ({ context, event }) => rating({ context }) && stepNext(context, event) !== context.draft[scoresKey(context.mode)][context.cursor],
    actions: stepScore,
    ...next,
  },
});

// --- What the view draws ---------------------------------------------------------------

const said = (v) => v ?? "–";

// One area's two scores, as a row and a folded card say them.
export const scoreLine = (actual, wanted) => `${said(actual)}/${said(wanted)}`;

// The gap between them on a card: empty when they match or one is missing.
export function gapOf(actual, wanted) {
  if (actual === null || wanted === null || actual === wanted) return "";
  return actual > wanted ? `+${actual - wanted}` : `−${wanted - actual}`;
}

export const summaryOf = ({ actual, wanted }) =>
  AREAS.map((name, i) => ({ name, score: scoreLine(actual[i], wanted[i]), gap: gapOf(actual[i], wanted[i]) }));

// What a screen reader is told about the wheel, which is drawn and has no text of its own.
export const wheelLabel = ({ actual, wanted }) =>
  AREAS.map((a, i) => `${a}: actual ${actual[i] ?? "not rated"}, wanted ${wanted[i] ?? "not rated"}`).join("; ");

export function caption(context) {
  if (!writable(context)) return "Your scores on this day.";
  return context.mode === "wanted" ? "Where do you want each area to be, from 1 to 10?" : "How is each area of your life today, from 1 to 10?";
}

// The key names the wheel Wanted came from until a Wanted score is changed. An earlier day's
// key does not: it is only read, and nothing can be changed there.
export function wantedLabel(context, wheel) {
  const from = writable(context) ? carriedFrom(context, wheel.day) : null;
  if (!from || allNull(from.wanted) || !same(wheel.wanted, from.wanted)) return "Wanted";
  return `Wanted, from your wheel of ${dayName(from.day, context.day)}`;
}

// --- The questions -----------------------------------------------------------------------

// The fixed keys of one area's answers, as wheel.saved and `wheels: list` hold them.
export const QUESTIONS = ["one", "ten", "lower", "higher", "closer"];

// What a 1 and a 10 could look like, one pair per area in AREAS' order: a faint start for
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
  if (question === "higher") return actual < 10;
  return wanted !== null && actual < wanted;
}

export const wording = (question, actual) =>
  ({
    one: "What does a 1 look like for you?",
    ten: "What does a 10 look like for you?",
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

// Whether an area's scale still says what the wheel before it said, so the note can name that
// wheel. One that said nothing has nothing to name.
const scaleFrom = (from, draft, area) => {
  if (!from) return false;
  const scale = ["one", "ten"];
  return (
    scale.some((q) => hasText(answerOf(from.answers, area, q))) &&
    scale.every((q) => answerOf(from.answers, area, q) === answerOf(draft.answers, area, q))
  );
};

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
  const from = carriedFrom(context, draft.day);
  const scaleNote = scaleFrom(from, draft, area)
    ? `From your wheel of ${dayName(from.day, context.day)}. A change here carries to your next wheel.`
    : "Carries to your next wheel.";
  const scoreNote = actual === null ? `Give ${name} an Actual score to answer these.` : "For this wheel only.";
  const groups = [
    { title: "The scale", note: write ? scaleNote : null, items: items(["one", "ten"]) },
    { title: "Your score", note: write ? scoreNote : null, items: items(["lower", "higher", "closer"]) },
  ].filter((g) => write || g.items.length);
  return {
    name,
    score: scoreLine(actual, wanted),
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
      j: { move: "down" },
      k: { move: "up" },
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
// on from there). `on` is what holds the keyboard: "tabs", "area", "close", or "button" for
// Delete and Done, which Tab reaches and up or down leave for the area the keys act on. The
// path runs from the tabs through the areas where the sheet can be written, and on an earlier
// day, with no tabs, through the areas to Close (12, "Vim keys").
export function sheetTarget(move, on, cursor, write) {
  if (move === "first") return 0;
  if (move === "last") return LAST_AREA;
  const down = move === "down";
  if (on === "tabs") return down ? 0 : "leave";
  if (on === "close") return down ? "leave" : cursor;
  if (on === "button") return cursor;
  const to = cursor + (down ? 1 : -1);
  if (isArea(to)) return to;
  if (down) return write ? "leave" : "close";
  return write ? "tabs" : "leave";
}

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
      "room. Open, a sheet holds Actual and Wanted tabs that decide what a click or a key sets, " +
      "the wheel, and eight rows of ten squares, one row per area. On the wheel the filled part " +
      "is Actual and the dark line is Wanted, and the part of the area the keys act on is lit; in " +
      "the rows the filled squares are Actual and the dark outlined square is Wanted. A small key " +
      "says so. A new wheel starts with Actual empty and Wanted taken from the previous wheel, as " +
      "it stood, and the key names that wheel's day until a Wanted score is changed; the first " +
      "wheel starts with both empty. The add command opens a new wheel on a day that can be " +
      "written, with the keyboard on the first area, or the wheel the day already has; nothing is " +
      "saved until a score changes. Clicking the current score clears it. " +
      "Each area's name has an arrow, one button with the name, that opens one panel of questions " +
      "about that area: The scale (what a 1 and a 10 look like) and Your score (what makes it this " +
      "number and not lower, what keeps it from being higher, what would move it one point closer " +
      "to Wanted). The panel starts closed whenever a sheet opens, pressing the open area closes " +
      "it, and while it is open it follows the area the keys act on. At a score of 1 the not lower " +
      "question is hidden, at 10 the higher one, and with Actual at or above Wanted, or no Wanted, " +
      "the closer one; with no Actual the Your score group says to give one first. A hidden answer " +
      "stays stored and comes back when its question applies again. An area with an answer to a " +
      "question that applies shows its arrow white on a filled accent circle. Answers are shown " +
      "as text. An earlier day's panel lists only what was written, and says so when nothing was. " +
      "The up and down arrows, and with Vim keys on j, k, gg and G, move along the keyboard path: " +
      "the tabs are its first row, above the first area. On the tabs left and right, or h and l, " +
      "switch the tab. On an area they change the score of the chosen tab, and from any area " +
      "Shift+Left or Shift+H chooses Actual and Shift+Right or Shift+L chooses Wanted, changing no " +
      "score. These keys also work with the keyboard on Delete or Done, and up or down from one " +
      "first goes to the area the keys act on. Enter on an area opens its panel. Escape closes the " +
      "panel first, then folds the sheet; Done folds it too. Tab goes from Actual to Wanted, to " +
      "that area, and to the buttons; the squares and the arrows take no Tab, so a sheet is not " +
      "eighty stops long. Folded, a sheet is a card with a small wheel and, per area, its Actual, " +
      "its Wanted and the gap between them; the gap is empty when the scores match or one is " +
      "missing. Pressing the card opens it again, with Actual chosen. One sheet is open at a time: " +
      "opening another card folds the first. Delete takes the wheel away with the short notice " +
      "whose Undo shows it again; a wheel left untouched, with no Actual and Wanted as carried " +
      "over, is not kept and shows no notice, and one emptied while rating is deleted only when " +
      "the sheet folds, so a score can be cleared and set again. After a key, a wheel that goes " +
      "this way puts the keyboard on the + Add sheet row; after a press nothing moves. Past the " +
      "tabs and past the last area, j and k go on to the card next to the sheet or the page around, " +
      "and coming back they land on the tabs from above and on the last area from below. A wheel " +
      "is written exactly while the day's own text is, as the journal page says: until 2:00 the " +
      "next night, when an open sheet becomes read only; an earlier day is read only, with no tabs " +
      "and with Close, its areas taking j, k, gg, G and Enter, with Close after the last. The sheet " +
      "and the card fill the page. On a wide page the wheel and the rows stay at a fixed size on " +
      "the left, so the squares do not stretch, with the panel on the right, its two groups side " +
      "by side, or a muted line saying to press an arrow while it is closed, and the card's scores " +
      "stand in four columns. On a normal page the panel stands below the wheel and the rows, its " +
      "groups side by side when there is room. A " +
      "narrow page, such as a phone, stacks the wheel above the rows, with larger targets, and the " +
      "panel opens directly under its row, which stays in view when moving; narrower still, each " +
      "area's name and score stand above its squares.",
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
    throttleMs: input.throttleMs ?? 400,
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
    // Every wheel of every day as the fact last said it, oldest first.
    wheels: [],
    // The one open sheet: { id, day, actual, wanted, rated }, rated being whether this
    // opening has saved anything; null when none is open.
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
        add: {
          guard: ({ context }) => writable(context),
          actions: assign(({ context }) => {
            const kept = dayWheels(context).at(-1);
            const carried = carriedFrom(context, context.day);
            const fresh = () => ({ id: context.mint(), day: context.day, actual: [...NONE], wanted: [...(carried?.wanted ?? NONE)], answers: [], rated: false });
            return {
              draft: context.draft ?? (kept ? draftOf(kept) : fresh()),
              mode: "actual",
              cursor: 0,
              panel: false,
              landing: context.landing + 1,
            };
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
