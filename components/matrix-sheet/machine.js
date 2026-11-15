import { setup, assign, enqueueActions, fromPromise, spawnChild, stopChild } from "xstate";

// The view component that shows the Eisenhower Matrix of the journal day on the page (6.4).
// It owns only UI state: the day shown, every matrix as the fact last announced it, whether
// the sheet is open, a new matrix not kept yet, which task's places are open, which task's
// words are being changed, and what is typed in the Add a task line. It points at one fact:
// it asks matrices: list for the newest days, and for a shown day it does not hold, and
// follows matrix.changed and matrix.deleted after (4.3, fourth rule). The day comes from
// day.shown, so the rule for which day the journal shows stays in journal-entry. Every
// change the user makes leaves at once as matrix.saved that says finished, so each is one
// Undo step of its own (12, Undo); a task's words are saved when the user leaves them, so
// the fact is never asked about half a word. It also asks settings: read for the "Vim keys"
// preference (12). The asks, the send, the ids and the clock arrive through input, so the
// machine is importable in Node.

// The four places, in the order the keyboard walks them after To sort, with what each means.
export const PLACES = [
  { id: "do", name: "Do", hint: "Today", where: "Urgent and important", urgent: true, important: true },
  { id: "schedule", name: "Schedule", hint: "Give it a day", where: "Important, not urgent", urgent: false, important: true },
  { id: "delegate", name: "Delegate", hint: "Hand it over", where: "Urgent, not important", urgent: true, important: false },
  { id: "drop", name: "Drop", hint: "Let it go", where: "Neither", urgent: false, important: false },
];
const isPlace = (v) => PLACES.some((p) => p.id === v);
const placeOf = (id) => PLACES.find((p) => p.id === id);

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the journal
// page first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// "6 October", as the journal dates its pages, with the year only when it is not this one.
export function dayName(day, today) {
  const [y, m, d] = day.split("-").map(Number);
  const name = `${d} ${MONTHS[m - 1]}`;
  return today && today.slice(0, 4) === day.slice(0, 4) ? name : `${name} ${y}`;
}

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

// A matrix is written exactly while the day's own text is: the journal page says so in
// day.shown, which keeps yesterday open until 2:00 (13, Journal).
export const writable = (context) => context.dayWritable ?? context.day === dateOf(context.now());

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Where a task shows: the place the user chose, else the suggested one, else To sort (null).
export const shownPlace = (task) => (isPlace(task.place) ? task.place : isPlace(task.suggested?.place) ? task.suggested.place : null);

// The tasks in the order the sheet draws them and the keyboard walks them: To sort, then
// Do, Schedule, Delegate and Drop, each in the order the tasks are kept.
export const ordered = (tasks) => [null, ...PLACES.map((p) => p.id)].flatMap((place) => tasks.filter((t) => shownPlace(t) === place));

// The matrix of the shown day as kept: one not kept yet, or the one the fact keeps.
function keptMatrix(context) {
  if (context.fresh && context.fresh.day === context.day) return context.fresh;
  return context.matrices.filter((m) => m.day === context.day).at(-1) ?? null;
}

// The matrix of the shown day as the sheet draws it. One the user reset shows no task while
// its empty save waits for the fold, so a task can be added again before it is deleted; what
// the fact announces meanwhile still updates the kept copy underneath.
export function shownMatrix(context) {
  const m = keptMatrix(context);
  return m && context.cleared === m.id ? { ...m, tasks: [] } : m;
}

// Whether the fact holds the matrix, so taking it away needs a save: a new one is sent once
// it holds a task.
const isKept = (context, m) => context.matrices.some((x) => x.id === m.id) || m.tasks.length > 0;

// The matrix a new one on this day is copied from: the newest of the days before it.
export function carriedFrom(context, day) {
  let newest = null;
  for (const m of context.matrices) {
    if (m.day >= day) continue;
    if (!newest || m.day > newest.day || (m.day === newest.day && m.id > newest.id)) newest = m;
  }
  return newest;
}

