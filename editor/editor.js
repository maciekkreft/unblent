import { EditorState, EditorSelection, RangeSetBuilder, StateField, StateEffect, Transaction, Prec, Compartment, Facet } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, drawSelection } from "@codemirror/view";
import { history, historyKeymap, standardKeymap, isolateHistory } from "@codemirror/commands";
import { vim, Vim, getCM } from "@replit/codemirror-vim";

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

// Vim's o and O: a new paragraph below or above the line holding pos, the same gap as
// Enter makes, so o at a line's end and Enter there leave the same text. On an item
// (`item`, what itemAt found there, or null) the new line is the next or the previous
// item, at its indent and with its marker, a gap apart from it.
export function openAt(text, pos, below, item = null) {
  const from = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  let to = text.indexOf("\n", pos);
  if (to < 0) to = text.length;
  const lead = item ? " ".repeat(item.indent) + item.marker + " " : "";
  if (below) return { from: to, to, insert: "\n\n" + lead, cursor: to + 2 + lead.length };
  return { from, to: from, insert: lead + "\n\n", cursor: from + lead.length };
}

// --- Lists ------------------------------------------------------------------------
// A line that begins with "- " or "* ", after any spaces, is a list item (10). The
// marker stays in the text, so it stays markdown. Items of one list are a gap apart
// ("\n\n") when made with Enter and one "\n" apart when made with Shift+Enter.

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

