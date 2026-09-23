import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { EditorState, StateField, StateEffect, Annotation, Prec, Transaction, Compartment } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, drawSelection } from "@codemirror/view";
import { history, historyKeymap, invertedEffects } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";
import { machine, ordered, compose, split } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import discarded from "./events/note.discarded.json" with { type: "json" };

// The page in the right dock (8, kind 4; Decision 2): the highlights of the book on the
// stage as one continuous CodeMirror document. Per highlight a quote line that cannot be
// edited and, under it, the comment — the note's body. Each highlight is one ordinary
// note (Decision 1); this view owns only the CodeMirror document and reflects the facts
// the machine holds.
//
// Vim sits in a compartment that the "Vim keys" preference (12) turns on and off in
// place. It registers no Vim key maps of its own — Vim maps are global to the page and
// would also change the note editor's keys — so `dd` on a quote line, and every other
// key, is understood in the transaction filter from the edit it produces, not from the
// key. The filter (see quoteFilter) therefore holds in both modes: it keeps the quote
// lines fixed and turns a whole-line delete of a quote, by `dd` or by selecting the line
// and pressing Delete, into the same undo-window discard the bin uses, an undo the
// history can take back.

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo window;
// the token is the one clock, shared with the draining bar's animation (as in note-list).
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// The view's own transactions carry this so the transaction filter lets them through and
// the update listener does not echo them back to the machine as typing (as #shown does in
// note-editor): only the user's edits become _typed.
const fromView = Annotation.define();

// Rebuild the whole index of quote lines from the fragments (a load), the setAllLevels
// idiom of note-editor; and set which fragments are counting down to a discard.
const setQuotes = StateEffect.define();
const setDiscarding = StateEffect.define();

// The three effects the filter dispatches in place of a user edit it will not apply as
// typed. discardAsked begins the undo window for one highlight (a `dd` on its quote line,
// or the bin); undoAsked takes it back; both are recorded in the history and inverted
// into each other (invertDiscard), so Vim's `u` and `Ctrl-R` move through them. setRefused
// carries the ids of the quote lines that must flash because a change would have damaged
// them (the whole set at once, so it is also how the flash is cleared).
const discardAsked = StateEffect.define();
const undoAsked = StateEffect.define();
const setRefused = StateEffect.define();

// The history keeps a discard and its undo as inverses, so `u` in the window brings a
// highlight back and `Ctrl-R` removes it again. Both effects carry no document change, so
// history stores them only because invertedEffects returns something for them.
const invertDiscard = (tr) => {
  const out = [];
  for (const e of tr.effects) {
    if (e.is(discardAsked)) out.push(undoAsked.of(e.value));
    else if (e.is(undoAsked)) out.push(discardAsked.of(e.value));
  }
  return out;
};

// The index: one line decoration per quote line, carrying the note id and the quote text
// it must keep (data-id for the styling and lookup, the text for the filter). It maps
// through every change (a comment gaining or losing a line moves the quote lines below),
// so a position always names the right note; a load rebuilds it from the fragments.
const quoteField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setQuotes)) {
        const ranges = e.value.map((q) =>
          Decoration.line({ class: "cm-quote", attributes: { "data-id": q.id }, quote: q.quote }).range(
            tr.state.doc.line(q.line + 1).from,
          ),
        );
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Which fragments are inside their undo window: the machine's discarding set, mirrored
// into the editor so the decorations that dim the lines and swap the bin for Undo can be
// computed from state alone. Replaced whole, since a Set does not map through changes.
const discardField = StateField.define({
  create: () => new Set(),
  update(set, tr) {
    for (const e of tr.effects) if (e.is(setDiscarding)) return e.value;
    return set;
  },
});

// The ids of the quote lines flashing to show a refused change (Decision 4), mirrored
// from setRefused so the decoration can be computed from state alone. Replaced whole.
const refusedField = StateField.define({
  create: () => new Set(),
  update(set, tr) {
    for (const e of tr.effects) if (e.is(setRefused)) return e.value;
    return set;
  },
});

// Read the quote lines a transaction's start state holds, each with its id, its line
// start and the quote text it must keep.
const quotesBefore = (tr) => {
  const out = [];
  for (let it = tr.startState.field(quoteField).iter(); it.value; it.next()) {
    out.push({ id: it.value.spec.attributes["data-id"], from: it.from, quote: it.value.spec.quote });
  }
  return out;
};

// Whether a change is exactly one whole-line deletion of a quote's line (a `dd` on it,
// or the line and its line break selected and deleted):
// a single pure deletion covering the quote line and its trailing newline (a quote line
// is never the document's last line, so that newline is always there).
const isLineDelete = (tr, from) => {
  const line = tr.startState.doc.lineAt(from);
  let count = 0;
  let clean = false;
  tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    count += 1;
    if (inserted.length === 0 && fromA === line.from && toA === line.to + 1) clean = true;
  });
  return count === 1 && clean;
};