// The user's own fields of a task, which is all matrix.saved carries.
const own = ({ id, text, place, done }) => ({ id, text, place: isPlace(place) ? place : null, done: done === true });

// A new matrix starts as a copy of the newest earlier one without its ticked tasks, each
// keeping its id, so the fact finds its suggestion again (it is not asked twice).
export function copyOf(context) {
  const from = carriedFrom(context, context.day);
  const tasks = (from?.tasks ?? []).filter((t) => t.done !== true).map((t) => ({ ...t, done: false }));
  return { id: context.mint(), day: context.day, ...(from && tasks.length ? { from: from.day } : {}), tasks };
}

// What a save sends. A new id also names its day and where it was copied from.
const saved = (m) => ({ type: "matrix.saved", id: m.id, day: m.day, ...(m.from ? { from: m.from } : {}), tasks: m.tasks.map(own), finished: true });

// One change to the shown matrix: kept here at once, so the sheet shows it before the fact
// announces it, and sent. A task whose words changed loses its suggestion, as the fact drops it.
const change = (make) =>
  enqueueActions(({ context, event, enqueue }) => {
    const m = shownMatrix(context);
    if (!m || !writable(context)) return;
    const tasks = make(m.tasks, event, context);
    if (!tasks) return;
    const next = { ...m, tasks };
    if (context.fresh?.id === m.id) enqueue.assign({ fresh: next });
    else enqueue.assign({ matrices: context.matrices.map((x) => (x.id === m.id ? next : x)) });
    if (context.cleared === m.id) enqueue.assign({ cleared: null });
    if (tasks.length || context.fresh?.id !== m.id) enqueue.emit(saved(next));
  });

// Pasting or typing several lines adds one task per line; empty lines add nothing.
export const linesOf = (text) =>
  typeof text === "string"
    ? text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

const addTasks = change((tasks, event, context) => {
  const lines = linesOf(event.text);
  return lines.length ? [...tasks, ...lines.map((text) => ({ id: context.mint(), text, place: null, done: false }))] : null;
});

const tick = change((tasks, event) => (tasks.some((t) => t.id === event.id) ? tasks.map((t) => (t.id === event.id ? { ...t, done: !t.done } : t)) : null));

// The neighboring place a Shift+arrow moves a task to: left is urgent, up is important, as
// the places stand. A task in To sort moves as if from Do.
export function neighbor(from, dir) {
  const p = placeOf(from) ?? PLACES[0];
  const urgent = dir === "left" ? true : dir === "right" ? false : p.urgent;
  const important = dir === "up" ? true : dir === "down" ? false : p.important;
  return PLACES.find((q) => q.urgent === urgent && q.important === important).id;
}

const move = change((tasks, event) => {
  const task = tasks.find((t) => t.id === event.id);
  if (!task) return null;
  const to = neighbor(shownPlace(task), event.dir);
  if (task.place === to) return null;
  return tasks.map((t) => (t === task ? { ...t, place: to } : t));
});

// A task dragged to `to` (a place, or null for To sort) at `index` among the tasks shown there
// without it. The order of the tasks is the order inside each place, so it goes in before the
// task that stood at that index, or after the last one shown there. A place dropped on is the
// user's, also the suggested one; To sort clears it. A drop where it started changes nothing.
export function dropped(tasks, id, to, index) {
  const task = tasks.find((t) => t.id === id);
  if (!task || !(to === null || isPlace(to)) || !Number.isInteger(index) || index < 0) return null;
  const rest = tasks.filter((t) => t !== task);
  const there = rest.filter((t) => shownPlace(t) === to);
  const before = there[index];
  const at = before ? rest.indexOf(before) : there.length ? rest.indexOf(there.at(-1)) + 1 : rest.length;
  const was = tasks.slice(0, tasks.indexOf(task)).filter((t) => shownPlace(t) === to).length;
  if (shownPlace(task) === to && was === Math.min(index, there.length)) return null;
  return [...rest.slice(0, at), { ...task, place: to }, ...rest.slice(at)];
}

const drop = change((tasks, event) => dropped(tasks, event.id, event.to, event.index));

