import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { EditorState, StateField, StateEffect, Prec, Compartment } from "@codemirror/state";
import { EditorView, Decoration, WidgetType, keymap, drawSelection, placeholder } from "@codemirror/view";
import { history, historyKeymap, insertNewline } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";
import { machine, shown, margins, banner, toJudge, reasonLine, canJudge, conflictOn, longDate } from "./machine.js";
import saved from "./events/day.saved.json" with { type: "json" };
import judging from "./events/day.judging.requested.json" with { type: "json" };

// The entry's view: one CodeMirror 6 document holds the day's text, so it is shown once,
// and Jev's answers are drawn against its lines — in a column beside the text on a wide
// stage, as block widgets under each paragraph on a narrow one. Vim sits in a compartment
// that the "Vim keys" preference (12) turns on and off in place. The theme and the Vim
// setup are copied from note-editor, because components never import each other (11.2).

const theme = EditorView.theme({
  "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "var(--leading-normal)" },
  // The caret at column 0 is drawn 0.6px left of the text, so .cm-content needs a
  // sliver of side padding or the scroller's overflow clip eats it.
  ".cm-content": { caretColor: "var(--color-accent)", padding: "0 var(--space-2xs)" },
  ".cm-line": { fontSize: "var(--text-body)", padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
  ".cm-placeholder": { color: "var(--color-mute)" },
});

// The Vim plugin ships its own Prec.highest theme for the block cursor in colours that
// are not tokens; this one outranks it. Unfocused, the cursor is hollowed with an inset
// shadow, because Safari clips the outline the plugin draws.
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

const vimExtensions = (on) => (on ? [vim(), fatCursorTheme] : []);

// What the editable compartment holds: the open day takes typing, an earlier day (or a
// day in conflict) is read only and offers no placeholder.
const editability = (on) => [
  EditorState.readOnly.of(!on),
  EditorView.editable.of(on),
  EditorView.contentAttributes.of({ "aria-label": on ? "Today's entry" : "The entry" }),
  on ? placeholder("What is on your mind? Press Enter to finish a paragraph.") : [],
];

// Space under a paragraph whose answers beside it are taller than the text, so the next
// paragraph starts below them and each paragraph stays level with its own answers. The
// amount is measured geometry in pixels, not a design length, and padding rather than
// margin, because CodeMirror measures a line's box for its height map.
const setPads = StateEffect.define();
const padField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setPads)) continue;
      const ranges = e.value
        .filter(([n]) => n <= tr.state.doc.lines)
        .map(([n, px]) =>
          Decoration.line({ attributes: { style: `padding-bottom: ${px}px`, "data-pad": String(px) } }).range(tr.state.doc.line(n).from),
        );
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The padding now on each line, by line number.
const padsOf = (state) => {
  const pads = new Map();
  for (const it = state.field(padField).iter(); it.value; it.next()) {
    pads.set(state.doc.lineAt(it.from).number, Number(it.value.spec.attributes["data-pad"]));
  }
  return pads;
};

const samePads = (next, now) => next.length === now.size && next.every(([n, px]) => Math.abs((now.get(n) ?? -99) - px) <= 1);

// A paragraph's answers drawn under it on a narrow stage: a block widget after its last
// line, so it is never part of the text. `key` is what it shows, so an unchanged block
// keeps its DOM.
class AnswersWidget extends WidgetType {
  constructor(key, state, draw) {
    super();
    this.key = key;
    this.state = state;
    this.draw = draw;
  }

  eq(other) {
    return other.key === this.key;
  }

  toDOM() {
    const div = document.createElement("div");
    div.contentEditable = "false";
    this.updateDOM(div);
    return div;
  }

  updateDOM(dom) {
    dom.className = `margin under ${this.state}`;
    this.draw(dom);
    return true;
  }
}

const setUnder = StateEffect.define();
const underField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setUnder)) continue;
      const ranges = e.value
        .filter((w) => w.line <= tr.state.doc.lines)
        .map((w) => Decoration.widget({ widget: new AnswersWidget(w.key, w.state, w.draw), block: true, side: 1 }).range(tr.state.doc.line(w.line).to));
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, now: () => Date.now() },
      events: { "day.saved": saved, "day.judging.requested": judging },
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

