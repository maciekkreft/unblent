import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Prec, Annotation, StateField, StateEffect } from "@codemirror/state";
import { EditorView, placeholder, Decoration, WidgetType } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, boxMarks, cardWarnings, sayMarks, statusOf, writable } from "./machine.js";
import saved from "./events/choice-point.saved.json" with { type: "json" };

// The view sits in journal-entry's slot, under the day's text inside its scrolling page
// (the product page nests it), so it scrolls with the day it is about.

// The four boxes are CodeMirror editors, one each, built on the editor kit (10), so they
// take Vim's keys when the "Vim keys" preference (12) is on and make paragraphs on Enter.
// Each line is one item Jev checks, and a blank line is never one (linesOf), so a gap
// between items costs nothing.

// The box grows with what is written, from `lines` lines; its frame is drawn around it
// by .box, so the theme draws none. Only what differs from the kit's theme, which yields.
const boxTheme = (lines) =>
  EditorView.theme({
    "&": { flex: "1" },
    ".cm-content": {
      padding: "var(--space-xs) var(--space-sm)",
      minHeight: `calc(var(--text-sm) * var(--leading-normal) * ${lines})`,
    },
    ".cm-line": { fontSize: "var(--text-sm)" },
    // A checked line keeps room at its right end for its marks, which stand there.
    ".cm-line.cm-checked": { position: "relative" },
    ...Object.fromEntries(
      [1, 2, 3, 4].map((n) => [`.cm-line.cm-checked-${n}`, { paddingRight: `calc((var(--text-sm) + var(--space-xs) * 2 + var(--space-2xs)) * ${n})` }]),
    ),
  });
const shortTheme = boxTheme(2);
// The two moves stand beside the V, so they start as tall as it is.
const tallTheme = boxTheme(4);

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

// The lines the user moved on from in one editor update, by text: the line the cursor was
// on, followed through the edit, when the cursor now stands on another line. An edit that
// adds lines (Enter, a paste) also finishes every line it put between the two, so a pasted
// block is checked whole; the line the cursor is on is never finished while it is typed.
function leftLines(update) {
  const before = update.startState;
  const after = update.state;
  const from = update.changes.mapPos(before.doc.lineAt(before.selection.main.head).from, -1);
  const was = after.doc.lineAt(from).number;
  const now = after.doc.lineAt(after.selection.main.head).number;
  if (was === now) return [];
  const [lo, hi] = update.docChanged ? [Math.min(was, now), Math.max(was, now)] : [was, was];
  const out = [];
  for (let n = lo; n <= hi; n += 1) if (n !== now) out.push(after.doc.line(n).text);
  return out;
}

// Jev's marks for a box, by line text, as the machine decided them (boxMarks); a line
// whose text matches none has no mark.
const setMarks = StateEffect.define();
const marksField = StateField.define({
  create: () => new Map(),
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setMarks) ? e.value : v), value),
});

// The names are literals so the icon check sees each one (11.2).
const MARK_ICONS = {
  check: () => icon("check"),
  warning: () => icon("warning"),
  "person-simple-walk": () => icon("person-simple-walk"),
  brain: () => icon("brain"),
};

// A box on a day that cannot be written is shown, not edited (writable); it takes no
// focus, so the sheet's own keydown folds it on Escape.
const readOnly = (spec) => (spec.read ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [placeholder(spec.hint)]);

// The marks at a line's end. They are a widget, not text: the cursor, Vim and the line's
// height pass them by, and CodeMirror ignores their events. The pointer over them, or a
// tap, says which line the status line is to tell about.

class MarksWidget extends WidgetType {
  constructor(marks, text, point) {
    super();
    this.marks = marks;
    this.text = text;
    this.point = point;
    this.key = JSON.stringify(marks);
  }

