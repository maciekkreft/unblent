import { setup, assign, enqueueActions, fromPromise } from "xstate";

// The view component of the Prompts tab (3.1): a child of `settings-tabs` labelled
// Prompts. It owns only UI state — the set being typed in and not yet saved, and which sets
// are folded — and points at two facts: it asks prompt-sets: list and follows
// prompt-set.changed / prompt-set.deleted, and settings: read for the "Vim keys"
// preference (12) and follows settings.changed (4.3, fourth rule). Every gesture leaves as
// prompt-set.saved carrying the whole set (4.3, fifth rule), and `prompt-sets` records each
// save that changes a set as one step (12, Undo). So typing is saved when its box is left,
// never per keystroke: one stretch of typing in one box is one step. The ask and the id
// minter arrive through input, so the machine is a pure definition importable in Node.

const str = (v) => (typeof v === "string" ? v : "");
const FIELDS = ["name", "occasion", "basedOn"];

// A set as the tab holds it, from the fact's reply or event.
const setOf = (r) => ({
  id: r.id,
  name: str(r.name),
  occasion: str(r.occasion),
  basedOn: str(r.basedOn),
  prompts: Array.isArray(r.prompts) ? r.prompts.filter((p) => typeof p === "string") : [],
  position: str(r.position),
});

// The fact's order (prompt-sets: list): by the key, id as the tiebreak.
const byPosition = (a, b) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// --- Places in the list ------------------------------------------------------------------

// A set's place is a fractional key compared as plain text (5), the same design as an
// evaluator's (evaluators/machine.js): a key never ends in the smallest digit, so there is
// always room before it, and a new set takes a key before the first.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY = /^[0-9A-Za-z]*[1-9A-Za-z]$/;
const isPosition = (v) => typeof v === "string" && v.length <= 200 && KEY.test(v);

function midpoint(a, b) {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? "0") === b[n]) n += 1;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

// The key of a set placed before every other.
export const firstPosition = (sets) => {
  const first = sets.map((s) => s.position).filter(isPosition).sort()[0];
  return midpoint("", first ?? null);
};

// --- What is shown -----------------------------------------------------------------------

const kept = (context, id) => !!context.sets?.some((s) => s.id === id);

// The set as it is on screen: the draft while it is the one typed in, else the fact's.
const current = (context, id) => (context.draft?.id === id ? context.draft : context.sets?.find((s) => s.id === id) ?? null);

// Folded or open, per set: what the user chose, kept in this browser; a set whose fold was
// never chosen starts folded, so the list reads as a list of names.
export const isFolded = (context, id) => (typeof context.folds[id] === "boolean" ? context.folds[id] : true);

// What the tab shows, top to bottom: a New set not kept yet first, then every set in list
// order, each as typed over the fact's copy, so a change from the fact never overwrites what
// is on screen.
export const shownOf = (context) => {
  const sets = context.sets ?? [];
  const fresh = context.draft && !kept(context, context.draft.id) ? [{ ...context.draft, fresh: true }] : [];
  return [...fresh, ...sets.map((s) => (context.draft?.id === s.id ? context.draft : s))].map((s) => ({
    ...s,
    folded: isFolded(context, s.id),
  }));
};

// The muted line beside a folded set's name: its occasion and the book it is based on.
export const besideOf = (s) => [s.occasion.trim(), s.basedOn.trim()].filter(Boolean).join(" · ");

// A set as it is saved: a prompt left empty is not kept.
const cleaned = (s) => ({ ...s, prompts: s.prompts.filter((p) => p.trim() !== "") });

const same = (a, b) =>
  !!a && !!b && FIELDS.every((f) => a[f] === b[f]) && a.position === b.position && a.prompts.length === b.prompts.length && a.prompts.every((p, i) => p === b.prompts[i]);

const blank = (s) => FIELDS.every((f) => s[f].trim() === "") && s.prompts.length === 0;

// Saves `next` into `sets`: one prompt-set.saved with the whole set when it differs from the
// fact's copy, or, for a New set, once something is written in it. Returns the sets with the
// change taken at once, so the next save compares against it.
const persist = (sets, next, enqueue) => {
  const set = cleaned(next);
  const was = sets.find((s) => s.id === set.id);
  if (was ? same(was, set) : blank(set)) return sets;
  enqueue.emit({ type: "prompt-set.saved", ...set });
  return (was ? sets.map((s) => (s.id === set.id ? set : s)) : [...sets, set]).sort(byPosition);
};

