import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component that shows the choice points of the journal day on the page (6.4).
// It owns only UI state — the day shown, that day's choice points as the fact last
// announced them, which one is open, the open one's draft, and whether typing waits to be
// saved — and points at one fact: it asks choice-points: list for the shown day and
// follows choice-point.changed / choice-point.deleted after (4.3, fourth rule). The day
// comes from day.shown, so the rule for which day the journal shows stays in
// journal-entry. Writing leaves as choice-point.saved, at a throttle while typing and at
// once on blur or Done (4.3, third rule); a delete leaves as removal.started, and
// `choice-points` marks it until notice-stack settles or undoes it. It also asks
// settings: read for the "Vim keys" preference (12) and follows settings.changed. The ask, the id
// minting, the clock and the throttle arrive through input, so the machine is importable
// in Node.

export const FIELDS = ["away", "towards", "situation", "thoughts"];

const pad = (n) => String(n).padStart(2, "0");

// The device's local date, as a journal day dates itself; the shown day until the
// journal page first says which day it shows.
export const dateOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const blank = (id, day) => ({ id, day, situation: "", thoughts: "", away: "", towards: "" });
const draftOf = (r) => ({ id: r.id, day: r.day, situation: r.situation, thoughts: r.thoughts, away: r.away, towards: r.towards });

export const isEmpty = (d) => FIELDS.every((k) => !d[k].trim());

const held = (context, id) => context.choicePoints.find((r) => r.id === id);

// A choice point the fact never had and with nothing written is not one yet: closing it
// keeps nothing, so there is nothing to save or delete. One the fact holds is always
// saved, so clearing its boxes is kept.
export const savable = (context) => Boolean(context.draft) && (Boolean(held(context, context.draft.id)) || !isEmpty(context.draft));

const save = enqueueActions(({ context, enqueue }) => {
  if (savable(context)) enqueue.emit({ type: "choice-point.saved", ...context.draft });
});

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The day's choice points after one change from the fact. Another day's change passes
// by; an older version than the one held is stale (4.3), and an equal one may carry a
// new removal mark, so it is taken.
const changedList = (context, event) => {
  if (event.type === "choice-point.deleted") return context.choicePoints.filter((r) => r.id !== event.id);
  const r = event.choicePoint;
  if (r.day !== context.day) return context.choicePoints;
  const was = held(context, r.id);
  if (was && r.version < was.version) return context.choicePoints;
  return [...context.choicePoints.filter((x) => x.id !== r.id), r].sort(byId);
};

// The open choice point follows a change only while nothing typed waits to be saved, so
// a change never overwrites what is on screen. One that is gone or being removed closes.
const follow = (keepTyping) =>
  enqueueActions(({ context, event, enqueue }) => {
    const choicePoints = changedList(context, event);
    enqueue.assign({ choicePoints });
    const { draft } = context;
    if (!draft) return;
    const record = choicePoints.find((r) => r.id === draft.id);
    const wasHeld = Boolean(held(context, draft.id));
    if ((!record && wasHeld) || record?.removing) {
      enqueue.assign({ draft: null });
      enqueue.raise({ type: "_closed" });
    } else if (record && !keepTyping) enqueue.assign({ draft: draftOf(record) });
  });

const close = assign({ draft: null });

// Opening another choice point, or adding one, first settles the one being left: its
// draft is saved now, so nothing typed is lost by moving on.
const openOne = (pick) => [save, assign(({ context, event }) => ({ draft: pick(context, event) }))];

// Only what is kept, or about to be, can be deleted with an Undo: what typing still
// waits to save is saved first, so the fact holds what it is about to mark. A blank new
// one just closes, because closing it already keeps nothing.
const remove = (dirty) => ({
  target: "#choice-point-cards.ready.folded",
  actions: enqueueActions(({ context, enqueue }) => {
    if (savable(context)) {
      if (dirty || !held(context, context.draft.id)) enqueue.emit({ type: "choice-point.saved", ...context.draft });
      enqueue.emit({ type: "removal.started", kind: "choice-point", id: context.draft.id, name: context.draft.situation.trim() });
    }
    enqueue.assign({ draft: null });
  }),
});

const isDay = (v) => typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v);