  eq(other) {
    return other.key === this.key && other.text === this.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "marks";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", sayMarks(this.marks));
    render(
      this.marks.map((m) =>
        m.pending ? html`<span class="mark pending" title=${sayMarks([m])}><i></i></span>` : html`<span class="mark ${m.tone}" title=${sayMarks([m])} style=${`opacity: ${m.sure}`}>${MARK_ICONS[m.icon]?.()}</span>`,
      ),
      span,
    );
    span.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch") return;
      span.dataset.over = "";
      this.point("hover", this.text);
    });
    span.addEventListener("pointerleave", () => {
      delete span.dataset.over;
      this.point("hover", null);
    });
    // Pressing a mark keeps the cursor and the keyboard where they are.
    span.addEventListener("mousedown", (e) => e.preventDefault());
    span.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.point("tap", this.text);
    });
    return span;
  }

  destroy(dom) {
    if ("over" in dom.dataset) this.point("hover", null);
  }

  ignoreEvent() {
    return true;
  }
}

const marksDecorations = (point) =>
  EditorView.decorations.compute([marksField, "doc"], (state) => {
    const marks = state.field(marksField);
    const ranges = [];
    if (!marks.size) return Decoration.none;
    for (let i = 1; i <= state.doc.lines; i += 1) {
      const line = state.doc.line(i);
      const these = marks.get(line.text);
      if (!these?.length) continue;
      ranges.push(Decoration.line({ class: `cm-checked cm-checked-${Math.min(these.length, 4)}` }).range(line.from));
      ranges.push(Decoration.widget({ widget: new MarksWidget(these, line.text, point), side: 1 }).range(line.to));
    }
    return Decoration.set(ranges);
  });

// A hollow arrow from (bx, by) to its tip at (tx, ty), as polygon points: a shaft of half
// width w and a head of half width hw and length hl.
function arrow(bx, by, tx, ty, w, hw, hl) {
  const dx = tx - bx;
  const dy = ty - by;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const hx = tx - ux * hl;
  const hy = ty - uy * hl;
  const p = (x, y, k) => [x + nx * k, y + ny * k];
  return [p(bx, by, -w), p(hx, hy, -w), p(hx, hy, -hw), [tx, ty], p(hx, hy, hw), p(hx, hy, w), p(bx, by, w)]
    .map((q) => q.map((n) => n.toFixed(1)).join(","))
    .join(" ");
}

// The V of the choice point: two moves leaving one moment, away to the left and towards
// to the right, each drawn under the box it names so the drawing maps onto the boxes.
const AWAY = arrow(62, 104, 28, 20, 6, 12, 14);
const TOWARDS = arrow(78, 104, 112, 20, 6, 12, 14);
const vee = html`<svg viewBox="-14 0 168 130" aria-hidden="true">
  <text x="28" y="11" text-anchor="middle">AWAY</text>
  <text x="112" y="11" text-anchor="middle">TOWARDS</text>
  <polygon class="away" points=${AWAY}></polygon>
  <polygon class="towards" points=${TOWARDS}></polygon>
  <circle cx="70" cy="112" r="15"></circle>
</svg>`;

const BOXES = {
  away: { label: "Away · hooked", hint: "What did I do, or want to do, when hooked?" },
  towards: { label: "Towards · unhooked", hint: "What would I do if I were unhooked?" },
  situation: { label: "Situation", hint: "Where was I, what was happening?" },
  thoughts: { label: "Thoughts & feelings", hint: "What showed up inside?" },
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, now: () => Date.now() },
      events: { "choice-point.saved": saved },
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