// The change that empties a highlight's comment to a single blank line: replace the
// comment text (everything from just after the quote line's newline to the char before
// the next quote line, or the document end) with nothing, keeping the surrounding line
// breaks. Computed against the start state, the space filter output is resolved in.
const emptyComment = (tr, q) => {
  const state = tr.startState;
  const quoteLine = state.doc.lineAt(q.from);
  const nexts = quotesBefore(tr)
    .map((b) => b.from)
    .filter((f) => f > q.from)
    .sort((a, b) => a - b);
  const to = nexts.length ? nexts[0] - 1 : state.doc.length;
  return { changes: { from: quoteLine.to + 1, to, insert: "" } };
};

// The quote lines cannot be edited (Decision 2), so a user transaction is never applied
// as typed when it would touch one. Vim registers no keys here (see the file head), so a
// change is judged only by what it did (Decision 4): a clean `dd` on a quote line becomes
// a discard through the undo window (discardAsked); a change that would leave a highlight
// with no comment line is turned into one blank comment line (emptyComment); any other
// change that moves or edits a quote line is refused and flashes it (setRefused). The
// view's own edits carry fromView and are never filtered; an undo carries filter:false.
const quoteFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(fromView)) return tr;
  const before = quotesBefore(tr);
  const doc = tr.newDoc;
  const survivors = [];
  const missing = [];
  for (const q of before) {
    const pos = tr.changes.mapPos(q.from, 1);
    const line = doc.lineAt(pos);
    if (line.from === pos && line.text === q.quote) survivors.push({ ...q, pos, number: line.number });
    else missing.push(q);
  }
  const starts = new Set(survivors.map((s) => s.pos));
  const emptied = survivors.filter((s) => s.number >= doc.lines || starts.has(doc.line(s.number + 1).from));

  if (missing.length === 0 && emptied.length === 0) return tr; // an ordinary comment edit
  if (missing.length === 1 && emptied.length === 0 && isLineDelete(tr, missing[0].from)) {
    return { effects: discardAsked.of(missing[0].id) }; // `dd` on a quote line: discard it
  }
  if (missing.length === 0 && emptied.length === 1) return emptyComment(tr, emptied[0]);
  const damaged = new Set([...missing, ...emptied].map((q) => q.id));
  return { effects: setRefused.of(damaged), annotations: Transaction.addToHistory.of(false) };
});

// The structural theme, keyed to tokens like note-editor's; line spacing is padding,
// never margin. The decoration visuals (the quote highlight, the bin, the drain) live in
// the component's own styles, which share this shadow root and are checked for tokens.
const editorTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "var(--leading-normal)", overflow: "auto" },
  ".cm-content": { caretColor: "var(--color-accent)", padding: "var(--space-sm) var(--space-2xs)" },
  ".cm-line": { fontSize: "var(--text-body)", padding: "0 var(--space-md)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
});

