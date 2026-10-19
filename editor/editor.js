import { EditorState, EditorSelection, RangeSetBuilder, StateField, Prec, Compartment } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, drawSelection } from "@codemirror/view";
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

// --- Lists ------------------------------------------------------------------------
// A line that begins with "- " or "* ", after any spaces, is a list item (10). Items of
// one list are one "\n" apart, and the marker stays in the text, so it stays markdown.

const ITEM = /^( *)([-*]) /;

// The list item on the line holding pos: where the line starts and ends, its indent,
// its marker and where its text starts. Null when that line is not an item.
export function itemAt(text, pos) {
  const from = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  let to = text.indexOf("\n", pos);
  if (to < 0) to = text.length;
  const m = ITEM.exec(text.slice(from, to));
  if (!m) return null;
  return { from, to, indent: m[1].length, marker: m[2], textFrom: from + m[0].length };
}

// Enter (or the line-break key) on an item: the next item, at the same indent. On an
// empty item it steps out one level, or, at the top level, ends the list: the item
// becomes the blank line of a new paragraph, a gap apart from the text around it.
export function nextItemAt(text, from, to = from) {
  const item = itemAt(text, from);
  if (!item || from < item.textFrom || to > item.to) return null;
  const empty = from === to && text.slice(item.textFrom, item.to).trim() === "";
  if (!empty) {
    const insert = "\n" + " ".repeat(item.indent) + item.marker + " ";
    return { from, to, insert, cursor: from + insert.length };
  }
  if (item.indent > 0) {
    const cut = Math.min(2, item.indent);
    return { from: item.from, to: item.from + cut, insert: "", cursor: from - cut };
  }
  const textBefore = item.from > 1 && text[item.from - 2] !== "\n";
  const textAfter = item.to + 1 < text.length && text[item.to + 1] !== "\n";
  const insert = (textBefore ? "\n" : "") + (textAfter ? "\n" : "");
  return { from: item.from, to: item.to, insert, cursor: item.from + (textBefore ? 1 : 0) };
}

// Backspace at the start of an item's text: the bullet (and its indent) goes, the text
// stays. Anywhere else null.
export function unbulletAt(text, pos) {
  const item = itemAt(text, pos);
  if (!item || pos !== item.textFrom) return null;
  return { from: item.from, to: item.textFrom, insert: "", cursor: item.from };
}

// The items on the lines from..to spans, each with its line, in order.
function itemsIn(text, from, to) {
  const out = [];
  let pos = from === 0 ? 0 : text.lastIndexOf("\n", from - 1) + 1;
  while (pos <= to) {
    const item = itemAt(text, pos);
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    if (item) out.push(item);
    pos = end + 1;
  }
  return out;
}

// Rewrite the lines from..to spans with `per(item)` spaces added (or removed, when
// negative) before each item, and move the selection with its text.
function reindent(text, from, to, per) {
  const items = itemsIn(text, from, to);
  const deltas = items.map(per);
  if (deltas.every((d) => d === 0)) return null;
  const start = items[0].from;
  const end = items[items.length - 1].to;
  let insert = "";
  let at = start;
  items.forEach((item, i) => {
    const d = deltas[i];
    insert += text.slice(at, item.from) + (d > 0 ? " ".repeat(d) : "") + text.slice(item.from - Math.min(d, 0), item.to);
    at = item.to;
  });
  const map = (pos) => {
    let out = pos;
    items.forEach((item, i) => {
      const d = deltas[i];
      if (d > 0 && pos >= item.textFrom) out += d;
      if (d < 0 && pos >= item.from - d) out += d;
    });
    return out;
  };
  return { from: start, to: end, insert, anchor: map(from), cursor: map(to) };
}

// Tab: every item the selection touches moves one level in, when the line above is an
// item at least as deep as the first of them, so a list never skips a level. Null when
// it cannot, so Tab is left to the browser.
export function indentAt(text, from, to = from) {
  const first = itemAt(text, from);
  if (!first || first.from === 0) return null;
  const above = itemAt(text, first.from - 1);
  if (!above || above.indent < first.indent) return null;
  return reindent(text, from, to, () => 2);
}

// Shift+Tab: every item the selection touches moves one level out. Null when none is
// indented.
export function outdentAt(text, from, to = from) {
  if (!itemAt(text, from)) return null;
  return reindent(text, from, to, (item) => -Math.min(2, item.indent));
}