class ChoicePointCards extends LitElement {
  static styles = css`
    :host {
      display: block;
      container-type: inline-size;
      color: var(--color-body);
    }
    /* Focusable only by script and by a press, so a press on the section's own text lands
       here rather than being handed to the journal's text by its delegated focus. */
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding-top: var(--space-md);
      border-top: var(--border-width) solid var(--color-border);
    }
    section:focus {
      outline: none;
    }
    h3 {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-body-mid);
    }
    button {
      appearance: none;
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      color: var(--color-ink);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border-strong);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: default;
      color: var(--color-mute);
    }
    /* The New choice point row reads like the New note and New chat rows: a muted line
       with a plus, the whole width, so it is one more row of the list rather than a
       control beside its heading. */
    .new {
      display: flex;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: var(--space-xs) var(--space-sm);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-body-mid);
    }
    .new:hover {
      background: var(--color-surface-hover);
    }
    .new .mark {
      display: inline-flex;
      margin-right: var(--space-xs);
    }
    .new .mark svg {
      display: block;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .card {
      display: grid;
      gap: var(--space-xs);
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: var(--space-sm) var(--space-md);
      border-color: var(--color-border);
      border-radius: var(--radius-md);
      color: var(--color-body);
    }
    .card:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
    }
    .sit {
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .sit.none {
      color: var(--color-body-mid);
    }
    .sit,
    .move span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .move {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: baseline;
      gap: var(--space-sm);
    }
    /* The card's warning joins a row as a third column only when it is there, so a card
       without one is laid out as before. */
    .move,
    .flagged {
      grid-auto-flow: column;
    }
    .flagged {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-items: baseline;
      gap: var(--space-sm);
    }
    .flag {
      align-self: center;
      display: flex;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    .move b,
    .field > span {
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-body-mid);
    }
    .away b,
    .field.away > span {
      color: var(--color-warning);
    }
    .towards b,
    .field.towards > span {
      color: var(--color-success);
    }
    .sheet {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
    }
    /* The V stands between the two moves it draws, the situation and the feelings under
       all three. */
    .grid {
      display: grid;
      gap: var(--space-sm) var(--space-md);
      grid-template-columns: minmax(0, 1fr) calc(var(--space-2xl) * 2) minmax(0, 1fr);
      grid-template-areas: "away v towards" "bottom bottom bottom";
      align-items: center;
    }
    .v {
      grid-area: v;
      color: var(--color-ink);
    }
    .v svg {
      display: block;
      width: 100%;
      height: auto;
    }
    .v text {
      font-family: var(--font-sans);
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.04em;
      fill: currentColor;
    }
    .v polygon,
    .v circle {
      stroke: currentColor;
      stroke-width: 1.1;
      stroke-linejoin: round;
    }
    .v polygon.away {
      fill: var(--color-warning-subtle);
    }
    .v polygon.towards {
      fill: var(--color-success-subtle);
    }
    .v circle {
      fill: var(--color-canvas);
    }
    /* The two moves reach down to the same line whatever their labels wrap to. */
    .field.away {
      grid-area: away;
      align-self: stretch;
    }
    .field.towards {
      grid-area: towards;
      align-self: stretch;
    }
    .field.away .box,
    .field.towards .box {
      flex: 1;
    }
    .bottom {
      grid-area: bottom;
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      min-width: 0;
    }
    /* CodeMirror owns everything inside .box; the frame is drawn here, around it. */
    .box {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      cursor: text;
    }
    .box:focus-within {
      box-shadow: var(--focus-ring);
    }
    /* An earlier day's sheet is read, not written: no frame or text cursor invites typing. */
    .sheet.read .box {
      border-color: transparent;
      cursor: default;
    }
    .away .box:focus-within {
      background: var(--color-warning-subtle);
    }
    .towards .box:focus-within {
      background: var(--color-success-subtle);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    /* Jev's marks at a checked line's right end, as tall as the line, so a box keeps its
       height. */
    .marks {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;
      gap: var(--space-2xs);
      user-select: none;
      -webkit-user-select: none;
    }
    .mark {
      display: inline-grid;
      place-items: center;
      width: calc(var(--text-sm) + var(--space-xs) * 2);
      height: calc(var(--text-sm) * var(--leading-normal));
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      cursor: pointer;
    }
    .mark svg {
      display: block;
    }
    .mark:hover {
      background: var(--color-surface-hover);
    }
    .mark.right {
      color: var(--color-success);
      background: var(--color-success-subtle);
    }
    .mark.wrong {
      color: var(--color-danger);
      background: var(--color-danger-subtle);
    }
    .mark.pending {
      cursor: default;
      background: none;
    }
    .mark.pending i {
      width: calc(var(--space-xs) * 1.5);
      height: calc(var(--space-xs) * 1.5);
      border-radius: var(--radius-full);
      background: var(--color-mute);
      animation: pulse calc(var(--duration-slide) * 4) ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.3;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .mark.pending i {
        animation: none;
      }
    }
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .status {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .buttons {
      display: flex;
      gap: var(--space-sm);
    }
    .buttons button {
      padding: var(--space-xs) var(--space-md);
      border-radius: var(--radius-md);
    }
    .buttons button:hover {
      background: var(--color-surface-hover);
    }
    .buttons .done {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: var(--color-accent-text);
    }
    .buttons .done:hover {
      background: var(--color-accent-hover);
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* A narrow page (a phone, or a narrow stage): the V stands above the boxes. */
    @container (width < 30rem) {
      .grid {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas: "v" "away" "towards" "bottom";
      }
      .v {
        justify-self: center;
        width: calc(var(--space-2xl) * 2 + var(--space-lg));
      }
    }
  `;