// The Vim block cursor, keyed to tokens, copied from note-editor (components never
// import each other, 11.2). The plugin ships its own Prec.highest theme, so this raises
// precedence and marks the competing properties !important to win regardless of order.
// Focused, it fills with the accent; unfocused, it is hollowed with an inset shadow,
// which no edge clip can reach — the plugin draws an outline outside an absolutely
// positioned span, and Safari clips its top and left.
const fatCursorTheme = Prec.highest(
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

// Vim and its block cursor, or nothing: what the Vim compartment holds for the
// "Vim keys" preference (12).
const vimExtensions = (on) => (on ? [vim(), fatCursorTheme] : []);

// The bin at the end of a quote line: a muted trash button that begins the undo window,
// or, during that window, an Undo button and the draining bar. The DOM is recreated when
// the discarding state flips (eq), so the bar's animation starts fresh each time, the
// note-list idiom. A phone has no hover, so it is always visible.
class BinWidget extends WidgetType {
  constructor(id, discarding, active, discard, undo) {
    super();
    this.id = id;
    this.discarding = discarding;
    this.active = active;
    // discard dispatches through the editor so the removal is in the history and Vim's
    // `u` takes it back; undo cancels the window directly (it is not a history step).
    this.discard = discard;
    this.undo = undo;
  }

  eq(other) {
    return other.id === this.id && other.discarding === this.discarding && other.active === this.active;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-bin-wrap";
    if (this.discarding) {
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "cm-undo";
      undo.textContent = "Undo";
      undo.setAttribute("aria-label", "Undo remove");
      undo.addEventListener("mousedown", (e) => e.preventDefault());
      undo.addEventListener("click", () => this.undo(this.id));
      wrap.append(undo, Object.assign(document.createElement("span"), { className: "cm-bar" }));
    } else {
      const bin = document.createElement("button");
      bin.type = "button";
      bin.className = this.active ? "cm-bin cm-active" : "cm-bin";
      bin.setAttribute("aria-label", "Remove highlight");
      bin.addEventListener("mousedown", (e) => e.preventDefault());
      bin.addEventListener("click", () => this.discard(this.id));
      const glyph = document.createElement("span");
      render(icon("trash-simple"), glyph);
      bin.append(glyph);
      wrap.append(bin);
    }
    return wrap;
  }

  ignoreEvent() {
    return true; // the widget's own listeners handle it; the editor ignores it (no caret move)
  }
}

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        undoMs,
      },
      events: { "note.saved": saved, "note.discarded": discarded },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected() {
    this.subscription?.unsubscribe();
    unmount(this.actor);
  }

  get snapshot() {
    return this.actor?.getSnapshot();
  }

  send(event) {
    this.actor?.send(event);
  }
}

class HighlightNotes extends LitElement {
  static properties = {
    // height="fill" makes the tab take the height its dock leaves, so the document
    // scrolls inside it. Reflected so the manifest attribute is visible.
    height: { type: String, reflect: true },
  };

