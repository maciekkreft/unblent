import { EditorState, EditorSelection, RangeSetBuilder, StateField, Prec, Compartment } from "@codemirror/state";
import { EditorView, Decoration, keymap, drawSelection } from "@codemirror/view";
import { history, historyKeymap, standardKeymap, isolateHistory } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";

// The editor kit (architecture.md 10): what every CodeMirror editor needs and nothing
// one editor alone needs. It imports only vendored CodeMirror packages, never the bus,
// and knows no component (11.2), so a change here is judged by its own tests.

// --- The text rule ----------------------------------------------------------------
// Paragraphs are apart by one blank line ("\n\n") and a line break inside a paragraph
// is a single "\n", the plain-text (markdown) rule, so stored text needs no conversion.
// Each edit is a pure function of the text returning { from, to, insert, cursor }.

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
// leaves it empty it is a gap again. A run of blank lines is a run of gaps, so extra
// blank lines show as extra space rather than vanish.
export const isGap = (line, cursorLine) => line.text === "" && line.number !== cursorLine;

// Where a move that lands on a blank line should end instead, so the cursor never rests
// on a gap. `blank(n)` says whether 0-based line n is a gap, `count` is how many lines
// there are, `n` the line landed on and `dir` +1 or -1. It carries on to the nearest
// line that is not; at the first or last line it stops there, which is then the line
// being written. Null when line n is not a gap.
export function pastGap(blank, count, n, dir) {
  if (!blank(n)) return null;
  let m = n;
  while (blank(m) && m + dir >= 0 && m + dir < count) m += dir;
  return m;
}

// --- What every editor needs ------------------------------------------------------