// What was typed, saved before another change. A New set with nothing in it stays on
// screen while its boxes are left, unless `drop`.
const settle = (context, enqueue, { drop = false } = {}) => {
  const { draft } = context;
  if (!draft) return context.sets;
  const sets = persist(context.sets, draft, enqueue);
  enqueue.assign(!drop && !sets.some((s) => s.id === draft.id) ? { sets } : { sets, draft: null });
  return sets;
};

// A box was left: the stretch of typing in it ends and is saved.
const flush = enqueueActions(({ context, enqueue }) => {
  settle(context, enqueue);
});

// A change to one set saved at once (a prompt removed or moved): what was typed is saved
// first, as its own step, then the change.
const change = (fn) =>
  enqueueActions(({ context, event, enqueue }) => {
    const set = current(context, event.id);
    const next = set && fn(set, event);
    if (!next) return;
    const sets = settle(context, enqueue, { drop: true });
    const after = persist(sets, next, enqueue);
    enqueue.assign(after.some((s) => s.id === next.id) ? { sets: after, draft: null } : { sets: after, draft: next });
  });

// A typed change to one box of a set: the draft, saved when the box is left. Typing in
// another set saves the one before.
const typed = (fn) => ({
  guard: ({ context, event }) => !!current(context, event.id) && typeof event.value === "string",
  actions: enqueueActions(({ context, event, enqueue }) => {
    const set = structuredClone(current(context, event.id));
    if (context.draft && context.draft.id !== event.id) settle(context, enqueue, { drop: true });
    enqueue.assign({ draft: fn(set, event) });
  }),
});

// --- The keyboard path (12, "Vim keys") ----------------------------------------------

const plain = (e) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing;

// What a key does on a stop of the tab: "down" or "up" to the next or previous stop,
// "first" or "last", "g" for the first g of gg, or null to leave the key alone. The arrows
// always move, since every box holds one line; with Vim keys on j, k, gg and G do too,
// never in a box, where they are typed.
export function stopKey(e, { typing, vim, afterG = false }) {
  if (!plain(e)) return null;
  const arrow = { ArrowDown: "down", ArrowUp: "up" }[e.key];
  if (arrow) return arrow;
  if (!vim || typing) return null;
  if (e.key === "g") return afterG ? "first" : "g";
  return { j: "down", k: "up", G: "last" }[e.key] ?? null;
}

// Alt+Up or Alt+Down in a prompt's box moves the prompt by one: -1, 1, or null.
export function moveKey(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return null;
  return { ArrowUp: -1, ArrowDown: 1 }[e.key] ?? null;
}

