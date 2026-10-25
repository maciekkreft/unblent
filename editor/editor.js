import { EditorState, EditorSelection, RangeSetBuilder, StateField, StateEffect, Transaction, Prec, Compartment, Facet } from "@codemirror/state";
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap, drawSelection } from "@codemirror/view";
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
// item, at its indent and with the marker of the item after it (a numbered list is
// renumbered after), a gap apart from it.
export function openAt(text, pos, below, item = null) {
  const from = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  let to = text.indexOf("\n", pos);
  if (to < 0) to = text.length;
  const lead = item ? " ".repeat(item.indent) + item.next + " " : "";
  if (below) return { from: to, to, insert: "\n\n" + lead, cursor: to + 2 + lead.length };
  return { from, to: from, insert: lead + "\n\n", cursor: from + lead.length };
}

// --- Lists ------------------------------------------------------------------------
// A line that begins, after any spaces, with "- " or "* " is a bullet item, with "1. "
// (any number) a numbered item, with "- [ ] " or "- [x] " (or "*") a checklist item,
// and a line that begins with "> " is a quote line (10). The marker stays in the text,
// so it stays markdown. Items of one list are a gap apart ("\n\n") when made with Enter
// and one "\n" apart when made with Shift+Enter.

const never = () => false;

const ITEM = /^( *)(?:([-*])(?: \[([ xX])\])?|(\d{1,9})\.|(>)) /;

// What the start of a line says it is, from ITEM's match. A quote has no indent of its
// own: one that begins with spaces is still a quote but never moves with Tab.
function itemOf(m) {
  const indent = m[1].length;
  if (m[5]) return { kind: "quote", indent, marker: ">", next: ">" };
  if (m[4]) return { kind: "number", indent, marker: m[4] + ".", next: Number(m[4]) + 1 + ".", number: Number(m[4]) };
  if (m[3]) return { kind: "check", indent, marker: m[2] + " [" + m[3] + "]", next: m[2] + " [ ]", ticked: m[3] !== " " };
  return { kind: "bullet", indent, marker: m[2], next: m[2] };
}

// The list item on the line holding pos: where the line starts and ends, its kind, its
// indent, its marker, the marker the item after it starts with (`next`) and where its
// text starts. Null when that line is not an item.
export function itemAt(text, pos) {
  const from = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
  let to = text.indexOf("\n", pos);
  if (to < 0) to = text.length;
  const m = ITEM.exec(text.slice(from, to));
  if (!m) return null;
  return { from, to, ...itemOf(m), textFrom: from + m[0].length };
}

// A click on a checklist item's box, or Ctrl+Enter on its line: the box ticked or
// emptied. Null when the line holding pos is not a checklist item.
export function tickAt(text, pos) {
  const item = itemAt(text, pos);
  if (!item || item.kind !== "check") return null;
  const at = item.from + item.indent + 3;
  return { from: at, to: at + 1, insert: item.ticked ? " " : "x", cursor: pos };
}