// Enter (gap) or the line-break key on an item: the next item, at the same indent, a
// gap below or one line below. On an empty item it steps out one level, or, at the top
// level, ends the list: the item becomes the blank line of a new paragraph, a gap apart
// from the text around it.
export function nextItemAt(text, from, to = from, gap = false) {
  const item = itemAt(text, from);
  if (!item || from < item.textFrom || to > item.to) return null;
  const empty = from === to && text.slice(item.textFrom, item.to).trim() === "";
  if (!empty) {
    const insert = (gap ? "\n\n" : "\n") + " ".repeat(item.indent) + item.marker + " ";
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

// The end of the nearest line that is not blank above the line starting at lineFrom
// (> 0), so a gap between two items keeps them one list; the first line when every line
// above is blank.
function aboveText(text, lineFrom) {
  let end = lineFrom - 1;
  while (end > 0 && text[end - 1] === "\n") end--;
  return end;
}

// Tab: every item the selection touches moves one level in, when the item above, past
// any gap, is at least as deep as the first of them, so a list never skips a level.
// Null when it cannot, so Tab is left to the browser.
export function indentAt(text, from, to = from) {
  const first = itemAt(text, from);
  if (!first || first.from === 0) return null;
  const above = itemAt(text, aboveText(text, first.from));
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
// key goes on to the end of the line above and Vim's word back on to the last word above,
// both past any gap; Vim's h, 0, ^ and I stay, as they never leave a line.
export function markerStop(text, head, before, by) {
  const item = itemAt(text, head);
  if (!item || head >= item.textFrom) return null;
  const sameLine = before >= item.textFrom && before <= item.to;
  if (by === "pointer" || !sameLine || item.from === 0 || before !== item.textFrom) return item.textFrom;
  if (by === "key") return head === before - 1 ? aboveText(text, item.from) : item.textFrom;
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

// Vim's command line (:) is a CodeMirror panel, which CodeMirror paints a fixed light
// grey, while the input in it takes the browser's text colour, white in dark mode. Both
// follow the tokens instead, as the reader's own command line does. "&.cm-editor"
// outranks the library's "&light" rule, which carries one class more than a plain one.
const panelTheme = EditorView.theme({
  "&.cm-editor .cm-panels": { backgroundColor: "var(--color-canvas)", color: "var(--color-ink)" },
  "&.cm-editor .cm-panels-bottom": { borderTop: "var(--border-width) solid var(--color-border)" },
  ".cm-vim-panel": { fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" },
  ".cm-vim-panel input": { color: "inherit", font: "inherit" },
});

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
const vimContent = (on) => (on ? [vim(), fatCursor, panelTheme] : []);

// The "Vim keys" preference (12) turned on or off in place, keeping the text and the
// undo history. Safe to call on every update: it dispatches only on a change.
export function setVim(view, on) {
  const now = vimSlot.get(view.state);
  if (now === undefined || (Array.isArray(now) && now.length > 0) === Boolean(on)) return;
  view.dispatch({ effects: vimSlot.reconfigure(vimContent(on)) });
}

// Ex commands are global to the Vim module, so :q is registered once here and each
// editor says what quitting means for it through this facet; one without a handler
// quits nothing. The facet sits outside the Vim compartment, so setVim keeps it.
const quitHandler = Facet.define();
const quitEditor = (cm) => {
  for (const quit of cm.cm6.state.facet(quitHandler)) quit(cm.cm6);
};
Vim.defineEx("quit", "q", quitEditor);
// A stage keeps a tab per thing it shows, so closing the tab is quitting the editor in it.
Vim.defineEx("tabclose", "tabc", quitEditor);

// Vim's o and O open a paragraph (openAt) in an editor using paragraphs(), which says
// how through this facet; anywhere else they are Vim's own. Vim's maps are one per page,
// so the action is mapped once here and asks the focused editor. An action is called as
// a method of Vim's action table, so `this` reaches Vim's own o and its insert mode.
export const paragraphsOpener = Facet.define();
Vim.defineAction("openParagraph", function (cm, args, vimState) {
  const view = cm.cm6;
  const open = view?.state.facet(paragraphsOpener)[0];
  if (!open || view.state.readOnly) return this.newLineAndEnterInsertMode(cm, args, vimState);
  const edit = open(view.state, args.after);
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.cursor(edit.cursor),
    scrollIntoView: true,
    userEvent: "input",
  });
  this.enterInsertMode(cm, { repeat: args.repeat }, vimState);
});
for (const [key, after] of [["o", true], ["O", false]]) {
  Vim.mapCommand(key, "action", "openParagraph", { after }, { isEdit: true, interlaceInsertRepeat: true, context: "normal" });
}

// The shared setup. Put first in an editor's extensions: the Vim plugin must see a key
// before any keymap does. The standard and history keys are low precedence, so an
// editor's own keymap (and paragraphs()) wins over them. `history: false` is for an
// editor that holds history in a compartment of its own, to empty it by reconfiguring.
// `quit(view)` runs when the user types :q, :quit, :tabc or :tabclose with Vim on.
export function baseExtensions({ vim: vimOn = false, history: withHistory = true, quit = null } = {}) {
  return [
    vimSlot.of(vimContent(vimOn)),
    quit ? quitHandler.of(quit) : [],
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
// removed by a join. With Vim on, o and O open a paragraph with the same gap as Enter.
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

  const itemLineAt = (state, pos) => {
    const line = state.doc.lineAt(pos);
    return lists && !notList(state, line) && ITEM.test(line.text) ? line : null;
  };

  // What Vim's o and O do here (see paragraphsOpener): the edit openAt makes, on an item
  // only where this editor has items.
  const opener = paragraphsOpener.of((state, below) => {
    const head = state.selection.main.head;
    const text = state.doc.toString();
    return openAt(text, head, below, itemLineAt(state, head) ? itemAt(text, head) : null);
  });

  if (!lists) return [gaps, overGaps, gapTheme, opener, keymap.of(keys)];

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
    { key: "Enter", run: enter ? onItem((text, from, to) => nextItemAt(text, from, to, true), "input") : never },
    { key: "Shift-Enter", run: onItem(nextItemAt, "input") },
    { key: "Backspace", run: onItem(collapsed(unbulletAt), "delete.backward", true) },
    { key: "Tab", run: onItem(indentAt, "input.indent") },
    { key: "Shift-Tab", run: onItem(outdentAt, "delete.dedent") },
  ];

  return [keyWatch, items, itemTheme, gaps, overMarkers, overGaps, gapTheme, opener, keymap.of([...listKeys, ...keys])];
}

// --- Source links -------------------------------------------------------------------
// A source link, `[label](note:<id>)`, is a link in an editor's text to a highlight (13).
// It stays raw in the document, so what an editor stores is untouched; it is drawn as one
// tag and kept atomic the way a list item's marker is (overMarkers): the cursor never
// rests inside it, and a deletion that reaches into it takes it whole (10).

// Every source link in `text`, by its range in the text and its label with the escapes
// off. A label never spans lines.
const SOURCE_LINK = /\[((?:[^\[\]\\\n]|\\[^\n])*)\]\(note:([0-9A-HJKMNP-TV-Z]{26})\)/g;
export function sourceLinksIn(text) {
  const found = [];
  for (const m of String(text).matchAll(SOURCE_LINK)) {
    found.push({ from: m.index, to: m.index + m[0].length, id: m[2], label: m[1].replace(/\\(.)/g, "$1") });
  }
  return found;
}

// Which links' highlights are gone, as a test on the highlight's id: the editor learns it
// from its own actor and hands it over with missingLinks.
const setMissing = StateEffect.define();

// One editor's tags: `follow(id)` runs on a click on a tag, or Enter on it in Vim's
// normal mode, also in a read-only editor; `icon(element)` draws the link glyph into the
// tag, because the kit knows no icons (11.2); `missing(id)` says which tags start grey.
export function sourceLinks({ follow, icon = () => {}, missing = () => false }) {
  class LinkTag extends WidgetType {
    constructor(label, id, gone) {
      super();
      this.label = label;
      this.id = id;
      this.gone = gone;
    }
    eq(other) {
      return other.label === this.label && other.id === this.id && other.gone === this.gone;
    }
    toDOM() {
      const tag = document.createElement("span");
      tag.className = this.gone ? "cm-source-link removed" : "cm-source-link";
      tag.title = this.gone ? "This highlight was removed" : "Open the passage";
      const glyph = document.createElement("span");
      glyph.className = "cm-source-icon";
      icon(glyph);
      const label = document.createElement("span");
      label.className = "cm-source-label";
      label.textContent = this.label;
      tag.append(glyph, label);
      tag.addEventListener("click", () => follow(this.id));
      return tag;
    }
  }

  const decos = (state, gone) =>
    Decoration.set(
      sourceLinksIn(state.doc.toString()).map((l) =>
        Decoration.replace({ widget: new LinkTag(l.label, l.id, Boolean(gone(l.id))) }).range(l.from, l.to),
      ),
    );

  const field = StateField.define({
    create: (state) => ({ missing, deco: decos(state, missing) }),
    update(value, tr) {
      let gone = value.missing;
      for (const e of tr.effects) if (e.is(setMissing)) gone = e.value;
      if (!tr.docChanged && gone === value.missing) return value;
      return { missing: gone, deco: decos(tr.state, gone) };
    },
    provide: (f) => [EditorView.decorations.from(f, (v) => v.deco), EditorView.atomicRanges.of((view) => view.state.field(f).deco)],
  });

  const linksIn = (state) => sourceLinksIn(state.doc.toString());

  // Vim moves the cursor by its own reckoning, past CodeMirror's atomic ranges, so a bare
  // cursor that lands inside a tag is put at the edge it was heading for.
  const overLinks = EditorState.transactionFilter.of((tr) => {
    if (tr.docChanged || !tr.selection || tr.selection.ranges.length !== 1 || !tr.selection.main.empty) return tr;
    const head = tr.selection.main.head;
    const link = linksIn(tr.startState).find((l) => l.from < head && head < l.to);
    if (!link) return tr;
    const to = head > tr.startState.selection.main.head ? link.to : link.from;
    return [tr, { selection: EditorSelection.cursor(to), sequential: true }];
  });

  // A deletion that reaches into a tag, Backspace after it or x on it, takes the whole
  // tag, and text put inside one, as Vim's p does on the tag (it pastes after the
  // character under the cursor), goes after it.
  const wholeLinks = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    const found = linksIn(tr.startState);
    if (found.length === 0) return tr;
    const changes = [];
    let grown = false;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      let from = fromA;
      let to = toA;
      const inside = to === from && found.find((l) => l.from < from && from < l.to);
      if (inside) {
        from = to = inside.to;
        grown = true;
      }
      if (to > from) {
        for (const l of found) {
          if (l.from < to && l.to > from && (l.from < from || l.to > to)) {
            from = Math.min(from, l.from);
            to = Math.max(to, l.to);
            grown = true;
          }
        }
      }
      changes.push({ from, to, insert: inserted });
    });
    if (!grown) return tr;
    const last = changes[changes.length - 1];
    return {
      changes,
      selection: EditorSelection.cursor(last.from + last.insert.length),
      effects: tr.effects,
      userEvent: tr.annotation(Transaction.userEvent),
      scrollIntoView: tr.scrollIntoView,
    };
  });

  // Enter on a tag in Vim's normal mode follows it, before Vim moves the cursor down.
  const enterFollows = Prec.highest(
    EditorView.domEventHandlers({
      keydown: (event, view) => {
        if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
        const state = getCM(view)?.state.vim;
        if (!state || state.insertMode || state.visualMode) return false;
        const head = view.state.selection.main.head;
        const link = linksIn(view.state).find((l) => l.from <= head && head < l.to);
        if (!link) return false;
        event.preventDefault();
        follow(link.id);
        return true;
      },
    }),
  );

  return [field, wholeLinks, overLinks, enterFollows, linkTheme];
}

// A new test of which highlights are gone, redrawing the tags at once. The editor calls it
// only when its actor's answer changed, since each call redraws.
export function missingLinks(view, missing) {
  view.dispatch({ effects: setMissing.of(missing) });
}

const linkTheme = EditorView.theme({
  ".cm-source-link": {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2xs)",
    padding: "0 var(--space-2xs)",
    borderRadius: "var(--radius-sm)",
    background: "var(--color-accent-subtle)",
    color: "var(--color-accent)",
    cursor: "pointer",
  },
  ".cm-source-icon": { display: "inline-flex" },
  ".cm-source-link.removed": {
    background: "none",
    color: "var(--color-mute)",
    textDecoration: "line-through",
  },
});

// Vim's p reads Vim's own unnamed register, not the system clipboard, and the registers
// are one per page, so a text put here is what p pastes in any editor.
export function toRegister(text) {
  Vim.getRegisterController().pushText(null, "yank", text, false, false);
}