export const machine = setup({
  actors: {
    sets: fromPromise(({ input }) => input.ask("prompt-sets", "list", {})),
    // On a page without a settings fact the ask replies no-answerer and Vim stays off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "prompt-settings",
  meta: {
    description:
      "The Prompts tab of the gear's sheet, after Book experts, shown while Journal prompts is " +
      "shown, where the user writes the prompt sets a journal prompts sheet asks. A muted line " +
      "at the top says what a set is and that those based on a book came with the app, then " +
      "New set, which adds an empty set at the top, open, with the keyboard in its name; it is " +
      "kept once something is written in it. Each set is folded under its name, with its " +
      "occasion and the book it is based on muted beside it; which sets are open is kept in " +
      "this browser, and a set whose fold was never chosen starts folded. Opened, it shows " +
      "boxes for its Name, Occasion and Based on, then its Prompts, each a box with an x that " +
      "removes it and up and down buttons that move it, shown while the pointer or the " +
      "keyboard is on the row and always on a phone, New prompt under them, and Delete set. " +
      "Typing is saved as the whole set (prompt-set.saved) when its box is left, never per " +
      "keystroke, so one stretch of typing in one box is one step Undo and Redo reverse; a " +
      "prompt left empty is not kept. Adding a set or a prompt, removing or moving a prompt " +
      "and deleting a set are each saved at once as one step, and deleting a set shows the " +
      "short notice whose Undo brings it back. The keyboard moves through the tab top to " +
      "bottom with the up and down arrows, and with Vim keys on with j, k, gg and G outside " +
      "the boxes; Enter or Space on a heading folds it, Enter in a box goes to the next box, " +
      "and after the last prompt to New prompt; Alt+Up and Alt+Down in a prompt's box move " +
      "the prompt with the keyboard in it, and the opposite move puts it back.",
    kind: "view",
    emits: ["prompt-set.saved"],
    asks: ["prompt-sets: list", "settings: read"],
    attributes: [],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    // Every set of the account in list order; null until prompt-sets: list answers.
    sets: null,
    failed: false,
    // The one set typed in and not yet saved, whole, or a New set not kept yet.
    draft: null,
    // Folded (true) or open (false) per set, as the user chose. UI state the view keeps in
    // localStorage (3.1) and hands back through input, so the folds follow the browser.
    folds: input.folds && typeof input.folds === "object" ? input.folds : {},
    vimKeys: false,
    // Counts New set presses, so the view puts the keyboard in the new set's name once.
    news: 0,
  }),
  // Beside the states, so every picture arrives whatever the tab is doing; a change that
  // races its ask is held until the reply lands (4.2).
  invoke: [
    {
      src: "sets",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        actions: assign(({ event }) =>
          Array.isArray(event.output?.sets) ? { sets: event.output.sets.map(setOf).sort(byPosition) } : { failed: true },
        ),
      },
      onError: { actions: assign({ failed: true }) },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
  ],
  on: {
    "prompt-set.changed": {
      guard: ({ context }) => context.sets !== null,
      actions: assign({
        sets: ({ context, event }) => [...context.sets.filter((s) => s.id !== event.set.id), setOf(event.set)].sort(byPosition),
      }),
    },
    // Deleted here, elsewhere, or by an Undo of its add: what was typed in it goes too.
    "prompt-set.deleted": {
      guard: ({ context }) => context.sets !== null,
      actions: assign({
        sets: ({ context, event }) => context.sets.filter((s) => s.id !== event.id),
        draft: ({ context, event }) => (context.draft?.id === event.id ? null : context.draft),
      }),
    },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    _fold: {
      guard: ({ context, event }) => !!current(context, event.id),
      actions: assign({ folds: ({ context, event }) => ({ ...context.folds, [event.id]: !isFolded(context, event.id) }) }),
    },
    _edit: typed((s, e) => (FIELDS.includes(e.field) ? { ...s, [e.field]: e.value } : s)),
    _editPrompt: typed((s, e) => {
      if (Number.isInteger(e.index) && e.index >= 0 && e.index < s.prompts.length) s.prompts[e.index] = e.value;
      return s;
    }),
    _blur: { actions: flush },
    // New prompt: an empty prompt at the end of the set, not kept until something is
    // written in it, so it is no step of its own.
    _addPrompt: {
      guard: ({ context, event }) => !!current(context, event.id),
      actions: enqueueActions(({ context, event, enqueue }) => {
        const set = structuredClone(current(context, event.id));
        if (context.draft && context.draft.id !== event.id) settle(context, enqueue, { drop: true });
        enqueue.assign({ draft: { ...set, prompts: [...set.prompts, ""] } });
      }),
    },
    _removePrompt: {
      guard: ({ context, event }) => !!current(context, event.id),
      actions: change((s, e) => (e.index >= 0 && e.index < s.prompts.length ? { ...s, prompts: s.prompts.filter((_, i) => i !== e.index) } : null)),
    },
    // Moving a prompt by one, up (-1) or down (1); the opposite move puts it back.
    _movePrompt: {
      guard: ({ context, event }) => {
        const s = current(context, event.id);
        const to = event.index + event.by;
        return !!s && Math.abs(event.by) === 1 && event.index >= 0 && event.index < s.prompts.length && to >= 0 && to < s.prompts.length;
      },
      actions: change((s, e) => {
        const prompts = [...s.prompts];
        [prompts[e.index], prompts[e.index + e.by]] = [prompts[e.index + e.by], prompts[e.index]];
        return { ...s, prompts };
      }),
    },
    // Delete set: what was typed in it is saved first, so Undo brings back the set as it was
    // left; then a kept set goes at once with the short notice and its Undo (12, Undo); a
    // New set not kept yet is only dropped, since it keeps nothing.
    _delete: {
      guard: ({ context, event }) => !!current(context, event.id),
      actions: enqueueActions(({ context, event, enqueue }) => {
        const sets = settle(context, enqueue, { drop: true });
        const was = sets.find((s) => s.id === event.id);
        enqueue.assign({ draft: null });
        if (!was) return;
        enqueue.emit({ type: "prompt-set.saved", ...was, deleted: true });
        enqueue.assign({ sets: sets.filter((s) => s.id !== event.id) });
      }),
    },
    // New set: an empty set at the top, open. Pressed again while it is still empty, it
    // stays the one.
    _new: {
      guard: ({ context }) => context.sets !== null,
      actions: enqueueActions(({ context, enqueue }) => {
        if (context.draft && !kept(context, context.draft.id) && blank(cleaned(context.draft))) {
          enqueue.assign({ news: context.news + 1 });
          return;
        }
        const sets = settle(context, enqueue, { drop: true });
        const id = context.mint();
        enqueue.assign({
          draft: { id, name: "", occasion: "", basedOn: "", prompts: [], position: firstPosition(sets) },
          folds: { ...context.folds, [id]: false },
          news: context.news + 1,
        });
      }),
    },
  },
});