// The next local midnight after `now`, when the open day's banner appears.
const midnightAfter = (now) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

class JournalEntry extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // in the writing box.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      container-type: inline-size;
    }
    .page {
      box-sizing: border-box;
      padding: var(--space-md) var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    header {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    h2 {
      margin: 0;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .status {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .status b {
      font-weight: var(--weight-semibold);
      color: var(--color-success);
    }
    .status b.closed {
      color: var(--color-body-mid);
    }
    .banner {
      margin: 0;
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-sm);
      background: var(--color-accent-subtle);
      color: var(--color-ink);
      font-size: var(--text-sm);
    }
    .line {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .judge {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-sm) var(--space-md);
    }
    /* The open day's text sits in a box like a text field; an earlier day's is plain. */
    .region {
      min-width: 0;
      line-height: var(--leading-normal);
    }
    .region.open {
      box-sizing: border-box;
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-sm);
    }
    .region.open:focus-within {
      box-shadow: var(--focus-ring);
    }
    /* Room for a few lines before anything is written, so the box reads as a place to type. */
    .region.open .cm-content {
      min-height: calc(var(--text-body) * var(--leading-normal) * 5);
    }
    button {
      appearance: none;
      font: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-sm);
      border: var(--border-width) solid var(--color-border-strong);
      background: var(--color-canvas);
      color: var(--color-ink);
    }
    button:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: default;
      color: var(--color-mute);
    }
    button.dark {
      padding: var(--space-xs) var(--space-md);
      border-color: var(--color-ink);
      background: var(--color-ink);
      color: var(--color-canvas);
    }
    button.dark:hover:not(:disabled) {
      background: var(--color-ink);
    }
    button.dark:disabled {
      border-color: var(--color-border);
      background: var(--color-surface-active);
      color: var(--color-mute);
    }
    /* Both copies of a day saved on two devices, side by side, each with the button that
       keeps it. */
    .conflict {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-warning);
      border-radius: var(--radius-md);
      background: var(--color-warning-subtle);
    }
    .conflict p {
      margin: 0;
      color: var(--color-ink);
      font-size: var(--text-sm);
    }
    .copies {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-sm);
    }
    .copy {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      min-width: 0;
    }
    .copy h3 {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
    }
    .copy pre {
      margin: 0;
      flex: 1;
      padding: var(--space-sm);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      color: var(--color-ink);
      font: inherit;
      font-size: var(--text-sm);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .copy button {
      align-self: flex-start;
    }
    /* The text with its margin column beside it. Where the margin goes is read by the
       view from --margin-place, so the breakpoint lives here, once. */
    /* The text takes what is left. The answers keep the mockup's width on a wide stage
       and give way on a narrow one, so the text stays the larger column there too. */
    .sheet {
      --margin-place: beside;
      display: grid;
      grid-template-columns: minmax(0, 1fr) clamp(calc(var(--space-2xl) * 2.5), 35%, calc(var(--space-2xl) * 3.5));
      gap: var(--space-lg);
      align-items: start;
    }
    /* Each block is placed level with its paragraph's first line by the view. */
    .margins {
      position: relative;
      min-width: 0;
    }
    .margins > .margin {
      position: absolute;
      inset-inline: 0;
      top: 0;
      box-sizing: border-box;
      /* The least space before the next paragraph's answers; part of the block's
         measured height, so the text below is pushed down by it too. */
      padding-bottom: var(--space-md);
    }
    /* Under a paragraph, on a narrow stage: set apart from the next paragraph by a rule. */
    .margin.under {
      padding: var(--space-xs) 0 var(--space-sm);
      margin-bottom: var(--space-sm);
      border-bottom: var(--border-width) dashed var(--color-border);
      cursor: default;
    }
    .margin {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      min-width: 0;
      font-size: var(--text-caption);
    }
    .project {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .project > .name {
      font-weight: var(--weight-semibold);
      color: var(--color-accent-active);
    }
    .detector {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding-left: var(--space-sm);
      border-left: calc(var(--border-width) * 2) solid var(--color-border-strong);
    }
    .detector > .name {
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
    }
    .pick {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2xs) var(--space-sm);
    }
    .pick b {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .pick.unsure b {
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
    }
    .sure {
      color: var(--color-body-mid);
      font-variant-numeric: tabular-nums;
    }
    .yn {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-sm);
      color: var(--color-body);
    }
    .pct {
      font-weight: var(--weight-semibold);
      font-variant-numeric: tabular-nums;
      color: var(--color-body);
    }
    .pct.yes {
      color: var(--color-success);
    }
    .pct.no {
      color: var(--color-danger);
    }
    .earlier {
      align-self: flex-start;
      padding: 0 var(--space-xs);
      border-radius: var(--radius-full);
      background: var(--color-surface-active);
      color: var(--color-body);
      cursor: help;
    }
    .note {
      color: var(--color-body-mid);
      font-style: italic;
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* Below about 30rem the paragraph would be squeezed beside its margin: a phone, or a
       desk with both docks open on a small window. */
    @container (width < 30rem) {
      .page {
        padding: var(--space-md);
      }
      .sheet {
        --margin-place: under;
        grid-template-columns: minmax(0, 1fr);
      }
      .margins {
        display: none;
      }
      .copies {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `;

  #actor = new ActorController(this);
  #timer = null;
  #view = null;
  // The text last written into or read out of the editor, so an echo of the user's own
  // typing never rewrites the document and moves the caret.
  #shown = "";
  #vim = new Compartment();
  #vimOn = false;
  #editable = new Compartment();
  #editableOn = false;
  // Whether the answers go under each paragraph (a narrow stage) or beside it.
  #under = false;
  // The rows the last render drew, and the key of what the widgets under them show.
  #rows = [];
  #underKey = "";
  #resize = new ResizeObserver(() => this.#arrange());
  #measureKey = {};

  #send(event) {
    this.#actor.send(event);
  }

  connectedCallback() {
    super.connectedCallback();
    this.#resize.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
    this.#resize.disconnect();
    this.#view?.destroy();
    this.#view = null;
  }

  // dock-desk's Ctrl+h/j/k/l and list-then-item focus a panel by its host: land in the
  // text when it can be typed in.
  focus(options) {
    if (this.#view && this.#editableOn) this.#view.focus();
    else super.focus(options);
  }

  #extensions(editable, vimOn) {
    return [
      // First: the Vim plugin must see a key before any other keymap does.
      this.#vim.of(vimExtensions(vimOn)),
      // Vim hides the native selection, so its visual-mode range shows only through
      // CodeMirror's own selection layer.
      drawSelection(),
      this.#editable.of(editability(editable)),
      theme,
      padField,
      underField,
      history(),
      keymap.of(historyKeymap),
      // Left to the browser, WebKit's own Enter drops repeated empty lines at the end.
      keymap.of([{ key: "Enter", run: insertNewline }]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const text = update.state.doc.toString();
          if (text !== this.#shown) {
            this.#shown = text;
            this.#send({ type: "_edit", text });
          }
        }
        if (update.docChanged || update.geometryChanged || update.viewportChanged) this.#place();
      }),
      // WebKit keeps the document's selection inside a blurred editor, and a later key
      // nobody cancels is typed there; dropping it on blur leaves nothing to type into.
      EditorView.domEventHandlers({
        blur: () => {
          document.getSelection()?.removeAllRanges();
          this.#send({ type: "_blur" });
        },
      }),
    ];
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    const region = this.renderRoot.querySelector(".region");
    if (!snapshot || !region) return;
    const { text, editable } = this.#content;
    const { vimKeys } = snapshot.context;
    if (!this.#view || this.#view.dom.parentNode !== region) {
      this.#view?.destroy();
      this.#shown = text;
      this.#vimOn = vimKeys;
      this.#editableOn = editable;
      this.#underKey = "";
      this.#view = new EditorView({
        parent: region,
        // Shadow DOM: CodeMirror reads the selection through the root and mounts its
        // stylesheet there (7.5), so it must know the shadow root.
        root: this.renderRoot,
        state: EditorState.create({ doc: text, extensions: this.#extensions(editable, vimKeys) }),
      });
    }
    const effects = [];
    if (vimKeys !== this.#vimOn) {
      this.#vimOn = vimKeys;
      effects.push(this.#vim.reconfigure(vimExtensions(vimKeys)));
    }
    if (editable !== this.#editableOn) {
      this.#editableOn = editable;
      effects.push(this.#editable.reconfigure(editability(editable)));
    }
    const changes = text === this.#view.state.doc.toString() ? undefined : { from: 0, to: this.#view.state.doc.length, insert: text };
    this.#shown = text;
    if (changes || effects.length) this.#view.dispatch({ changes, effects });
    this.#arrange();
  }

  // Beside or under, as the stylesheet says for the stage's width; then draw the answers
  // that way.
  #arrange() {
    const sheet = this.renderRoot.querySelector(".sheet");
    if (!sheet || !this.#view) return;
    const under = getComputedStyle(sheet).getPropertyValue("--margin-place").trim() === "under";
    if (under !== this.#under) {
      this.#under = under;
      this.requestUpdate();
    }
    const rows = under ? this.#rows : [];
    const key = JSON.stringify(rows);
    if (key !== this.#underKey) {
      this.#underKey = key;
      const widgets = rows.map((r) => ({ line: r.line, state: r.state, key: JSON.stringify(r), draw: (div) => render(this.#margin(r), div) }));
      this.#view.dispatch({ effects: setUnder.of(widgets) });
    }
    this.#place();
  }

  // Puts each answers block level with its paragraph's first line, from CodeMirror's own
  // line geometry, and pads a paragraph whose answers are taller than the room before the
  // next one, so no two blocks overlap and each stays beside its text.
  #place() {
    const view = this.#view;
    if (!view) return;
    if (this.#under) {
      if (padsOf(view.state).size) queueMicrotask(() => this.#view?.dispatch({ effects: setPads.of([]) }));
      return;
    }
    view.requestMeasure({
      key: this.#measureKey,
      read: (v) => {
        const column = this.renderRoot.querySelector(".margins");
        if (!column) return null;
        const blocks = [...column.querySelectorAll(":scope > .margin")]
          .map((el) => ({ el, n: Number(el.dataset.line), height: el.offsetHeight }))
          .filter((b) => b.n <= v.state.doc.lines)
          .map((b) => ({ ...b, top: v.lineBlockAt(v.state.doc.line(b.n).from).top }));
        const end = v.lineBlockAt(v.state.doc.length).bottom;
        return { column, blocks, end, offset: v.documentTop - column.getBoundingClientRect().top, pads: padsOf(v.state) };
      },
      write: (m) => {
        if (!m) return;
        const next = [];
        m.blocks.forEach((b, i) => {
          b.el.style.top = `${b.top + m.offset}px`;
          // The last paragraph's room runs to the end of the text, so the box holding the
          // text also holds its answers.
          const after = m.blocks[i + 1];
          const room = (after ? after.top : m.end) - b.top - (m.pads.get(b.n) ?? 0);
          const pad = Math.ceil(b.height - room);
          if (pad > 0) next.push([b.n, pad]);
        });
        const last = m.blocks.at(-1);
        m.column.style.minHeight = last ? `${last.top + m.offset + last.height}px` : "";
        // A transaction cannot start inside CodeMirror's measure cycle.
        if (!samePads(next, m.pads)) queueMicrotask(() => this.#view?.dispatch({ effects: setPads.of(next) }));
      },
    });
  }

  // What the editor shows: the text being typed on the open day, else the day's text;
  // typing only on the open day and not while two copies wait to be settled.
  get #content() {
    const { context } = this.#actor.snapshot;
    const { day, editable } = shown(context.picture, context.selected, context.fresh, Date.now());
    const conflict = conflictOn(context.conflict, day, editable);
    return { text: editable && context.draft ? context.draft.text : day.text, editable: editable && !conflict };
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty page">The journal is unavailable.</p>`;
    const { context } = snapshot;
    const { picture, selected, fresh, draft, editing, usedUp } = context;
    const now = Date.now();
    // Nobody acts at midnight, so a timer redraws the page when the banner is due.
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.requestUpdate(), midnightAfter(now) - now + 1000);
    const { day, editable } = shown(picture, selected, fresh, now);
    const text = editable && draft ? draft.text : day.text;
    const rows = margins(text, editable && editing, day, picture);
    this.#rows = rows;
    const conflict = conflictOn(context.conflict, day, editable);
    const late = banner(day, editable, now);
    const why = reasonLine(picture, usedUp);
    const missing = toJudge(day, editable);
    return html`
      <div class="scroll">
        <div class="page">
          <header>
            <h2>${longDate(day.day)}</h2>
            <p class="status">
              ${editable
                ? html`<b>Open</b> · closes at midnight, or an hour after your last edit`
                : html`<b class="closed">Read only</b>`}
            </p>
          </header>
          ${late ? html`<p class="banner" role="status">${late}</p>` : nothing}
          ${conflict ? this.#conflict(conflict) : nothing}
          ${why ? html`<p class="line reason">${why}</p>` : nothing}
          ${missing
            ? html`<div class="judge">
                <button type="button" class="dark judge-day" ?disabled=${!canJudge(picture)} @click=${() => this.#send({ type: "_judge" })}>
                  Judge this day · ${missing} ¶
                </button>
                <span class="line">${plural(missing, "paragraph is", "paragraphs are")} not read by every detector that is on now.</span>
              </div>`
            : nothing}
          <div class="sheet">
            <div class="region ${editable && !conflict ? "open" : ""}"></div>
            <div class="margins">
              ${this.#under ? nothing : rows.map((r) => html`<div class="margin ${r.state}" data-line=${r.line}>${this.#margin(r)}</div>`)}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Both copies, each kept in one step. A closed day can no longer be saved, so only the
  // other copy can stay, and the user's own is shown to copy from.
  #conflict(c) {
    return html`
      <section class="conflict" aria-label="Two copies of this entry">
        <p>
          ${c.keepable
            ? "This entry was also changed on another device. Keep one copy."
            : "This entry was also changed on another device, and it has closed, so the other copy is kept. Yours is here to copy from."}
        </p>
        <div class="copies">
          <div class="copy mine">
            <h3>Yours</h3>
            <pre>${c.mine}</pre>
            ${c.keepable ? html`<button type="button" class="keep-mine" @click=${() => this.#send({ type: "_keepMine" })}>Keep this copy</button>` : nothing}
          </div>
          <div class="copy theirs">
            <h3>The other device's</h3>
            <pre>${c.theirs}</pre>
            <button type="button" class="keep-theirs" @click=${() => this.#send({ type: "_keepTheirs" })}>
              ${c.keepable ? "Keep this copy" : "Done"}
            </button>
          </div>
        </div>
      </section>
    `;
  }

  #margin(r) {
    if (r.state === "unfinished") return html`<span class="note">Not finished yet</span>`;
    if (r.state === "waiting") return html`<span class="note" role="status">Judging…</span>`;
    return r.projects.map(
      (p) => html`<div class="project">
        ${p.name ? html`<span class="name">${p.name}</span>` : nothing}
        ${p.detectors.map(
          (d) => html`<div class="detector">
            <span class="name">${d.name}</span>
            ${d.entries.map((e) => this.#entry(e))}
          </div>`,
        )}
      </div>`,
    );
  }

  #entry(e) {
    const earlier = e.earlier === null ? nothing : html`<span class="earlier" title=${e.earlier}>earlier wording</span>`;
    if (e.kind === "pick")
      return html`<span class="pick ${e.sure === "unsure" ? "unsure" : ""}"><b>${e.pick}</b> <span class="sure">${e.sure}</span></span>${earlier}`;
    return html`<span class="yn"><span>${e.text}</span><span class="pct ${e.tone}">${e.pct}%</span></span>${earlier}`;
  }
}

customElements.define("journal-entry", JournalEntry);