// The numbers of the lists that the lines from..to touch, made 1, 2, 3 at each level,
// as changes to the text; an indented level counts from 1 again under each item, and
// a bullet or checklist item at a level ends its numbering. A list runs over items and
// the gaps between them, the same as for Tab (aboveText), so the lines looked at reach
// past any blank lines to the nearest text above and below. `notList(n)` names a
// 0-based line that is never an item.
export function renumber(text, from = 0, to = text.length, notList = never) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const count = starts.length;
  const lineOf = (pos) => {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineText = (n) => text.slice(starts[n], n + 1 < count ? starts[n + 1] - 1 : text.length);
  const blank = (n) => lineText(n) === "";
  const listed = (n) => {
    const m = ITEM.exec(lineText(n));
    return m && !m[5] && !notList(n) ? m : null;
  };
  let a = lineOf(from);
  let b = lineOf(to);
  while (a > 0 && blank(a - 1)) a--;
  if (a > 0) a--;
  while (b < count - 1 && blank(b + 1)) b++;
  if (b < count - 1) b++;
  const inList = (n) => listed(n) || blank(n);
  while (a > 0 && inList(a) && inList(a - 1)) a--;
  while (b < count - 1 && inList(b) && inList(b + 1)) b++;
  const changes = [];
  let levels = [];
  for (let n = a; n <= b; n++) {
    if (blank(n)) continue;
    const m = listed(n);
    if (!m) {
      levels = [];
      continue;
    }
    const indent = m[1].length;
    levels = levels.filter((l) => l.indent < indent || (l.indent === indent && m[4]));
    if (!m[4]) continue;
    const last = levels.find((l) => l.indent === indent);
    const want = (last ? last.n : 0) + 1;
    if (last) last.n = want;
    else levels.push({ indent, n: want });
    if (Number(m[4]) !== want || m[4] !== String(want)) {
      const at = starts[n] + indent;
      changes.push({ from: at, to: at + m[4].length, insert: String(want) });
    }
  }
  return changes;
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
    const insert = (gap ? "\n\n" : "\n") + " ".repeat(item.indent) + item.next + " ";
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
  if (!first || first.kind === "quote" || first.from === 0) return null;
  const above = itemAt(text, aboveText(text, first.from));
  if (!above || above.kind === "quote" || above.indent < first.indent) return null;
  return reindent(text, from, to, (item) => (item.kind === "quote" ? 0 : 2));
}

// Shift+Tab: every item the selection touches moves one level out. Null when none is
// indented.
export function outdentAt(text, from, to = from) {
  if (!itemAt(text, from)) return null;
  return reindent(text, from, to, (item) => (item.kind === "quote" ? 0 : -Math.min(2, item.indent)));
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
  // The new paragraph is the first change of the insert run it opens.
  const run = view.state.field(insertRun, false);
  if (run) run.started = true;
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

// With Vim on, an insert run (i, o, O … Escape) is one change, as in Vim, so one u
// takes back the new paragraph and everything typed into it, Enters and joins included.
// CodeMirror's history joins two changes only when they come quickly and side by side,
// except a change marked "input.type.compose", which always joins the one before; the
// Vim plugin marks its own edits so for the same reason. So every edit the user makes
// in a run after its first is marked so. A paste stays a change of its own, since an
// editor may tell it by its mark. The field holds the editor's view, which the Vim state
// hangs on, and whether the run has had its first change; it is mutable because
// Vim's mode changes come from outside any transaction.
export const insertRun = StateField.define({
  create: () => ({ view: null, started: false }),
  update: (value) => value,
});

const runWatch = ViewPlugin.define((view) => {
  let watched = null;
  const attach = (v) => {
    v.state.field(insertRun).view = v;
    const cm = getCM(v);
    if (!cm || cm === watched) return;
    watched = cm;
    cm.on("vim-mode-change", () => {
      v.state.field(insertRun).started = false;
    });
  };
  attach(view);
  return { update: (update) => attach(update.view) };
});

const runJoin = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(Transaction.addToHistory) === false) return tr;
  const run = tr.startState.field(insertRun, false);
  if (!run?.view || getCM(run.view)?.state.vim?.insertMode !== true) return tr;
  // A change the editor made itself (a load, a cleared box after sending) ends the
  // run, so typing after it is never undone together with it.
  if (!tr.isUserEvent("input") && !tr.isUserEvent("delete")) {
    run.started = false;
    return tr;
  }
  if (!run.started || tr.isUserEvent("input.paste") || tr.isUserEvent("input.drop")) {
    run.started = true;
    return tr;
  }
  if (tr.isUserEvent("input.type.compose")) return tr;
  return {
    changes: tr.changes,
    selection: tr.selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    annotations: tr.annotations.filter((a) => a.type !== Transaction.userEvent && a.type !== Transaction.time),
    userEvent: "input.type.compose",
  };
});
const insertRuns = [insertRun, runWatch, runJoin];

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