// Empty words keep the task as it was: deleting is its own gesture.
const words = change((tasks, event) => {
  const text = typeof event.text === "string" ? event.text.trim() : "";
  const task = tasks.find((t) => t.id === event.id);
  if (!task || !text || text === task.text) return null;
  return tasks.map((t) => (t === task ? { id: t.id, text, place: t.place, done: t.done } : t));
});

// The last task's delete takes the matrix away: the fact deletes one left with no task.
const remove = change((tasks, event) => (tasks.some((t) => t.id === event.id) ? tasks.filter((t) => t.id !== event.id) : null));

// The empty save a Reset held back, sent when the sheet folds or the day changes: the fact
// deletes a matrix left with no task, with the short notice.
const sendCleared = enqueueActions(({ context, enqueue }) => {
  const m = keptMatrix(context);
  if (m && context.cleared === m.id && isKept(context, m)) enqueue.emit(saved({ ...m, tasks: [] }));
  enqueue.assign({ cleared: null });
});

// Folding drops a new matrix that was never kept; it has nothing to read.
const fold = [
  sendCleared,
  assign(({ context }) => ({ open: false, editing: null, fresh: context.fresh?.tasks.length ? context.fresh : null })),
];

// Reset empties the sheet, as the very first matrix starts; nothing is sent until the fold.
const reset = assign(({ context }) => ({ cleared: keptMatrix(context).id, editing: null }));

// Delete takes the whole matrix away at once: the fact deletes one saved with no task, with
// the short notice whose Undo brings it back. A new one never kept just goes.
const discard = enqueueActions(({ context, enqueue }) => {
  const m = keptMatrix(context);
  if (isKept(context, m)) enqueue.emit(saved({ ...m, tasks: [] }));
  enqueue.assign({ open: false, editing: null, fresh: null, cleared: null });
});

// A change the fact announces. An older version than the one held is stale (4.3); an equal
// one may carry a suggestion or a pending flag, so it is taken. The new matrix not kept yet
// is replaced by what the fact keeps.
const follow = assign(({ context, event }) => {
  const m = event.matrix;
  const was = context.matrices.find((x) => x.id === m.id);
  if (was && m.version < was.version) return {};
  return {
    matrices: [...context.matrices.filter((x) => x.id !== m.id), m].sort(byId),
    ...(context.fresh?.id === m.id ? { fresh: null } : {}),
  };
});

const gone = assign(({ context, event }) => {
  const matrices = context.matrices.filter((m) => m.id !== event.id);
  const shown = shownMatrix(context);
  const closes = shown?.id === event.id;
  return {
    matrices,
    ...(context.fresh?.id === event.id ? { fresh: null } : {}),
    ...(context.cleared === event.id ? { cleared: null } : {}),
    ...(closes ? { open: false, editing: null } : {}),
  };
});

// What a list reply holds, merged into what is held.
const merge = (held, list) => {
  const map = new Map(held.map((m) => [m.id, m]));
  for (const m of list) {
    const was = map.get(m.id);
    if (!was || m.version >= was.version) map.set(m.id, m);
  }
  return [...map.values()].sort(byId);
};

// --- What the view draws ---------------------------------------------------------------

// The tag of a task the user has not placed.
export function tagOf(task) {
  if (isPlace(task.place) || !isPlace(task.suggested?.place)) return null;
  const p = placeOf(task.suggested.place);
  const title = `Suggested: ${p.urgent ? "urgent" : "not urgent"}, ${p.important ? "important" : "not important"}`;
  return task.suggested.sure ? { label: "Suggested", sure: true, title } : { label: "Not sure", sure: false, title: `${title}, not sure` };
}

// The folded card: the open tasks of Do, then how many each other place holds and how many
// are ticked.
export function cardOf(matrix) {
  const open = (place) => matrix.tasks.filter((t) => shownPlace(t) === place && !t.done);
  const rest = PLACES.slice(1).map((p) => `${p.name} ${open(p.id).length}`);
  const toSort = open(null).length;
  const done = matrix.tasks.filter((t) => t.done).length;
  if (toSort) rest.unshift(`To sort ${toSort}`);
  if (done) rest.push(`${done} done`);
  return { doing: open("do").map((t) => t.text), rest: rest.join(" · ") };
}