  static styles = css`
    :host {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    /* CodeMirror owns everything inside .region; Lit never touches its subtree. */
    .region {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .region:focus-within {
      outline: var(--focus-ring);
      outline-offset: calc(-1 * var(--space-2xs));
    }
    /* A quote line: the note's highlighted passage, set in the app's highlight colour
       exactly as in the book (Decision 4), its rounded ends repeating on every wrapped
       line. It is emphasised so it reads as the thing the comment is about. */
    .cm-line.cm-quote {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .cm-quote-text {
      background: var(--color-highlight);
      border-radius: var(--radius-sm);
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
    }
    /* A highlight inside its undo window: its lines struck through and muted, the note-list
       idiom, so the user sees what is going before it goes. */
    .cm-line.cm-discarding {
      color: var(--color-mute);
      text-decoration: line-through;
    }
    /* A quote line the user tried to change (Decision 4): a danger tint that fades out, so
       a refused edit is seen, not silent. The field clears after --duration-slide, so the
       class and its background go together. Under reduced motion the tint holds still for
       the same time — it is the only sign of the refusal. */
    .cm-line.cm-refused {
      animation: refuse var(--duration-slide) var(--ease);
    }
    @keyframes refuse {
      from {
        background: var(--color-danger-subtle);
      }
      to {
        background: transparent;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .cm-line.cm-refused {
        animation: none;
        background: var(--color-danger-subtle);
      }
    }
    /* The trailing control on a quote line: the bin, or Undo with the draining bar. */
    .cm-bin-wrap {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      margin-left: var(--space-sm);
      vertical-align: baseline;
    }
    .cm-bin,
    .cm-undo {
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      margin: 0;
      font: inherit;
      cursor: pointer;
    }
    .cm-bin {
      display: inline-flex;
      font-size: var(--text-body);
      color: var(--color-body-mid);
      visibility: hidden;
    }
    /* The bin stays out of the way until it is wanted: it appears when the highlight is
       hovered, or, while the editor is focused, in the highlight the caret sits in —
       the phone path, since a phone has no hover, where tapping a comment focuses the
       editor there. An unfocused panel shows no bin, so a stale caret never keeps one
       lit. Undo, during the undo window, is always shown so the removal can still be
       taken back. */
    .cm-line.cm-quote:hover .cm-bin,
    .cm-focused .cm-bin.cm-active {
      visibility: visible;
    }
    .cm-bin:hover {
      color: var(--color-danger);
    }
    .cm-bin svg {
      display: block;
    }
    .cm-undo {
      font-size: var(--text-caption);
      color: var(--color-accent);
    }
    /* The bar is the visible echo of the machine's timer; both read --duration-undo, so
       they cannot disagree. It stays under reduced motion: it is the only sign of the time
       left. */
    .cm-bar {
      width: var(--space-2xl);
      height: var(--space-2xs);
      background: var(--color-accent);
      transform-origin: left;
      animation: drain var(--duration-undo) linear forwards;
    }
    @keyframes drain {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0);
      }
    }
    /* Nothing highlighted yet: a word and the highlighter mark, over the empty editor. */
    .empty {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-sm);
      padding: var(--space-2xl) var(--space-md);
      text-align: center;
      background: var(--color-canvas);
      color: var(--color-mute);
      font-size: var(--text-sm);
    }
    .empty .mark {
      display: inline-flex;
      font-size: var(--text-heading);
      color: var(--color-body-mid);
    }
    .empty .mark svg {
      display: block;
    }
    .empty p {
      margin: 0;
      max-width: calc(var(--space-2xl) * 8);
    }
  `;

  #actor = new ActorController(this);
  #view = null;
  // The document last built from the facts or read out of the editor, so an actor update
  // that changes nothing new does not rewrite the document and lose the caret (4.3).
  #shown = "";
  // The note ids in document order, and the discarding set, both as last applied, so an
  // update knows which fragments were added (to scroll to) and whether the dimming changed.
  #order = [];
  #discShown = new Set();
  // A highlight that arrived while the document was hidden (a folded dock, the list in
  // front), scrolled to once the document has a height again: a hidden scroller cannot scroll.
  #pendingScroll = null;
  // A frame later, so CodeMirror has measured the lines it could not while hidden.
  #resize = new ResizeObserver(() => requestAnimationFrame(() => this.#scrollPending()));
  // How long the refusal flash lasts (the --duration-slide token, read in firstUpdated),
  // and the timer that clears it, cancelled on the next refusal and on disconnect.
  #flashMs = 300;
  #clearTimer = null;
  // Vim lives in a compartment so the "Vim keys" preference (12) turns it on or off
  // in place, keeping the text and the undo history. #vimOn is what it holds now.
  #vim = new Compartment();
  #vimOn = false;