// What an item's marker is drawn as: a dash for "- ", a dot for "* ", the number for
// "1. ", and for a checklist item the box, which `box(element, ticked)` draws, because
// the kit knows no icons (11.2). A click on the box ticks it, except in an editor that
// takes no typing.
class Mark extends WidgetType {
  constructor(item, box) {
    super();
    this.kind = item.kind;
    this.label = item.kind === "number" ? item.marker : item.marker === "*" ? "\u2022" : "\u2013";
    this.ticked = Boolean(item.ticked);
    this.box = box;
  }
  eq(other) {
    return other.kind === this.kind && other.label === this.label && other.ticked === this.ticked;
  }
  toDOM(view) {
    const mark = document.createElement("span");
    mark.className = "cm-item-dot";
    if (this.kind !== "check") {
      mark.textContent = this.label;
      return mark;
    }
    mark.className = this.ticked ? "cm-item-dot cm-item-box ticked" : "cm-item-dot cm-item-box";
    if (this.box) this.box(mark, this.ticked);
    else mark.textContent = this.ticked ? "\u2611" : "\u2610";
    // The cursor stays where it was: a tick is not a move.
    mark.addEventListener("mousedown", (event) => event.preventDefault());
    mark.addEventListener("click", () => tick(view, view.posAtDOM(mark)));
    return mark;
  }
}

// A quote's "> " is hidden like a bullet's marker; the bar on its line says what it is.
const quoteMark = Decoration.replace({});

const takesTyping = (state) => !state.readOnly && state.facet(EditorView.editable);

// The box on the line holding pos ticked or emptied, in one undo step of its own.
function tick(view, pos) {
  if (!takesTyping(view.state)) return false;
  const edit = tickAt(view.state.doc.toString(), pos);
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    userEvent: "input.tick",
    annotations: isolateHistory.of("full"),
  });
  return true;
}

// An item hangs: its first line starts one mark column left of the rest, so the mark
// sits in the column and the text of every line of the item lines up. Margin, not
// padding, so an editor's own side padding stays; the depth is a unitless factor in the
// line's style (11.2). A ticked item's text is muted, so what is left to do stands out.
const itemLine = (depth, ticked) =>
  Decoration.line({
    class: ticked ? "cm-item cm-ticked" : "cm-item",
    attributes: { style: `margin-left: calc(var(--space-lg) * ${depth + 1})` },
  });
const quoteLine = Decoration.line({ class: "cm-quote" });
const itemTheme = EditorView.theme({
  ".cm-line.cm-item": { textIndent: "calc(-1 * var(--space-lg))" },
  ".cm-line.cm-ticked": { color: "var(--color-body-mid)" },
  ".cm-item-dot": { display: "inline-block", width: "var(--space-lg)", textIndent: "0", textAlign: "center", color: "var(--color-body-mid)" },
  ".cm-item-box": { cursor: "pointer" },
  ".cm-item-box svg": { verticalAlign: "middle" },
  ".cm-item-box.ticked": { color: "var(--color-accent)" },
  ".cm-content[contenteditable=false] .cm-item-box": { cursor: "default" },
  ".cm-line.cm-quote": {
    marginLeft: "var(--space-2xs)",
    paddingLeft: "var(--space-sm)",
    borderLeft: "calc(var(--border-width) * 3) solid var(--color-mute)",
  },
});