export const copiedLabel = (context, matrix) => (matrix.from ? `Copied from your matrix of ${dayName(matrix.from, context.day)}, without the ticked tasks.` : "");

// --- Keys --------------------------------------------------------------------------------

const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

// A key on a task of a sheet that can be written (12, "Vim keys"): the arrows, Space, Enter,
// Delete and Escape always, and with Vim keys on j, k, gg, G, H, J, K, L, dd and o. `after`
// is the key pressed just before, within a second, which makes this g or d the second of gg
// or dd; a first g or d waits.
export function taskKey(e, vimKeys, after = null) {
  if (!plain(e)) return null;
  const shifted = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" }[e.key];
  if (shifted && e.shiftKey) return { move: shifted };
  const always = {
    ArrowDown: { go: "down" },
    ArrowUp: { go: "up", arrow: true },
    " ": { tick: true },
    Enter: { edit: true },
    Delete: { remove: true },
    Escape: { escape: true },
  }[e.key];
  if (always || !vimKeys) return always ?? null;
  if (e.key === "g") return after === "g" ? { go: "first" } : { wait: "g" };
  if (e.key === "d") return after === "d" ? { remove: true } : { wait: "d" };
  return { j: { go: "down" }, k: { go: "up" }, G: { go: "last" }, H: { move: "left" }, L: { move: "right" }, K: { move: "up" }, J: { move: "down" }, o: { add: true } }[e.key] ?? null;
}

// Where a move lands on the sheet's keyboard path: a task by its index, "add" for the Add a
// task line, "done" for Done (or Close), or "leave" past either end, where the key goes on to
// the page around (journal-entry moves on from there with j and k). The path is the tasks
// then Done; the Add a task line stands above the first task and is reached by the up arrow,
// as a letter typed there is text and could not come back out.
export function pathTarget(go, at, count, { arrow = false, write = true } = {}) {
  if (go === "first") return count ? 0 : "done";
  if (go === "last") return "done";
  if (at === "add") return go === "down" ? (count ? 0 : "done") : "add";
  if (at === "done") return go === "down" ? "leave" : count ? count - 1 : arrow && write ? "add" : "leave";
  if (go === "down") return at + 1 < count ? at + 1 : "done";
  if (at > 0) return at - 1;
  return arrow && write ? "add" : "leave";
}

// The keyboard goes back to the row under the sheets (4.3, one view instructing another).
const handBack = ({ context }) => context.send?.("sheet-picker", "focus", {});

const addNow = enqueueActions(({ context, enqueue }) => {
  if (!context.addWaiting) return;
  enqueue.assign({ addWaiting: false });
  enqueue.raise({ type: "add" });
});

const addRefused = enqueueActions(({ context, enqueue }) => {
  if (!context.addWaiting) return;
  enqueue.assign({ addWaiting: false });
  enqueue(handBack);
});

const askDay = spawnChild("day", { id: "day", input: ({ context }) => ({ ask: context.ask, day: context.day }) });

