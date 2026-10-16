import { setup, assign, fromPromise } from "xstate";

// A view component (3.1) and a workshop prototype: one writing box that tells a new
// paragraph from a line break, so the product owner can try paragraph spacing before
// any product editor changes. It owns only UI state, the text typed so far, kept in
// this browser (3.1, a view's own state; losing it loses nothing). `settings` is asked
// for the "Vim keys" preference only (12). The ask and the browser's storage arrive
// through input, so the machine imports in Node.
//
// The text is stored by the editor kit's paragraph rule (architecture.md 10), and the
// box shows that text as it is, so the readout below is what is kept.

// The stored text as the readout shows it: each line break marked ↵ and each blank line
// marked ¶. The last line is where typing goes, not a blank line, so it is never marked.
export function readout(text) {
  const lines = text.split("\n");
  return lines.map((line, i) => ({
    text: line === "" && i < lines.length - 1 ? "" : line,
    blank: line === "" && i < lines.length - 1,
    broken: i < lines.length - 1,
  }));
}

export const machine = setup({
  actors: {
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
}).createMachine({
  id: "paragraph-editor",
  meta: {
    description:
      "A workshop prototype for paragraph spacing: one writing box where Enter starts a new " +
      "paragraph, drawn with a small gap above it, and Shift+Enter breaks the line inside the " +
      "paragraph with no gap. The cursor steps over a gap; Backspace at the start of a " +
      "paragraph, or Delete at the end of one, removes the gap and joins the two, and one Undo " +
      "brings it back. Under the box, \"What is saved\" shows the text exactly as it is kept, " +
      "each line break marked ↵ and each blank line between paragraphs marked ¶. The text is " +
      "kept in this browser only. With Vim keys on, Enter in insert mode starts a paragraph " +
      "and o / O open a plain line.",
    kind: "view",
    emits: [],
    attributes: ["height"],
    asks: ["settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    save: input.save,
    text: input.draft ?? "",
    // Off until `settings` says otherwise, and off on a page without it.
    vimKeys: false,
  }),
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
  },
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    _edit: {
      actions: [assign({ text: ({ event }) => event.text }), ({ context, event }) => context.save(event.text)],
    },
  },
});