// Enter makes a paragraph, Shift+Enter a line break, the cursor steps over gaps, and
// Backspace or Delete at a paragraph's edge joins across the gap in one step (10).
// `enter: false` leaves Enter to the editor (a box that sends on it); Shift+Enter, the
// gaps, the stepping and the joins stay. `keepBlank(state, line)` names a blank line
// that must stay a place to type: never drawn as a gap, never stepped over, never
// removed by a join. With Vim on, o and O open a paragraph with the same gap as Enter,
// and an insert run is one undo step (insertRun).
//
// Lines that begin with a list marker are list items and quote lines (see Lists above).
// `notList(state, line)` names a line that is never one (a heading, a fixed quote);
// `lists: false` leaves lists off. `box(element, ticked)` draws a checklist item's box
// into the element (Mark). A numbered list is renumbered after every edit the user
// makes to it, in the same undo step.
export function paragraphs({ enter = true, keepBlank = never, lists = true, notList = never, box = null } = {}) {
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

  if (!lists) return [gaps, overGaps, gapTheme, opener, insertRuns, keymap.of(keys)];

  const buildItems = (state) => {
    const found = [];
    const quoteAt = (n) => n >= 1 && n <= state.doc.lines && itemLineAt(state, state.doc.line(n).from) && /^ *> /.test(state.doc.line(n).text);
    for (let n = 1; n <= state.doc.lines; n++) {
      const line = state.doc.line(n);
      // A gap inside a quote keeps the bar, so the quote reads as one.
      if (line.length === 0 && quoteAt(n - 1) && quoteAt(n + 1)) found.push(quoteLine.range(line.from));
      const m = ITEM.exec(line.text);
      if (!m || notList(state, line)) continue;
      const item = itemOf(m);
      if (item.kind === "quote") {
        found.push(quoteLine.range(line.from));
        found.push(quoteMark.range(line.from, line.from + m[0].length));
        continue;
      }
      found.push(itemLine(Math.floor(item.indent / 2), item.ticked).range(line.from));
      found.push(Decoration.replace({ widget: new Mark(item, box) }).range(line.from, line.from + m[0].length));
    }
    return Decoration.set(found, true);
  };
  const items = StateField.define({
    create: buildItems,
    update: (value, tr) => (tr.docChanged || tr.effects.length || tr.reconfigured ? buildItems(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });

  // Every edit the user makes renumbers the lists it touches (renumber), as part of the
  // same transaction, so one Undo takes back both. A change the editor makes itself (a
  // load) is left as it is.
  const numbering = EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move"))) return tr;
    let from = Infinity;
    let to = -1;
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      from = Math.min(from, fromB);
      to = Math.max(to, toB);
    });
    const text = tr.newDoc.toString();
    if (!/^ *\d/m.test(text)) return tr;
    const changes = renumber(text, from, to, (n) => notList(tr.state, tr.state.doc.line(n + 1)));
    return changes.length ? [tr, { changes, sequential: true }] : tr;
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
    { key: "Ctrl-Enter", run: (view) => itemLineAt(view.state, view.state.selection.main.head) !== null && tick(view, view.state.selection.main.head) },
  ];

  return [keyWatch, items, numbering, itemTheme, gaps, overMarkers, overGaps, gapTheme, opener, insertRuns, keymap.of([...listKeys, ...keys])];
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

// --- Web links ----------------------------------------------------------------------
// A web address in the text, bare or as `[label](https://…)`, is drawn as a link and
// opened in a new browser tab. The text stays as typed, so what an editor stores is
// untouched. A markdown link shows only its label, except on the cursor's line while the
// editor has the keyboard, where the whole markdown shows so it can be edited.