const writing = ({ context }) => Boolean(context.open) && writable(context) && Boolean(shownMatrix(context));
const hasTask = ({ context, event }) => Boolean(shownMatrix(context)?.tasks.some((t) => t.id === event.id));

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("matrices", "list", {})),
    // The newest days come with the load; an older shown day is asked for by itself. The day
    // rides along so a reply for a day left meanwhile is still merged, which is harmless.
    day: fromPromise(({ input }) => input.ask("matrices", "list", { day: input.day })),
    // On a page without a settings fact the ask replies no-answerer and Vim stays off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "matrix-sheet",
  meta: {
    description:
      "Shows the Eisenhower Matrix of the journal day on the page, under the day's text, in a " +
      "section headed Eisenhower Matrix; a day without one shows nothing and takes no room. " +
      "Open, the sheet holds an Add a task line, where Enter adds what is typed and pasting " +
      "several lines adds one task per line, then To sort, shown only while it holds a task, and " +
      "the four places Do, Schedule, Delegate and Drop side by side as the matrix stands, Urgent " +
      "on the left and Important on top, stacked Do first under each other on a narrow page, " +
      "each then saying what it means. Each task has a tick box, its words, a Suggested or a " +
      "dashed Not sure tag while the user has not placed it, and a delete button. A task shows " +
      "at the place the user chose, else at the suggested one, else in To sort. Pressing a " +
      "task's words, or Enter on them, lets the user change them; Enter or leaving keeps them, " +
      "Escape gives the old words back, and empty words keep the old ones. A ticked task is " +
      "muted and struck through and stays where it is. Every change is saved at once as one " +
      "Undo step; deleting a task shows the short Deleted notice with Undo, and deleting the " +
      "last one takes the matrix away. The add command opens the matrix the day already has, or " +
      "adds a copy of the newest earlier matrix without its ticked tasks, saved at once as one " +
      "step whose Undo takes it away, with a line under the places naming the day it came from; " +
      "the very first matrix starts empty and is kept once it holds a task. The keyboard lands " +
      "on the Add a task line. Done or Escape folds the sheet into a card: Do today with the open " +
      "tasks of Do, then how many open tasks each other place holds and how many are ticked; " +
      "pressing the card opens it again. On a task the up and down arrows, and with Vim keys on " +
      "j, k, gg and G, walk through To sort, Do, Schedule, Delegate and Drop and on to Done; the " +
      "up arrow from the first task goes to the Add a task line and the down arrow comes back; " +
      "with Vim keys on o goes there too. Shift with an arrow, or with Vim keys on H, J, K and L, " +
      "moves the task to the neighboring place, left being urgent and up important, and the " +
      "opposite key moves it back. On a day that can be written each task also has a handle on its " +
      "left, drawn as six dots: pulling it with the mouse or a finger moves the task to another " +
      "place, or up and down inside one, or out of To sort, never into it; a line shows where it will land, and a drop is the user's place and order, " +
      "saved as one Undo step, while a drop where it started saves nothing. Space ticks or unticks, Delete or with Vim keys on dd deletes " +
      "the task and moves the keyboard to the next one, and Escape folds " +
      "the sheet. Past the first task and past Done, j and k go on to the page around, and " +
      "coming back they land on the first task from above and on Done from below. A matrix is " +
      "written exactly while the day's own text is, as the journal page says; an earlier day " +
      "is read only, with no Add a task line, no tick boxes to press, no delete buttons, no handles and with " +
      "Close in place of Done. Remove from this day, Reset and Done stand at the foot of a sheet that can be " +
      "written. Remove from this day takes the whole matrix away at once with the short notice whose Undo " +
      "brings it back with its tasks; a new one never kept just closes. Reset empties every " +
      "task, as the very first matrix starts, and leaves the keyboard on the Add a task line; " +
      "a task added then saves the matrix with that task alone, and one still empty when the " +
      "sheet folds or the day changes is deleted then with the notice, so the tasks can be " +
      "written again first. Reset is greyed while there is no task. When the day closes to " +
      "writing first, the matrix shows what was last saved. After a key, a matrix that goes " +
      "this way puts the keyboard on the + Add sheet row; after a press nothing moves.",
    kind: "view",
    emits: ["matrix.saved"],
    asks: ["matrices: list", "settings: read"],
    sends: ["sheet-picker: focus"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    send: input.send,
    mint: input.mint,
    now: input.now,
    day: dateOf(input.now()),
    // Whether the journal page says the shown day can be written; null until it has.
    dayWritable: null,
    // Every matrix as the fact last said it, oldest id first.
    matrices: [],
    // A new matrix not kept yet: { id, day, from?, tasks }, or null.
    fresh: null,
    // The id of the matrix the user reset, whose empty save waits for the fold, or null.
    cleared: null,
    // Whether the shown day's matrix is open as a sheet rather than folded as a card.
    open: false,
    // The task whose words are being changed.
    editing: null,
    // What is typed in the Add a task line and not added yet.
    adding: "",
    // Counts each add, so the view knows to give the sheet the keyboard: a command has no
    // reply, and the view is not who sent it.
    landing: 0,
    addWaiting: false,
    vimKeys: false,
  }),
  // A settings.changed that races it is held until the reply lands (4.2).
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    onError: { actions: [] },
  },
  initial: "loading",
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    _handBack: { actions: handBack },
    "xstate.done.actor.day": {
      guard: ({ event }) => Array.isArray(event.output?.matrices),
      actions: assign({ matrices: ({ context, event }) => merge(context.matrices, event.output.matrices) }),
    },
    // Moving to another day folds the open sheet and drops a new matrix not kept.
    "day.shown": [
      {
        guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
        actions: [
          sendCleared,
          stopChild("day"),
          assign({
            day: ({ event }) => event.day,
            dayWritable: ({ event }) => (typeof event.writable === "boolean" ? event.writable : null),
            open: false,
            fresh: null,
            editing: null,
            adding: "",
            addWaiting: false,
          }),
          askDay,
        ],
      },
      {
        guard: ({ event }) => isDay(event.day),
        actions: assign(({ context, event }) => {
          const dayWritable = typeof event.writable === "boolean" ? event.writable : null;
          // The day closing at 2:00 leaves the open sheet to be read; a new one not kept goes,
          // and one reset shows what was last saved, as nothing was sent.
          return dayWritable === false ? { dayWritable, editing: null, fresh: null, cleared: null } : { dayWritable };
        }),
      },
    ],
  },
  states: {
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.matrices),
            target: "ready",
            actions: [assign({ matrices: ({ context, event }) => merge(context.matrices, event.output.matrices) }), addNow],
          },
          { target: "failed", actions: addRefused },
        ],
        onError: { target: "failed", actions: addRefused },
      },
      on: { add: { actions: assign({ addWaiting: true }) } },
    },
    ready: {
      on: {
        // A day holds one matrix: the one it has opens, and only a day with none gets a copy,
        // kept at once when it holds a task.
        add: {
          guard: ({ context }) => writable(context),
          actions: enqueueActions(({ context, enqueue }) => {
            const shown = shownMatrix(context);
            const fresh = shown ? null : copyOf(context);
            enqueue.assign({
              ...(fresh ? { fresh } : {}),
              open: true,
              editing: null,
              landing: context.landing + 1,
            });
            if (fresh?.tasks.length) enqueue.emit(saved(fresh));
          }),
        },
        _open: {
          guard: ({ context }) => Boolean(shownMatrix(context)) && !context.open,
          actions: assign({ open: true, editing: null }),
        },
        _fold: { guard: ({ context }) => context.open, actions: fold },
        _escape: { guard: ({ context }) => context.open, actions: fold },
        _draft: { guard: ({ event }) => typeof event.text === "string", actions: assign({ adding: ({ event }) => event.text }) },
        // Lines pasted are added as they are; what was typed in the line before stays there.
        _add: { guard: writing, actions: [addTasks, assign({ adding: ({ context, event }) => (event.pasted === true ? context.adding : "") })] },
        _tick: { guard: ({ context, event }) => writing({ context }) && hasTask({ context, event }), actions: tick },
        _move: { guard: writing, actions: move },
        _drop: { guard: writing, actions: drop },
        _edit: {
          guard: ({ context, event }) => writing({ context }) && hasTask({ context, event }),
          actions: assign({ editing: ({ event }) => event.id }),
        },
        _words: { guard: ({ context, event }) => context.editing === event.id, actions: [words, assign({ editing: null })] },
        _unedit: { actions: assign({ editing: null }) },
        // A matrix already empty has nothing to reset.
        _reset: { guard: ({ context }) => writing({ context }) && shownMatrix(context).tasks.length > 0, actions: reset },
        _discard: { guard: writing, actions: discard },
        _delete: {
          guard: ({ context, event }) => writing({ context }) && hasTask({ context, event }),
          actions: remove,
        },
        "matrix.changed": { actions: follow },
        "matrix.deleted": { actions: gone },
      },
    },
    failed: { on: { add: { actions: handBack } } },
  },
});