// Low precedence, so an editor's own theme overrides any of it at equal specificity.
const theme = Prec.low(
  EditorView.theme({
    "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "var(--leading-normal)" },
    // The caret at column 0 is drawn 0.6px left of the text, so .cm-content needs a
    // sliver of side padding or the scroller's overflow clip eats it.
    ".cm-content": { caretColor: "var(--color-accent)", padding: "0 var(--space-2xs)" },
    // Line spacing is padding, never margin: CodeMirror measures a line's box for its
    // height map, and Vim's j/k move by pixels through it.
    ".cm-line": { fontSize: "var(--text-body)", padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
    ".cm-placeholder": { color: "var(--color-mute)" },
  }),
);

// The Vim plugin ships its own Prec.highest theme for the block cursor in colours that
// are not tokens; this one outranks it and marks the competing properties !important.
// Unfocused, the cursor is hollowed with an inset shadow, because Safari clips the
// outline the plugin draws outside its absolutely positioned span.
const fatCursor = Prec.highest(
  EditorView.theme({
    ".cm-fat-cursor": {
      background: "var(--color-accent) !important",
      color: "var(--color-accent-text) !important",
    },
    "&:not(.cm-focused) .cm-fat-cursor": {
      background: "none !important",
      outline: "none !important",
      color: "var(--color-ink) !important",
      boxShadow: "inset 0 0 0 var(--border-width) var(--color-accent)",
    },
  }),
);

// One compartment serves every editor on the page: a compartment is a key into each
// state's own configuration, so sharing it shares nothing between editors.
const vimSlot = new Compartment();
const vimContent = (on) => (on ? [vim(), fatCursor] : []);

// The "Vim keys" preference (12) turned on or off in place, keeping the text and the
// undo history. Safe to call on every update: it dispatches only on a change.
export function setVim(view, on) {
  const now = vimSlot.get(view.state);
  if (now === undefined || (Array.isArray(now) && now.length > 0) === Boolean(on)) return;
  view.dispatch({ effects: vimSlot.reconfigure(vimContent(on)) });
}

// The shared setup. Put first in an editor's extensions: the Vim plugin must see a key
// before any keymap does. The standard and history keys are low precedence, so an
// editor's own keymap (and paragraphs()) wins over them. `history: false` is for an
// editor that holds history in a compartment of its own, to empty it by reconfiguring.
export function baseExtensions({ vim: vimOn = false, history: withHistory = true } = {}) {
  return [
    vimSlot.of(vimContent(vimOn)),
    // Vim hides the native selection, so its visual-mode range shows only through
    // CodeMirror's own selection layer.
    drawSelection(),
    withHistory ? history() : [],
    theme,
    Prec.low(keymap.of([...historyKeymap, ...standardKeymap])),
    EditorView.lineWrapping,
    // WebKit keeps the document's selection inside a blurred editor, and a later key
    // nobody cancels is typed there; dropping it on blur leaves nothing to type into.
    EditorView.domEventHandlers({
      blur: () => {
        document.getSelection()?.removeAllRanges();
      },
    }),
  ];
}

// --- Paragraphs -------------------------------------------------------------------

const gapLine = Decoration.line({ class: "cm-gap" });

// A gap reads as the space between two paragraphs, about three quarters of a line, so
// it is told apart from a line break (no space) and from an empty line (a full one).
const gapTheme = EditorView.theme({
  ".cm-line.cm-gap": { height: "calc((var(--space-sm) + var(--space-md)) / 2)", overflow: "hidden" },
});

const never = () => false;

// Enter makes a paragraph, Shift+Enter a line break, the cursor steps over gaps, and
// Backspace or Delete at a paragraph's edge joins across the gap in one step (10).
// `enter: false` leaves Enter to the editor (a box that sends on it); Shift+Enter, the
// gaps, the stepping and the joins stay. `keepBlank(state, line)` names a blank line
// that must stay a place to type: never drawn as a gap, never stepped over, never
// removed by a join.
export function paragraphs({ enter = true, keepBlank = never } = {}) {
  const gapAt = (state, line) => line.length === 0 && !keepBlank(state, line);

  // A field rather than a computed facet, so a keepBlank reading another field of the
  // editor's is followed whatever changed it.
  const build = (state) => {
    const cursorLine = state.doc.lineAt(state.selection.main.head).number;
    const builder = new RangeSetBuilder();
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      if (isGap({ text: line.text, number: n }, cursorLine) && !keepBlank(state, line)) {
        builder.add(line.from, line.from, gapLine);
      }
    }
    return builder.finish();
  };
  const gaps = StateField.define({
    create: build,
    update: (value, tr) => (tr.docChanged || tr.selection || tr.effects.length || tr.reconfigured ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });

  // The cursor never rests on a gap: a move from the keyboard (arrows, Vim's j/k/h/l)
  // that lands on one carries on in the same direction. A click is left where it lands,
  // since there the user chose the place.
  const overGaps = EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged || !tr.selection || tr.isUserEvent("select.pointer")) return tr;
    if (tr.selection.ranges.length !== 1) return tr;
    const state = tr.startState;
    const doc = state.doc;
    const before = state.selection.main.head;
    const range = tr.selection.main;
    const from = doc.lineAt(before);
    const to = doc.lineAt(range.head);
    if (from.number === to.number) return tr;
    const dir = to.number > from.number ? 1 : -1;
    const end = pastGap((n) => gapAt(state, doc.line(n + 1)), doc.lines, to.number - 1, dir);
    if (end === null || end === to.number - 1) return tr;
    const line = doc.line(end + 1);
    // A one-character step enters the next line at its near end; a line move keeps the
    // column it came from. A line move from the end of a line onto a blank one is also
    // a step of one, told apart by the goal column CodeMirror gives a line move.
    const head =
      Math.abs(range.head - before) === 1 && range.goalColumn == null
        ? dir > 0
          ? line.from
          : line.to
        : line.from + Math.min(before - from.from, line.length);
    const selection = range.empty ? EditorSelection.cursor(head) : EditorSelection.range(range.anchor, head);
    return [tr, { selection, sequential: true }];
  });

  // One transaction per edit, so one Undo takes it back; a join is isolated so Undo
  // never also takes the typing around it.
  const apply = (fn, userEvent, isolate = false) => ({ state, dispatch }) => {
    const range = state.selection.main;
    if (state.selection.ranges.length !== 1) return false;
    const edit = fn(state.doc.toString(), range.from, range.to);
    if (!edit) return false;
    if (edit.from < edit.to) {
      for (let pos = edit.from; pos <= edit.to; ) {
        const line = state.doc.lineAt(pos);
        if (line.length === 0 && line.from >= edit.from && line.to <= edit.to && keepBlank(state, line)) return false;
        pos = line.to + 1;
      }
    }
    dispatch(
      state.update({
        changes: { from: edit.from, to: edit.to, insert: edit.insert },
        selection: EditorSelection.cursor(edit.cursor),
        scrollIntoView: true,
        userEvent,
        annotations: isolate ? isolateHistory.of("full") : [],
      }),
    );
    return true;
  };

  // Backspace and Delete join only from a bare cursor; with a selection they delete it.
  const collapsed = (fn) => (text, from, to) => (from === to ? fn(text, from) : null);

  const keys = [
    ...(enter ? [{ key: "Enter", run: apply(enterAt, "input") }] : []),
    { key: "Shift-Enter", run: apply(breakAt, "input") },
    { key: "Backspace", run: apply(collapsed(backspaceAt), "delete.backward", true) },
    { key: "Delete", run: apply(collapsed(deleteAt), "delete.forward", true) },
  ];

  return [gaps, overGaps, gapTheme, keymap.of(keys)];
}