export const machine = setup({
  actors: {
    load: fromPromise(({ input }) => input.ask("choice-points", "list", { day: input.day })),
    // On a page without a settings fact the ask replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "choice-point-cards",
  meta: {
    description:
      "Shows the choice points of the journal day on the page, under the day's text, in a " +
      "section headed \"Choice points\". A \"Choice point\" pill adds one to that day and opens it " +
      "in place with the keyboard in Situation: the V drawing and four boxes, Away · hooked, " +
      "Towards · unhooked, Situation, and Thoughts & feelings. The boxes grow with what is " +
      "written and take Vim's keys when Vim keys is on; Tab moves on to the next box or " +
      "button. What is written is saved a short time into typing and at once when a box " +
      "loses focus, and the sheet says Saving… or Saved. Done, or Escape, folds it into a " +
      "card showing the situation and the away and towards moves, one line each; with Vim " +
      "keys on, the first Escape in a box leaves insert mode and the next one folds the " +
      "sheet. Pressing a card opens it again. A choice point opened " +
      "and closed with nothing written is not kept. A choice point stays editable on every " +
      "day, also after the day's own text is closed. Delete shows the usual notice with Undo. " +
      "It follows the day the journal page shows from day.shown, and shows today until the " +
      "page has said. On a narrow width the V stands above the boxes.",
    kind: "view",
    emits: ["choice-point.saved", "removal.started"],
    asks: ["choice-points: list", "settings: read"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    throttleMs: input.throttleMs ?? 400,
    day: dateOf(input.now()),
    choicePoints: [],
    // The open choice point's texts as typed; null when every one is folded.
    draft: null,
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
    // Moving to another day settles the open choice point and asks for the new day's.
    "day.shown": {
      guard: ({ context, event }) => isDay(event.day) && event.day !== context.day,
      target: ".loading",
      actions: [save, assign(({ event }) => ({ day: event.day, draft: null, choicePoints: [] }))],
    },
  },
  states: {
    // A change the fact makes meanwhile is held for this ask and arrives once the reply
    // has landed (4.2).
    loading: {
      invoke: {
        src: "load",
        input: ({ context }) => ({ ask: context.ask, day: context.day }),
        onDone: [
          {
            guard: ({ event }) => Array.isArray(event.output?.choicePoints),
            target: "ready",
            actions: assign({ choicePoints: ({ event }) => [...event.output.choicePoints].sort(byId) }),
          },
          // The fact could not answer: an honest failure rather than an empty day.
          { target: "failed" },
        ],
        onError: "failed",
      },
    },
    ready: {
      initial: "folded",
      on: {
        _add: {
          target: ".open",
          actions: openOne((context) => blank(context.mint(), context.day)),
        },
        _open: {
          guard: ({ context, event }) => {
            const r = held(context, event.id);
            return Boolean(r) && !r.removing && context.draft?.id !== event.id;
          },
          target: ".open",
          actions: openOne((context, event) => draftOf(held(context, event.id))),
        },
        _closed: ".folded",
      },
      states: {
        folded: {
          on: {
            "choice-point.changed": { actions: follow(false) },
            "choice-point.deleted": { actions: follow(false) },
          },
        },
        open: {
          initial: "clean",
          states: {
            clean: {
              on: {
                _done: { target: "#choice-point-cards.ready.folded", actions: close },
                _delete: remove(false),
                _edit: {
                  guard: ({ event }) => FIELDS.includes(event.field) && typeof event.value === "string",
                  target: "dirty",
                  actions: assign(({ context, event }) => ({ draft: { ...context.draft, [event.field]: event.value } })),
                },
                "choice-point.changed": { actions: follow(false) },
                "choice-point.deleted": { actions: follow(false) },
              },
            },
            // Typing within the window joins the one save at its end: a throttle, not a
            // debounce, so the targetless edits below never restart the timer.
            dirty: {
              on: {
                _edit: {
                  guard: ({ event }) => FIELDS.includes(event.field) && typeof event.value === "string",
                  actions: assign(({ context, event }) => ({ draft: { ...context.draft, [event.field]: event.value } })),
                },
                _blur: { target: "clean", actions: save },
                _done: { target: "#choice-point-cards.ready.folded", actions: [save, close] },
                _delete: remove(true),
                "choice-point.changed": { actions: follow(true) },
                "choice-point.deleted": { actions: follow(true) },
              },
              after: { throttle: { target: "clean", actions: save } },
            },
          },
        },
      },
    },
    failed: {},
  },
});