// Where a bare cursor that lands inside an item's marker (or before it) should rest
// instead, so it never stops there. `before` is where it came from; `by` is "pointer"
// (a click), "key" (CodeMirror's own moves), "back" (Vim's b or ge, a word back) or
// "other" (Vim's other motions). From another line, by a click, or from inside the text,
// it rests at the start of the text. From the start of the text, a step back by an arrow
// key goes on to the end of the line above, and Vim's word back on to the last word above,
// past any gap; Vim's h, 0, ^ and I stay, as they never leave a line.
export function markerStop(text, head, before, by) {
  const item = itemAt(text, head);
  if (!item || head >= item.textFrom) return null;
  const sameLine = before >= item.textFrom && before <= item.to;
  if (by === "pointer" || !sameLine || item.from === 0 || before !== item.textFrom) return item.textFrom;
  if (by === "key") return head === before - 1 ? item.from - 1 : item.textFrom;
  if (by !== "back") return item.textFrom;
  let word = item.from - 1;
  while (word > 0 && /\s/.test(text[word - 1])) word--;
  while (word > 0 && !/\s/.test(text[word - 1])) word--;
  return word;
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
    ".cm-placeholder": { color: "var(--color-body-mid)" },
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

// Vim moves the cursor with no word of which motion did it, and its b lands on a marker
// just as its ^, 0 and I do, so the key itself is watched: the one being handled, and
// the one before it, for ge. At the highest precedence, so it is seen before Vim's own
// handler moves the cursor; one keyboard per page, so one record serves every editor.
let keyNow = null;
let keyBefore = null;
const keyWatch = Prec.highest(
  EditorView.domEventHandlers({
    keydown: (event) => {
      keyNow = event.key;
      queueMicrotask(() => {
        keyBefore = keyNow;
        keyNow = null;
      });
      return false;
    },
  }),
);
const vimBack = () => keyNow === "b" || keyNow === "B" || ((keyNow === "e" || keyNow === "E") && keyBefore === "g");

// The dot an item's marker is drawn as. Every dot is alike, so one is as good as another.
class Dot extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "cm-item-dot";
    dot.textContent = "\u2022";
    return dot;
  }
}
const dot = Decoration.replace({ widget: new Dot() });

// An item hangs: its first line starts one dot column left of the rest, so the dot sits
// in the column and the text of every line of the item lines up. Margin, not padding,
// so an editor's own side padding stays; the depth is a unitless factor in the line's
// style (11.2).
const itemLine = (depth) =>
  Decoration.line({ class: "cm-item", attributes: { style: `margin-left: calc(var(--space-lg) * ${depth + 1})` } });
const itemTheme = EditorView.theme({
  ".cm-line.cm-item": { textIndent: "calc(-1 * var(--space-lg))" },
  ".cm-item-dot": { display: "inline-block", width: "var(--space-lg)", textIndent: "0", textAlign: "center", color: "var(--color-body-mid)" },
});

// Enter makes a paragraph, Shift+Enter a line break, the cursor steps over gaps, and
// Backspace or Delete at a paragraph's edge joins across the gap in one step (10).
// `enter: false` leaves Enter to the editor (a box that sends on it); Shift+Enter, the
// gaps, the stepping and the joins stay. `keepBlank(state, line)` names a blank line
// that must stay a place to type: never drawn as a gap, never stepped over, never
// removed by a join.
//
// Lines that begin with "- " or "* " are list items (see Lists above). `notList(state,
// line)` names a line that is never one (a heading, a fixed quote); `lists: false`
// leaves lists off.
export function paragraphs({ enter = true, keepBlank = never, lists = true, notList = never } = {}) {
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
        selection: edit.anchor == null ? EditorSelection.cursor(edit.cursor) : EditorSelection.range(edit.anchor, edit.cursor),
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

  if (!lists) return [gaps, overGaps, gapTheme, keymap.of(keys)];

  const itemLineAt = (state, pos) => {
    const line = state.doc.lineAt(pos);
    return !notList(state, line) && ITEM.test(line.text) ? line : null;
  };

  const buildItems = (state) => {
    const found = [];
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      const m = ITEM.exec(line.text);
      if (!m || notList(state, line)) continue;
      found.push(itemLine(Math.floor(m[1].length / 2)).range(line.from));
      found.push(dot.range(line.from, line.from + m[0].length));
    }
    return Decoration.set(found, true);
  };
  const items = StateField.define({
    create: buildItems,
    update: (value, tr) => (tr.docChanged || tr.effects.length || tr.reconfigured ? buildItems(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });

  // A bare cursor never rests inside a marker (markerStop). Listed before overGaps so it
  // runs after it (filters run last first) and also moves a cursor overGaps placed.
  const overMarkers = EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged || !tr.selection || tr.selection.ranges.length !== 1 || !tr.selection.main.empty) return tr;
    const head = tr.selection.main.head;
    if (!itemLineAt(tr.startState, head)) return tr;
    const by = tr.isUserEvent("select.pointer") ? "pointer" : tr.isUserEvent("select") ? "key" : vimBack() ? "back" : "other";
    const to = markerStop(tr.startState.doc.toString(), head, tr.startState.selection.main.head, by);
    if (to === null || to === head) return tr;
    return [tr, { selection: EditorSelection.cursor(to), sequential: true }];
  });

  // The list keys act only on an item's line; anywhere else they fall through, to the
  // paragraph keys or, for Tab, to the browser, which moves focus.
  const onItem = (fn, userEvent, isolate) => {
    const run = apply(fn, userEvent, isolate);
    return (target) => itemLineAt(target.state, target.state.selection.main.from) !== null && run(target);
  };
  const listKeys = [
    { key: "Enter", run: enter ? onItem(nextItemAt, "input") : never },
    { key: "Shift-Enter", run: onItem(nextItemAt, "input") },
    { key: "Backspace", run: onItem(collapsed(unbulletAt), "delete.backward", true) },
    { key: "Tab", run: onItem(indentAt, "input.indent") },
    { key: "Shift-Tab", run: onItem(outdentAt, "delete.dedent") },
  ];

  return [keyWatch, items, itemTheme, gaps, overMarkers, overGaps, gapTheme, keymap.of([...listKeys, ...keys])];
}
