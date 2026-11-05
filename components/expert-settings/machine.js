import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component of the Book experts tab (3.1): a child of `settings-tabs` labelled
// Book experts. It owns only UI state — the prompt typed and not yet saved, and which
// books are folded — and points at four facts: it asks experts: list and follows
// expert.changed, books: list and follows book.changed / book.deleted, settings: read for
// the "Vim keys" preference (12) and follows settings.changed, and session: read and
// follows session.changed (4.3, fourth rule). Every gesture leaves as expert.edited with
// only the fields changed (4.3, fifth rule): typing at a throttle and when the box is
// left, the On box at once; `experts` records each as a step (12, Undo). The ask and the
// clock arrive through input, so the machine is a pure definition importable in Node.

const isId = (v) => typeof v === "string" && v !== "";

// A session reply without a userId (no `session` on the page or in a test) counts as
// signed in, so a page that cannot tell never hides the tab, as evaluator-settings does.
export const signedIn = (reply) => (reply && "userId" in reply ? reply.userId != null : true);

// A book as the tab needs it. The Journal is the book the user writes (13), not one read,
// so it has no expert.
const bookOf = (b) => ({ id: b.id, title: typeof b.title === "string" ? b.title : "", author: typeof b.author === "string" ? b.author : "", shelfPlace: b.shelfPlace ?? null });
const readBooks = (books) => books.filter((b) => isId(b?.id) && !b.written).map(bookOf);

// The shelf's order (books: list): by the place the user set, a key compared as text, id
// as the tiebreak; one without a place after.
const byPlace = (a, b) => {
  if (a.shelfPlace == null || b.shelfPlace == null) return Number(a.shelfPlace == null) - Number(b.shelfPlace == null) || a.id.localeCompare(b.id);
  return a.shelfPlace < b.shelfPlace ? -1 : a.shelfPlace > b.shelfPlace ? 1 : a.id.localeCompare(b.id);
};

// A book the user never wrote an expert for stands at an empty prompt, switched off, as
// `experts` keeps it.
const expertOf = (context, id) => context.experts?.[id] ?? { prompt: "", on: false };

const promptOf = (context, id) => (typeof context.pending[id] === "string" ? context.pending[id] : expertOf(context, id).prompt);

// Folded or open, per book: what the user chose, kept in this browser; a book whose fold
// was never chosen starts folded while it has no prompt (the design's rule).
export const isFolded = (context, id) => (typeof context.folds[id] === "boolean" ? context.folds[id] : expertOf(context, id).prompt.trim() === "");

// What the tab shows, top to bottom: every book read, in shelf order, with its prompt as
// typed over the fact's copy, so a change from the fact never overwrites what is on screen.
// On shows only while there is a prompt, since the fact switches on only an expert with one.
export const shownOf = (context) =>
  (context.books ?? []).map((b) => {
    const prompt = promptOf(context, b.id);
    return { ...b, prompt, on: expertOf(context, b.id).on && prompt.trim() !== "", folded: isFolded(context, b.id) };
  });

// Saves what is typed: one expert.edited per book with only what changed. An emptied
// prompt also switches its expert off, in the same edit. `left` ends the stretch of
// typing in the box last typed in (12, Undo). The copy here takes the change at once, so
// a later edit compares against it.
const flush = (left) =>
  enqueueActions(({ context, enqueue }) => {
    const experts = { ...context.experts };
    const ids = new Set(Object.keys(context.pending));
    if (left && context.touched) ids.add(context.touched);
    for (const id of ids) {
      const was = experts[id] ?? { prompt: "", on: false };
      const fields = {};
      const typed = context.pending[id];
      if (typeof typed === "string" && typed !== was.prompt) {
        fields.prompt = typed;
        if (was.on && typed.trim() === "") fields.on = false;
      }
      const leaving = left && id === context.touched;
      if (!Object.keys(fields).length && !leaving) continue;
      enqueue.emit({ type: "expert.edited", id, ...fields, ...(leaving ? { left: true } : {}) });
      experts[id] = { ...was, ...fields };
    }
    enqueue.assign({ experts, pending: {}, ...(left ? { touched: null } : {}) });
  });

