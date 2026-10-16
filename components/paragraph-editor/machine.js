import { setup, assign, fromPromise } from "xstate";

// A view component (3.1) and a workshop prototype: one writing box that tells a new
// paragraph from a line break, so the product owner can try paragraph spacing before
// any product editor changes. It owns only UI state, the text typed so far, kept in
// this browser (3.1, a view's own state; losing it loses nothing). `settings` is asked
// for the "Vim keys" preference only (12). The ask and the browser's storage arrive
// through input, so the machine imports in Node.
//
// The text is stored by the plain-text (markdown) rule: paragraphs are separated by one
// blank line ("\n\n"), and a line break inside a paragraph is a single "\n". The editor
// shows that text as it is, and the functions below are the whole of the editing rule.

// Enter: a new paragraph. The selection is replaced by one blank line.
export const enterAt = (text, from, to = from) => ({ from, to, insert: "\n\n", cursor: from + 2 });

// Shift+Enter: a line break inside the paragraph.
export const breakAt = (text, from, to = from) => ({ from, to, insert: "\n", cursor: from + 1 });

// Backspace at the start of a paragraph: the whole gap before it goes, however many
// blank lines it holds, and the two paragraphs join. Anywhere else it is an ordinary
// Backspace, so null.
export function backspaceAt(text, pos) {
  if (pos < 2 || text[pos - 1] !== "\n" || text[pos - 2] !== "\n") return null;
  let from = pos - 2;
  while (from > 0 && text[from - 1] === "\n") from--;
  return { from, to: pos, insert: "", cursor: from };
}

// Delete at the end of a paragraph: the same, forwards.
export function deleteAt(text, pos) {
  if (text[pos] !== "\n" || text[pos + 1] !== "\n") return null;
  let to = pos + 2;
  while (to < text.length && text[to] === "\n") to++;
  return { from: pos, to, insert: "", cursor: pos };
}

// A gap is a blank line the cursor is not on. The blank line the cursor is on is a
// paragraph being started, so it is drawn as a full line to type into; once the cursor
// leaves it empty it is drawn as a gap again. A run of blank lines is a run of gaps, so
// extra blank lines show as extra space rather than vanish.
export const isGap = (line, cursorLine) => line.text === "" && line.number !== cursorLine;

// Where a move that lands on a blank line should end instead, so the cursor never rests
// on a gap. `blank(n)` says whether 0-based line n is blank, `count` is how many lines
// there are, `n` the line landed on and `dir` +1 or -1. It carries on to the nearest line
// with text; at the first or last line it stops there, which is then the line being
// written. Null when line n has text.
export function pastGap(blank, count, n, dir) {
  if (!blank(n)) return null;
  let m = n;
  while (blank(m) && m + dir >= 0 && m + dir < count) m += dir;
  return m;
}

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
