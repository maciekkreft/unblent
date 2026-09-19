import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { EditorState, StateField, StateEffect, Annotation } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, drawSelection } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { machine, ordered, compose, split } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import discarded from "./events/note.discarded.json" with { type: "json" };

// The page in the right dock (8, kind 4; Decision 2): the highlights of the book on the
// stage as one continuous CodeMirror document. Per highlight a quote line that cannot be
// edited and, under it, the comment — the note's body. Each highlight is one ordinary
// note (Decision 1); this view owns only the CodeMirror document and reflects the facts
// the machine holds. It has no Vim yet (staying-open constraint), so the quote lines are
// held fixed by a transaction filter alone; a later vim() is one extension.

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
// note-editor-cm6): only the user's edits become _typed.
const fromView = Annotation.define();

// Rebuild the whole index of quote lines from the fragments (a load), the setAllLevels
// idiom of note-editor-cm6; and set which fragments are counting down to a discard.
const setQuotes = StateEffect.define();
const setDiscarding = StateEffect.define();

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

// The quote lines cannot be edited (Decision 2). A user transaction is rejected when,
// after it, any quote no longer sits at the start of a line whose text is still its
// quote, or a quote line is directly followed by another quote line or the end of the
// document (every fragment keeps at least one comment line). The view's own edits carry
// fromView and are never filtered.
const quoteFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(fromView)) return tr;
  const doc = tr.newDoc;
  const marks = [];
  for (let it = tr.startState.field(quoteField).iter(); it.value; it.next()) {
    marks.push({ pos: tr.changes.mapPos(it.from, 1), quote: it.value.spec.quote });
  }
  const starts = new Set(marks.map((m) => m.pos));
  for (const m of marks) {
    const line = doc.lineAt(m.pos);
    if (line.from !== m.pos || line.text !== m.quote) return []; // the quote line moved or was edited
    if (line.number >= doc.lines) return []; // it became the last line: its comment is gone
    if (starts.has(doc.line(line.number + 1).from)) return []; // two quote lines fell adjacent
  }
  return tr;
});

// The structural theme, keyed to tokens like note-editor-cm6's; line spacing is padding,
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

// The bin at the end of a quote line: a muted trash button that begins the undo window,
// or, during that window, an Undo button and the draining bar. The DOM is recreated when
// the discarding state flips (eq), so the bar's animation starts fresh each time, the
// note-list idiom. A phone has no hover, so it is always visible.
class BinWidget extends WidgetType {
  constructor(id, discarding, active, send) {
    super();
    this.id = id;
    this.discarding = discarding;
    this.active = active;
    this.send = send;
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
      undo.addEventListener("click", () => this.send({ type: "_undo", id: this.id }));
      wrap.append(undo, Object.assign(document.createElement("span"), { className: "cm-bar" }));
    } else {
      const bin = document.createElement("button");
      bin.type = "button";
      bin.className = this.active ? "cm-bin cm-active" : "cm-bin";
      bin.setAttribute("aria-label", "Remove highlight");
      bin.addEventListener("mousedown", (e) => e.preventDefault());
      bin.addEventListener("click", () => this.send({ type: "_discard", id: this.id }));
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

  #extensions() {
    return [
      quoteField,
      discardField,
      quoteFilter,
      editorTheme,
      history(),
      keymap.of(historyKeymap),
      drawSelection(),
      EditorView.lineWrapping,
      EditorView.decorations.compute([quoteField, discardField], (state) => this.#dimLines(state)),
      EditorView.decorations.compute([quoteField, discardField, "selection"], (state) => this.#marksAndBins(state)),
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
    const send = (event) => this.#actor.send(event);
    // The highlight whose region holds the caret shows its bin without a hover, so the
    // control is still reachable on a phone, which has no hover (2, forgiveness).
    const active = this.#activeId(state);
    const ranges = [];
    for (let it = state.field(quoteField).iter(); it.value; it.next()) {
      const id = it.value.spec.attributes["data-id"];
      const line = state.doc.lineAt(it.from);
      if (line.to > line.from) ranges.push(Decoration.mark({ class: "cm-quote-text" }).range(line.from, line.to));
      ranges.push(Decoration.widget({ widget: new BinWidget(id, discarding.has(id), id === active, send), side: 1 }).range(line.to));
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
    if (!update.docChanged || update.transactions.some((t) => t.annotation(fromView))) return;
    const doc = update.state.doc.toString();
    this.#shown = doc;
    this.#actor.send({ type: "_typed", bodies: split(doc, this.#quotesOf(update.state)) });
  };

  firstUpdated() {
    const parent = this.renderRoot.querySelector(".region");
    this.#view = new EditorView({
      parent,
      // Shadow DOM: CodeMirror reads the selection through the root and style-mod mounts
      // its sheet there, not on the document (7.5), so it must know the shadow root.
      root: this.renderRoot,
      state: EditorState.create({ doc: "", extensions: this.#extensions() }),
    });
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
      if (cameIn && this.#shown !== "") {
        const q = quotes.find((x) => x.id === cameIn);
        effects.push(EditorView.scrollIntoView(lineStart(target, q.line)));
      }
    }
    if (discChanged) effects.push(setDiscarding.of(new Set(discarding)));

    this.#view.dispatch({ changes, effects, annotations: [fromView.of(true)] });
    this.#shown = target;
    this.#order = desOrder;
    this.#discShown = new Set(discarding);
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
    this.#sync();
  }

  disconnectedCallback() {
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

// The character offset a 0-based line starts at, in a plain string (for scrollIntoView
// against the document just dispatched).
const lineStart = (text, line) => {
  let at = 0;
  for (let n = 0; n < line; n += 1) at = text.indexOf("\n", at) + 1;
  return at;
};

const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

customElements.define("highlight-notes", HighlightNotes);