const known = (context, id) => !!context.books?.some((b) => b.id === id);

const typing = (target) => ({
  _type: {
    guard: ({ context, event }) => known(context, event.id) && typeof event.value === "string",
    target,
    actions: assign({
      pending: ({ context, event }) => ({ ...context.pending, [event.id]: event.value }),
      touched: ({ event }) => event.id,
      // Typing settles the fold as open, so emptying the box never folds it away.
      folds: ({ context, event }) => (typeof context.folds[event.id] === "boolean" ? context.folds : { ...context.folds, [event.id]: false }),
    }),
  },
});

// On is one gesture, saved at once, after what was typed so the prompt lands first; the
// bus delivers the two in order. It is refused while the prompt is empty.
const toggle = {
  guard: ({ context, event }) =>
    known(context, event.id) && typeof event.on === "boolean" && (event.on === false || promptOf(context, event.id).trim() !== ""),
  target: ".clean",
  actions: [
    flush(false),
    enqueueActions(({ context, event, enqueue }) => {
      if (expertOf(context, event.id).on === event.on) return;
      enqueue.emit({ type: "expert.edited", id: event.id, on: event.on });
      enqueue.assign({ experts: { ...context.experts, [event.id]: { ...expertOf(context, event.id), on: event.on } } });
    }),
  ],
};

// --- The keyboard path (12, "Vim keys") ----------------------------------------------

const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

// What a key does on a stop of the tab that is not a text box (a heading or an On box):
// "down" or "up" to the next or previous stop, "first" or "last", "g" for the first g of
// gg, or null to leave the key alone. The arrows always move; with Vim keys on j, k, gg
// and G do too.
export function stopKey(e, { vim, afterG = false }) {
  if (!plain(e)) return null;
  const arrow = { ArrowDown: "down", ArrowUp: "up" }[e.key];
  if (arrow) return arrow;
  if (!vim) return null;
  if (e.key === "g") return afterG ? "first" : "g";
  return { j: "down", k: "up", G: "last" }[e.key] ?? null;
}

// In a prompt box: j on its last line or k on its first in Vim's normal mode, and the down
// arrow on its last line or the up arrow on its first, leave it along the path. A count,
// an operator or a half-typed command keeps the key Vim's.
export function boxEdge(e, vim, line, lines, vimOn) {
  if (!plain(e)) return null;
  if (e.key === "ArrowDown" && line >= lines) return "down";
  if (e.key === "ArrowUp" && line <= 1) return "up";
  if (!vimOn || !vim || vim.insertMode || vim.visualMode) return null;
  const s = vim.inputState;
  if (s && (s.operator || s.keyBuffer?.length || s.prefixRepeat?.length || s.motionRepeat?.length)) return null;
  if (e.key === "j" && line >= lines) return "down";
  if (e.key === "k" && line <= 1) return "up";
  return null;
}