  #actor = new ActorController(this);

  // Where the keyboard goes once the next render lands: a box of the open sheet, a card
  // folded from it, or the New choice point row. Kept here because the elements exist only after render.
  #focusNext = null;

  // The editors of the open sheet by key ("<id>:<field>"), each with the region it is
  // drawn in; and what the last render asked of each box.
  #boxes = new Map();
  #wanted = new Map();

  updated() {
    this.#syncBoxes();
    if (!this.#focusNext) return;
    const target = this.renderRoot.querySelector(this.#focusNext) ?? this.renderRoot.querySelector(".new");
    this.#focusNext = null;
    const box = [...this.#boxes.values()].find((b) => b.region === target);
    if (box) this.#focusBox(box);
    else target?.focus();
  }

  // A box opened from the New row or a card takes the keyboard in Vim's insert mode when Vim
  // keys is on, so the first key typed is text.
  #focusBox(box) {
    box.view.focus();
    const cm = box.vimOn ? getCM(box.view) : null;
    if (cm && cm.state?.vim?.insertMode !== true) Vim.handleKey(cm, "i", "user");
  }

  // Escape (12): with Vim on, an Escape in insert or visual mode is Vim's, back to normal
  // mode; any other folds the sheet like Done. A keydown handler at Prec.highest, not a
  // keymap, because the Vim plugin's handler runs before every keymap and would take it.
  // The key never reaches what is around the box, so nothing there acts on it too.
  #keys(id, field) {
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (event.key !== "Escape" || event.isComposing) return false;
          event.stopPropagation();
          const box = this.#boxes.get(`${id}:${field}`);
          const mode = box?.vimOn ? getCM(view)?.state?.vim : null;
          if (mode?.insertMode || mode?.visualMode) return false;
          event.preventDefault();
          this.#done(id);
          return true;
        },
      }),
    );
  }

  #extensions(key, spec, vimOn) {
    const { id, field } = spec;
    return [
      this.#keys(id, field),
      ...baseExtensions({ vim: vimOn }),
      paragraphs(),
      field === "away" || field === "towards" ? tallTheme : shortTheme,
      this.#boxes.get(key).read.of(readOnly(spec)),
      EditorView.contentAttributes.of({ "aria-label": spec.label }),
      marksField.init(() => spec.marks),
      marksDecorations((source, text) => this.#actor.send({ type: "_point", source, id, field: text == null ? null : field, text })),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged || update.focusChanged) this.#cursorOn(id, field, update.view);
        if (update.transactions.every((t) => t.annotation(fromDraft))) return;
        if (update.docChanged) this.#actor.send({ type: "_edit", id, field, value: update.state.doc.toString() });
        const lines = leftLines(update);
        if (lines.length) this.#actor.send({ type: "_finish", id, field, lines });
      }),
      EditorView.domEventHandlers({ blur: () => this.#actor.send({ type: "_blur", id, field }) }),
    ];
  }

  // The line the text cursor is on, told to the machine when it changes, so the status
  // line can say Jev's answers about it; nothing while no box has the keyboard.
  #cursorAt = null;
  #cursorOn(id, field, view) {
    const here = (at) => at?.id === id && at.field === field;
    if (!view.hasFocus && !here(this.#cursorAt)) return;
    const text = view.hasFocus ? view.state.doc.lineAt(view.state.selection.main.head).text : null;
    if (here(this.#cursorAt) && this.#cursorAt.text === text) return;
    this.#cursorAt = text == null ? null : { id, field, text };
    this.#actor.send({ type: "_point", source: "cursor", id, field: text == null ? null : field, text });
  }

  // Editors are made when a sheet opens and dropped when it folds; an open one follows
  // its draft text (a change from the fact while nothing waits to save) and Vim. Lit draws
  // the list by position, so when a sheet above folds, an editor moves to the region now
  // drawn for it rather than being made again.
  #syncBoxes() {
    const vimOn = this.#actor.snapshot?.context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll(".box[data-key]")].map((r) => [r.dataset.key, r]));
    for (const [key, box] of this.#boxes) {
      const region = regions.get(key);
      if (!region) {
        box.view.destroy();
        this.#boxes.delete(key);
      } else if (region !== box.region || box.view.dom.parentNode !== region) {
        region.replaceChildren(box.view.dom);
        box.region = region;
      }
    }
    for (const [key, region] of regions) {
      const spec = this.#wanted.get(key);
      if (!spec) continue;
      let box = this.#boxes.get(key);
      if (!box) {
        region.replaceChildren();
        box = { region, vimOn, read: new Compartment(), readOn: spec.read, marksKey: spec.marksKey };
        this.#boxes.set(key, box);
        box.view = new EditorView({
          parent: region,
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there (7.5), so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: spec.text, extensions: this.#extensions(key, spec, vimOn) }),
        });
        continue;
      }
      const effects = [];
      box.vimOn = vimOn;
      setVim(box.view, vimOn);
      // Yesterday's sheet open as its hour after midnight runs out turns read only in place.
      if (box.readOn !== spec.read) {
        box.readOn = spec.read;
        effects.push(box.read.reconfigure(readOnly(spec)));
      }
      if (box.marksKey !== spec.marksKey) {
        box.marksKey = spec.marksKey;
        effects.push(setMarks.of(spec.marks));
      }
      const doc = box.view.state.doc.toString();
      const changes = doc === spec.text ? undefined : { from: 0, to: doc.length, insert: spec.text };
      if (changes || effects.length) box.view.dispatch({ changes, effects, annotations: changes ? fromDraft.of(true) : undefined });
    }
  }

  disconnectedCallback() {
    for (const box of this.#boxes.values()) box.view.destroy();
    this.#boxes.clear();
    super.disconnectedCallback();
  }

  #send(event, focus) {
    this.#focusNext = focus;
    this.#actor.send(event);
    this.requestUpdate();
  }

  #add() {
    this.#actor.send({ type: "_add" });
    this.#focusNext = `.box[data-key="${this.#actor.snapshot?.context.drafts.at(-1)?.id}:situation"]`;
    this.requestUpdate();
  }

  // An earlier day's boxes take no keyboard, so its sheet opens with it on Close.
  #open(id) {
    const writing = writable(this.#actor.snapshot.context);
    this.#send({ type: "_open", id }, writing ? `.box[data-key="${id}:situation"]` : `.sheet[data-id="${id}"] .close`);
  }

  #done(id) {
    this.#send({ type: "_done", id }, `.card[data-id="${id}"]`);
  }

  #card(context, r) {
    const warn = cardWarnings(context, r);
    const flag = (field) =>
      warn[field] ? html`<span class="flag" role="img" aria-label="A line here is not the answer you expect">${icon("warning")}</span>` : nothing;
    // A card shows a box on one row, so its lines are kept apart by a dot.
    const oneRow = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean).join(" · ");
    const move = (kind, label, text) =>
      html`<span class="move ${kind}"><b>${label}</b><span>${oneRow(text) || "—"}</span>${flag(kind)}</span>`;
    const sit = html`<span class="sit ${oneRow(r.situation) ? "" : "none"}">${oneRow(r.situation) || "A choice point"}</span>`;
    return html`<button type="button" class="card" data-id=${r.id} @click=${() => this.#open(r.id)}>
      ${warn.situation ? html`<span class="flagged">${sit}${flag("situation")}</span>` : sit}
      ${move("away", "Away", r.away)} ${move("towards", "Towards", r.towards)}
    </button>`;
  }

  // One box as the render wants it; the editor inside it is made in updated(). A press on
  // the caption puts the keyboard in its box, as a label does for a field.
  #box(context, draft, field) {
    const { label, hint } = BOXES[field];
    const key = `${draft.id}:${field}`;
    const lines = boxMarks(context, draft.id, field);
    this.#wanted.set(key, {
      id: draft.id,
      field,
      label,
      hint,
      read: !writable(context),
      text: draft[field],
      marks: new Map(lines.map((l) => [l.text, l.marks])),
      marksKey: JSON.stringify(lines),
    });
    const focus = () => {
      const box = this.#boxes.get(key);
      if (box) this.#focusBox(box);
    };
    return html`<div class="field ${field}">
      <span aria-hidden="true" @click=${focus}>${label}</span>
      <div class="box" data-key=${key} data-field=${field}></div>
    </div>`;
  }

  #sheet(context, draft) {
    const status = statusOf(context, draft.id);
    const read = !writable(context);
    // Escape on a button closes the sheet like Done; the key is taken so nothing around
    // it acts too. The boxes decide their own Escape, for Vim (#keys).
    const keydown = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      this.#done(draft.id);
    };
    // A tapped mark keeps its answer in the status line until something else is pressed.
    const pointerdown = (e) => {
      if (!context.pointed.tap || e.composedPath().some((n) => n.classList?.contains("marks"))) return;
      this.#actor.send({ type: "_point", source: "tap", id: draft.id, field: null });
    };
    return html`<div class="sheet ${read ? "read" : ""}" data-id=${draft.id} role="group" aria-label="Choice point" @keydown=${keydown} @pointerdown=${pointerdown}>
      <div class="grid">
        ${this.#box(context, draft, "away")}
        <div class="v">${vee}</div>
        ${this.#box(context, draft, "towards")}
        <div class="bottom">${this.#box(context, draft, "situation")} ${this.#box(context, draft, "thoughts")}</div>
      </div>
      <div class="foot">
        <span class="status" role="status">${status}</span>
        <div class="buttons">
          <button type="button" class=${read ? "close" : "done"} @click=${() => this.#done(draft.id)}>${read ? "Close" : "Done"}</button>
        </div>
      </div>
    </div>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const ready = snapshot.matches("ready");
    const failed = snapshot.matches("failed");
    const { context } = snapshot;
    const { choicePoints, drafts } = context;
    // A new choice point joins the list where it will stand once kept, last, so the sheet
    // keeps its place (and the keyboard) when the fact first announces it.
    this.#wanted.clear();
    const items = [...choicePoints, ...drafts.filter((d) => !choicePoints.some((r) => r.id === d.id))];
    const draftOf = (r) => drafts.find((d) => d.id === r.id);
    // An earlier day without choice points has nothing to show or add.
    if (!items.length && !failed && !writable(context)) return nothing;
    return html`<section tabindex="-1" aria-labelledby="heading">
      <h3 id="heading">Choice points</h3>
      ${failed ? html`<p class="empty">Choice points are unavailable.</p>` : nothing}
      ${items.length || writable(context)
        ? html`<div class="list">
            ${items.map((r) => (draftOf(r) ? this.#sheet(context, draftOf(r)) : this.#card(context, r)))}
            ${writable(context)
              ? html`<button type="button" class="new" ?disabled=${!ready} @click=${() => this.#add()}>
                  <span class="mark">${icon("plus")}</span>New choice point
                </button>`
              : nothing}
          </div>`
        : nothing}
    </section>`;
  }
}

customElements.define("choice-point-cards", ChoicePointCards);
