import { setup, assign, emit, fromPromise } from "xstate";

// The view component of Undo and Redo (12, Undo): two buttons and the keys. It owns no
// fact; what each would name comes from `undo` (undo: read, then undo.changed), and the
// Vim keys preference from `settings` (settings: read, then settings.changed), each the
// starting picture then everything after (4.3, fourth rule). A press leaves as
// step.requested; `undo` decides what it reaches. The asks arrive through `input`, so the
// machine imports in Node.

// Which direction a key asks for, or null. A key is left alone when a view already used
// it (`defaultPrevented`) or the keyboard is in a text box (`editable`), whose own history
// undoes typing. Cmd or Ctrl with Z undoes and with Shift as well redoes; with Vim keys on,
// a plain u undoes and Ctrl+R redoes too.
export function keyOf(e, { vimKeys = false, editable = false } = {}) {
  if (e.defaultPrevented || editable || e.isComposing || e.altKey) return null;
  const key = typeof e.key === "string" ? e.key.toLowerCase() : "";
  if ((e.metaKey || e.ctrlKey) && key === "z") return e.shiftKey ? "redo" : "undo";
  if (!vimKeys) return null;
  if (e.ctrlKey && !e.metaKey && !e.shiftKey && key === "r") return "redo";
  if (!e.ctrlKey && !e.metaKey && e.key === "u") return "undo";
  return null;
}

const named = (v) => (v && typeof v.id === "string" && typeof v.label === "string" ? { id: v.id, label: v.label } : null);

export const machine = setup({
  actors: {
    undo: fromPromise(({ input }) => input.ask("undo", "read", {})),
    // On a page without settings the ask replies no-answerer and the Vim keys stay off.
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "undo-bar",
  meta: {
    description:
      "Undo and Redo in the top bar, left of the gear: two round buttons, Undo an arrow turning " +
      "back and Redo the same arrow mirrored. Each is greyed while there is nothing to undo or " +
      "redo, and its title names the step, such as Undo: remove value Courage. The keys work " +
      "anywhere on the page while the keyboard is not in a text box and no view has used the " +
      "key: Cmd+Z or Ctrl+Z undoes, and with Shift redoes; with Vim keys on, u also undoes and " +
      "Ctrl+R redoes. Inside a text box the box's own history undoes typing. What the steps " +
      "are, and which one each button names, belongs to `undo`; with no `undo` on the page " +
      "both stay greyed.",
    kind: "view",
    emits: ["step.requested"],
    asks: ["undo: read", "settings: read"],
    attributes: [],
  },
  context: ({ input }) => ({ ask: input.ask, undo: null, redo: null, vimKeys: false }),
  invoke: [
    {
      src: "undo",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ undo: ({ event }) => named(event.output?.undo), redo: ({ event }) => named(event.output?.redo) }) },
      onError: { actions: [] },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
  ],
  on: {
    "undo.changed": { actions: assign({ undo: ({ event }) => named(event.undo), redo: ({ event }) => named(event.redo) }) },
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // A button or a key (7.2, internal): only a step there is to reach is asked for.
    _request: {
      guard: ({ context, event }) => (event.direction === "undo" || event.direction === "redo") && context[event.direction] !== null,
      actions: emit(({ event }) => ({ type: "step.requested", direction: event.direction })),
    },
  },
});