export const machine = setup({
  actors: {
    experts: fromPromise(({ input }) => input.ask("experts", "list", {})),
    books: fromPromise(({ input }) => input.ask("books", "list", {})),
    // On a page without a settings fact the ask replies no-answerer and the boxes stay plain.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    session: fromPromise(({ input }) => input.ask("session", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "expert-settings",
  meta: {
    description:
      "The Book experts tab of the gear's sheet, after Generators, shown while Book experts " +
      "is shown. A line at the top says what an expert is and asks for the book's ideas in the " +
      "user's own words rather than its text. Then one heading per book of the library, in " +
      "shelf order, the Journal left out, with the title, the author muted beside it, and a " +
      "caret that folds it; which books are folded or open is kept in this browser, and a " +
      "book whose fold was never chosen starts folded while it has no prompt. Under the " +
      "heading, an On check box and the Prompt box, which takes Vim's keys when Vim keys is on. " +
      "On is greyed, with a tooltip saying to write a prompt first, until the prompt holds " +
      "text, and emptying the prompt switches it off. The prompt is saved a short time into " +
      "typing and when the box is left (expert.edited, carrying only what changed), On at once. " +
      "Each stretch of typing and each On is one step Undo reverses. The keyboard moves from " +
      "heading to On to box and on with the up and down arrows, and with Vim keys on with j, " +
      "k, gg and G, leaving a box from its first or last line; Enter or Space on a heading " +
      "folds it. Signed out it shows only \"Sign in to use book experts.\"",
    kind: "view",
    emits: ["expert.edited"],
    attributes: [],
    asks: ["experts: list", "books: list", "settings: read", "session: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    throttleMs: input.throttleMs ?? 200,
    // Every book read, in shelf order; null until books: list answers.
    books: null,
    failed: false,
    // The fact's experts by book id, { prompt, on }; null until experts: list answers.
    experts: null,
    // What is typed and not yet saved, by book id.
    pending: {},
    // The book whose box was last typed in, until it is left.
    touched: null,
    // Folded (true) or open (false) per book, as the user chose. UI state the view keeps
    // in localStorage (3.1) and hands back through input, so the folds follow the browser.
    folds: input.folds && typeof input.folds === "object" ? input.folds : {},
    vimKeys: false,
    // Whether someone is signed in (3.4): null until session answers.
    signedIn: null,
  }),
  // Beside the states, so every picture arrives whatever the tab is doing; a change that
  // races its ask is held until the reply lands (4.2).
  invoke: [
    {
      src: "experts",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        actions: assign({
          experts: ({ event }) =>
            Object.fromEntries(
              (Array.isArray(event.output?.experts) ? event.output.experts : []).map((x) => [x.id, { prompt: x.prompt, on: x.on }]),
            ),
        }),
      },
      onError: { actions: assign({ experts: {} }) },
    },
    {
      src: "books",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        actions: assign(({ event }) => (Array.isArray(event.output?.books) ? { books: readBooks(event.output.books) } : { failed: true })),
      },
      onError: { actions: assign({ failed: true }) },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "session",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ signedIn: ({ event }) => signedIn(event.output) }) },
      onError: { actions: assign({ signedIn: true }) },
    },
  ],
  on: {
    "expert.changed": {
      guard: ({ context }) => context.experts !== null,
      actions: assign({
        experts: ({ context, event }) => ({ ...context.experts, [event.expert.id]: { prompt: event.expert.prompt, on: event.expert.on } }),
      }),
    },
    "book.changed": {
      guard: ({ context }) => context.books !== null,
      actions: assign({
        books: ({ context, event }) => {
          const rest = context.books.filter((b) => b.id !== event.id);
          return event.written ? rest : [...rest, bookOf(event)].sort(byPlace);
        },
      }),
    },
    "book.deleted": {
      guard: ({ context }) => context.books !== null,
      actions: assign({ books: ({ context, event }) => context.books.filter((b) => b.id !== event.id) }),
    },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "session.changed": { actions: assign({ signedIn: ({ event }) => event.userId != null }) },
    // A press on a book's heading, or Enter on it: fold it, or unfold it.
    _fold: {
      guard: ({ context, event }) => known(context, event.id),
      actions: assign({ folds: ({ context, event }) => ({ ...context.folds, [event.id]: !isFolded(context, event.id) }) }),
    },
    _switch: toggle,
  },
  initial: "clean",
  states: {
    clean: { on: { ...typing("dirty"), _blur: { actions: flush(true) } } },
    // Typing within the window joins the one save at its end: a throttle, not a
    // debounce, so the targetless edits below never restart the timer.
    dirty: {
      on: { ...typing(undefined), _blur: { target: "clean", actions: flush(true) } },
      after: { throttle: { target: "clean", actions: flush(false) } },
    },
  },
});