const MD_LINK = /\[((?:[^\[\]\\\n]|\\[^\n])*)\]\((https?:\/\/[^\s()]+(?:\([^\s()]*\)[^\s()]*)*)\)/g;
const BARE_LINK = /https?:\/\/[^\s<>"`\[\]]+/g;

// A sentence's punctuation after a bare address is not part of it; a ")" stays when it
// closes a "(" inside the address, as in Wikipedia's addresses.
function trimAddress(url) {
  for (;;) {
    const last = url[url.length - 1];
    if (last === "." || last === "," || last === ":") url = url.slice(0, -1);
    else if (last === ")" && url.split(")").length > url.split("(").length) url = url.slice(0, -1);
    else return url;
  }
}

// Every web link in `text`, in order: { from, to, url }, and for a markdown link also the
// label's range and the label with the escapes off. An address inside a markdown link is
// that link's, never a bare link of its own.
export function webLinksIn(text) {
  text = String(text);
  const found = [];
  for (const m of text.matchAll(MD_LINK)) {
    const labelFrom = m.index + 1;
    const labelTo = labelFrom + m[1].length;
    found.push({ from: m.index, to: m.index + m[0].length, url: m[2], label: m[1].replace(/\\(.)/g, "$1"), labelFrom, labelTo });
  }
  const marked = found.slice();
  for (const m of text.matchAll(BARE_LINK)) {
    const url = trimAddress(m[0]);
    const from = m.index;
    const to = from + url.length;
    if (/^https?:\/\/$/.test(url)) continue;
    if (marked.some((l) => l.from < to && from < l.to)) continue;
    found.push({ from, to, url });
  }
  return found.sort((a, b) => a.from - b.from);
}

// The link at `pos`, the cursor resting on it or just before its last character, or null.
export function webLinkAt(text, pos) {
  return webLinksIn(text).find((l) => l.from <= pos && pos < l.to) ?? null;
}

const hidden = Decoration.replace({});
const linkMark = (url) => Decoration.mark({ class: "cm-web-link", attributes: { "data-href": url, title: url } });

// The decorations of a state: `rawLine` is the line number whose markdown shows whole,
// or 0 for none.
export function webLinkDecorations(state, rawLine = 0) {
  const builder = new RangeSetBuilder();
  for (const l of webLinksIn(state.doc.toString())) {
    const shown = l.label === undefined || state.doc.lineAt(l.from).number === rawLine;
    if (shown) {
      builder.add(l.from, l.to, linkMark(l.url));
      continue;
    }
    builder.add(l.from, l.labelFrom, hidden);
    if (l.labelTo > l.labelFrom) builder.add(l.labelFrom, l.labelTo, linkMark(l.url));
    builder.add(l.labelTo, l.to, hidden);
  }
  return builder.finish();
}

// gx in Vim's normal mode opens the link under the cursor in an editor using webLinks(),
// which says how through this facet; anywhere else it does nothing. Like o and O, the
// map is one per page and asks the focused editor.
const webLinkOpener = Facet.define();
Vim.defineAction("openWebLink", (cm) => {
  const view = cm.cm6;
  const open = view?.state.facet(webLinkOpener)[0];
  if (!open) return;
  const link = webLinkAt(view.state.doc.toString(), view.state.selection.main.head);
  if (link) open(link.url);
});
Vim.mapCommand("gx", "action", "openWebLink", {}, { context: "normal" });

const openInTab = (url) => window.open(url, "_blank", "noopener");

// One editor's web links. `open(url)` is how a link opens, a new tab by default. A plain
// click on a link opens it, in a read-only editor too, and does not move the cursor.
export function webLinks({ open = openInTab } = {}) {
  const rawLine = (view) => (view.hasFocus ? view.state.doc.lineAt(view.state.selection.main.head).number : 0);
  const drawn = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.line = rawLine(view);
        this.decorations = webLinkDecorations(view.state, this.line);
      }
      update(update) {
        const line = rawLine(update.view);
        if (!update.docChanged && line === this.line) return;
        this.line = line;
        this.decorations = webLinkDecorations(update.state, line);
      }
    },
    { decorations: (v) => v.decorations },
  );
  const hrefOf = (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    return event.target.closest?.(".cm-web-link")?.getAttribute("data-href") ?? null;
  };
  const clicks = EditorView.domEventHandlers({
    mousedown: (event) => {
      if (!hrefOf(event)) return false;
      event.preventDefault();
      return true;
    },
    click: (event) => {
      const url = hrefOf(event);
      if (!url) return false;
      event.preventDefault();
      open(url);
      return true;
    },
  });
  return [drawn, clicks, webLinkOpener.of(open), webLinkTheme];
}

const webLinkTheme = EditorView.theme({
  ".cm-web-link": { color: "var(--color-accent)", textDecoration: "underline", cursor: "pointer" },
});

// Vim's p reads Vim's own unnamed register, not the system clipboard, and the registers
// are one per page, so a text put here is what p pastes in any editor.
export function toRegister(text) {
  Vim.getRegisterController().pushText(null, "yank", text, false, false);
}