  #extensions() {
    this.#vimOn = this.#actor.snapshot?.context.vimKeys === true;
    return [
      // First: the Vim plugin must see a key before any other keymap does.
      this.#vim.of(vimExtensions(this.#vimOn)),
      // Vim mode hides the native selection (its own theme paints ::selection
      // transparent), so a visual-mode range is only visible through CM6's own layer.
      drawSelection(),
      quoteField,
      discardField,
      refusedField,
      quoteFilter,
      invertedEffects.of(invertDiscard),
      editorTheme,
      history(),
      keymap.of(historyKeymap),
      EditorView.lineWrapping,
      EditorView.decorations.compute([quoteField, discardField], (state) => this.#dimLines(state)),
      EditorView.decorations.compute([quoteField, discardField, "selection"], (state) => this.#marksAndBins(state)),
      EditorView.decorations.compute([quoteField, refusedField], (state) => this.#refusedLines(state)),
      EditorView.updateListener.of(this.#onUpdate),
      EditorView.domEventHandlers({ blur: () => this.#actor.send({ type: "_blurred" }) }),
    ];
  }

  // The quote lines of a state, in document order, each with the note id and its 0-based
  // line: the index from document positions back to fragments (split, the filter).
  #quotesOf(state) {
    const out = [];
    for (let it = state.field(quoteField).iter(); it.value; it.next()) {
      out.push({ id: it.value.spec.attributes["data-id"], line: state.doc.lineAt(it.from).number - 1 });
    }
    return out;
  }

  // Each note's region: its quote line's start, the position just before the next quote
  // line (or the document end), and the text between — so a change can touch one region.
  #regionsOf(state) {
    const quotes = this.#quotesOf(state);
    return quotes.map((q, i) => {
      const from = state.doc.line(q.line + 1).from;
      const to = i + 1 < quotes.length ? state.doc.line(quotes[i + 1].line + 1).from - 1 : state.doc.length;
      return { id: q.id, from, to, text: state.doc.sliceString(from, to) };
    });
  }

  // The line decorations that dim a discarding fragment's lines (its quote line and every
  // comment line under it). Empty when nothing is counting down.
  #dimLines(state) {
    const discarding = state.field(discardField);
    if (discarding.size === 0) return Decoration.none;
    const quotes = [];
    for (let it = state.field(quoteField).iter(); it.value; it.next()) {
      quotes.push({ id: it.value.spec.attributes["data-id"], from: it.from });
    }
    const ranges = [];
    quotes.forEach((q, i) => {
      if (!discarding.has(q.id)) return;
      const first = state.doc.lineAt(q.from).number;
      const endPos = i + 1 < quotes.length ? state.doc.lineAt(quotes[i + 1].from).from - 1 : state.doc.length;
      const last = state.doc.lineAt(endPos).number;
      for (let n = first; n <= last; n++) ranges.push(Decoration.line({ class: "cm-discarding" }).range(state.doc.line(n).from));
    });
    return Decoration.set(ranges, true);
  }

  // The quote highlight over each quote line, and the bin (or Undo) at its end.
  #marksAndBins(state) {
    const discarding = state.field(discardField);
    // The bin discards through the editor (a history step Vim's `u` undoes); Undo cancels
    // the window directly on the actor, as the keyboard `u` does through the history.
    const discard = (id) => this.#view.dispatch({ effects: discardAsked.of(id) });
    const undo = (id) => this.#actor.send({ type: "_undo", id });
    // The highlight whose region holds the caret shows its bin without a hover, so the
    // control is still reachable on a phone, which has no hover (2, forgiveness).
    const active = this.#activeId(state);
    const ranges = [];
    for (let it = state.field(quoteField).iter(); it.value; it.next()) {
      const id = it.value.spec.attributes["data-id"];
      const line = state.doc.lineAt(it.from);
      if (line.to > line.from) ranges.push(Decoration.mark({ class: "cm-quote-text" }).range(line.from, line.to));
      ranges.push(Decoration.widget({ widget: new BinWidget(id, discarding.has(id), id === active, discard, undo), side: 1 }).range(line.to));
    }
    return Decoration.set(ranges, true);
  }

  // The line decoration that flashes a refused quote line (Decision 4). Empty when nothing
  // is refused; the field is cleared after the flash so the decoration goes with it.
  #refusedLines(state) {
    const refused = state.field(refusedField);
    if (refused.size === 0) return Decoration.none;
    const ranges = [];
    for (let it = state.field(quoteField).iter(); it.value; it.next()) {
      if (refused.has(it.value.spec.attributes["data-id"])) ranges.push(Decoration.line({ class: "cm-refused" }).range(it.from));
    }
    return Decoration.set(ranges, true);
  }

  // The note whose region (its quote line through the comment lines under it) holds the
  // main cursor, or null when the caret is nowhere in the document. It reveals that one
  // highlight's bin without a hover, the phone path (2).
  #activeId(state) {
    const head = state.selection.main.head;
    const quotes = [];
    for (let it = state.field(quoteField).iter(); it.value; it.next())
      quotes.push({ id: it.value.spec.attributes["data-id"], from: it.from });
    let found = null;
    for (let i = 0; i < quotes.length; i += 1) {
      const to = i + 1 < quotes.length ? quotes[i + 1].from - 1 : state.doc.length;
      if (head >= quotes[i].from && head <= to) found = quotes[i].id;
    }
    return found;
  }

  // The user edited a comment (never a quote line: the filter forbids it): read each
  // note's body back out of the document and hand the machine the changed ones. The
  // view's own edits carry fromView and are not echoed back as typing.
  #onUpdate = (update) => {
    // The filter's decisions reach the actor here (an update listener, so it never sends
    // during a dispatch): a discard begins the window, an undo — from `u`, which the
    // history turns into an undoAsked effect — cancels it, a refusal starts the flash.
    for (const tr of update.transactions) {
      for (const e of tr.effects) {
        if (e.is(discardAsked)) this.#actor.send({ type: "_discard", id: e.value });
        else if (e.is(undoAsked)) this.#actor.send({ type: "_undo", id: e.value });
        else if (e.is(setRefused) && e.value.size > 0) this.#scheduleClearRefused();
      }
    }
    if (!update.docChanged || update.transactions.some((t) => t.annotation(fromView))) return;
    const doc = update.state.doc.toString();
    this.#shown = doc;
    this.#actor.send({ type: "_typed", bodies: split(doc, this.#quotesOf(update.state)) });
  };

  // Clear the refusal flash after one --duration-slide, the token the flash animates over,
  // so the tint (the only sign under reduced motion) shows for exactly that long.
  #scheduleClearRefused() {
    clearTimeout(this.#clearTimer);
    this.#clearTimer = setTimeout(() => {
      this.#view?.dispatch({ effects: setRefused.of(new Set()), annotations: [fromView.of(true), Transaction.addToHistory.of(false)] });
    }, this.#flashMs);
  }

  firstUpdated() {
    this.#flashMs = toMs(getComputedStyle(this).getPropertyValue("--duration-slide"), 300);
    const parent = this.renderRoot.querySelector(".region");
    this.#view = new EditorView({
      parent,
      // Shadow DOM: CodeMirror reads the selection through the root and style-mod mounts
      // its sheet there, not on the document (7.5), so it must know the shadow root.
      root: this.renderRoot,
      state: EditorState.create({ doc: "", extensions: this.#extensions() }),
    });
    this.#resize.observe(this.#view.scrollDOM);
    this.#sync();
  }

  // Bring the document in line with the facts, touching only what changed so the caret
  // and the regions the user is not editing are left alone. When the user is typing, the
  // facts already match the document (the machine adopted the last _typed), so this is a
  // no-op; it acts on a highlight added, removed, or edited from elsewhere.
  #sync() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || !this.#view) return;
    const fragments = ordered(snapshot.context.fragments);
    const { doc: target, quotes } = compose(fragments);
    const desOrder = fragments.map((f) => f.id);
    const discarding = snapshot.context.discarding;

    const docChanged = target !== this.#shown;
    const discChanged = !sameSet(discarding, this.#discShown);
    if (!docChanged && !discChanged) return;

    const effects = [];
    let changes;
    if (docChanged) {
      const lines = target.split("\n");
      changes = this.#changesTo(fragments, target);
      effects.push(setQuotes.of(quotes.map((q) => ({ id: q.id, line: q.line, quote: lines[q.line] }))));
      // A newly appeared highlight is brought into view without taking the caret.
      const cameIn = desOrder.find((id) => !this.#order.includes(id));
      if (cameIn && this.#shown !== "") this.#pendingScroll = cameIn;
    }
    if (discChanged) effects.push(setDiscarding.of(new Set(discarding)));

    // addToHistory false so a highlight arriving or leaving from elsewhere (a book edit,
    // another device) is never an undo step: `u` moves only through the user's own edits.
    this.#view.dispatch({ changes, effects, annotations: [fromView.of(true), Transaction.addToHistory.of(false)] });
    this.#shown = target;
    this.#order = desOrder;
    this.#discShown = new Set(discarding);
    this.#scrollPending();
  }

  // Centred, because "nearest" leaves a line added below the fold on the bottom edge,
  // measured before its height is known, with the comment line under it hidden.
  #scrollPending() {
    if (!this.#pendingScroll || !this.#view || this.#view.scrollDOM.clientHeight === 0) return;
    const q = this.#quotesOf(this.#view.state).find((x) => x.id === this.#pendingScroll);
    this.#pendingScroll = null;
    if (!q) return;
    // Its first comment line (0-based q.line + 1), where the user writes, so both show.
    const { doc } = this.#view.state;
    const at = doc.line(Math.min(q.line + 2, doc.lines)).from;
    this.#view.dispatch({ effects: EditorView.scrollIntoView(at, { y: "center" }) });
  }

  // The change that turns the current document into the target, as narrow as possible: an
  // empty editor takes the whole document; an unchanged set of notes in the same order has
  // only its edited regions replaced; a note added or removed rebuilds from the first
  // region that differs to the end (so a highlight appended, the common case, touches only
  // the tail and leaves an earlier caret in place).
  #changesTo(fragments, target) {
    const cur = this.#view.state.doc.toString();
    if (cur === "") return { from: 0, to: 0, insert: target };
    const regions = this.#regionsOf(this.#view.state);
    const curOrder = regions.map((r) => r.id);
    const desOrder = fragments.map((f) => f.id);
    if (sameOrder(curOrder, desOrder)) {
      return fragments
        .map((f, i) => ({ region: regions[i], text: compose([f]).doc }))
        .filter(({ region, text }) => region.text !== text)
        .map(({ region, text }) => ({ from: region.from, to: region.to, insert: text }));
    }
    let i = 0;
    while (i < regions.length && i < fragments.length && regions[i].id === fragments[i].id && regions[i].text === compose([fragments[i]]).doc) i += 1;
    const doc = this.#view.state.doc;
    const from = i < regions.length ? regions[i].from : doc.length;
    const tail = fragments.slice(i);
    let insert = tail.length ? compose(tail).doc : "";
    if (i > 0 && from === doc.length && insert) insert = `\n${insert}`;
    return { from, to: doc.length, insert };
  }

  updated() {
    const vimKeys = this.#actor.snapshot?.context.vimKeys === true;
    if (this.#view && vimKeys !== this.#vimOn) {
      this.#vimOn = vimKeys;
      this.#view.dispatch({ effects: this.#vim.reconfigure(vimExtensions(vimKeys)) });
    }
    this.#sync();
  }

  disconnectedCallback() {
    clearTimeout(this.#clearTimer);
    this.#resize.disconnect();
    this.#view?.destroy();
    this.#view = null;
    super.disconnectedCallback();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    const blank = !snapshot || ordered(snapshot.context.fragments).length === 0;
    // .region has no bindings, so Lit never touches CodeMirror's subtree on re-render.
    return html`
      <div class="region" role="textbox" aria-label="Highlights" aria-multiline="true"></div>
      ${blank
        ? html`<div class="empty">
            <span class="mark">${icon("highlighter")}</span>
            <p>Highlight a passage in the book and it appears here.</p>
          </div>`
        : nothing}
    `;
  }
}

const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

customElements.define("highlight-notes", HighlightNotes);
