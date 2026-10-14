import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Prec, Annotation } from "@codemirror/state";
import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { history, historyKeymap, insertNewline } from "@codemirror/commands";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { machine, savable } from "./machine.js";
import saved from "./events/choice-point.saved.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };

// The view sits in journal-entry's slot, under the day's text inside its scrolling page
// (the product page nests it), so it scrolls with the day it is about.

// The four boxes are CodeMirror editors, one each, so they take Vim's keys when the "Vim
// keys" preference (12) is on: Vim sits in a compartment turned on and off in place. The
// theme and the Vim cursor are copied from evaluator-editor, because components never
// import each other (11.2).

// The box grows with what is written, from `lines` lines; its frame is drawn around it
// by .box, so the theme draws none.
const boxTheme = (lines) =>
  EditorView.theme({
    "&": { color: "var(--color-ink)", backgroundColor: "transparent", flex: "1" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "var(--leading-normal)" },
    ".cm-content": {
      caretColor: "var(--color-accent)",
      padding: "var(--space-xs) var(--space-sm)",
      minHeight: `calc(var(--text-sm) * var(--leading-normal) * ${lines})`,
    },
    ".cm-line": { fontSize: "var(--text-sm)", padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
    ".cm-placeholder": { color: "var(--color-mute)" },
  });
const shortTheme = boxTheme(2);
// The two moves stand beside the V, so they start as tall as it is.
const tallTheme = boxTheme(4);

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

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

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
      events: { "choice-point.saved": saved, "removal.started": started },
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
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
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
    .pill {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-full);
    }
    .pill:hover:not(:disabled) {
      border-color: var(--color-accent);
      background: var(--color-accent-subtle);
    }
    /* Turned so the split opens downwards, the way the V of the sheet does. */
    .pill svg {
      display: block;
      transform: rotate(180deg);
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
    .away .box:focus-within {
      background: var(--color-warning-subtle);
    }
    .towards .box:focus-within {
      background: var(--color-success-subtle);
    }
    ::selection {
      background: var(--color-accent-selection);
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
  // folded from it, or the pill. Kept here because the elements exist only after render.
  #focusNext = null;

  // The editors of the open sheet by key ("<id>:<field>"), each with the region it is
  // drawn in; and what the last render asked of each box.
  #boxes = new Map();
  #wanted = new Map();

  updated() {
    this.#syncBoxes();
    if (!this.#focusNext) return;
    const target = this.renderRoot.querySelector(this.#focusNext) ?? this.renderRoot.querySelector(".pill");
    this.#focusNext = null;
    const box = [...this.#boxes.values()].find((b) => b.region === target);
    if (box) this.#focusBox(box);
    else target?.focus();
  }

  // A box opened from the pill or a card takes the keyboard in Vim's insert mode when Vim
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
  #keys(field) {
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (event.key !== "Escape" || event.isComposing) return false;
          event.stopPropagation();
          const box = this.#boxes.get(`${this.#actor.snapshot?.context.draft?.id}:${field}`);
          const mode = box?.vimOn ? getCM(view)?.state?.vim : null;
          if (mode?.insertMode || mode?.visualMode) return false;
          event.preventDefault();
          const id = this.#actor.snapshot?.context.draft?.id;
          if (id) this.#done(id);
          return true;
        },
      }),
    );
  }

  #extensions(key, field, spec, vimOn) {
    return [
      this.#keys(field),
      // The Vim plugin must see a key before any keymap does.
      this.#boxes.get(key).vim.of(vimExtensions(vimOn)),
      // Vim hides the native selection, so its visual-mode range shows only through
      // CodeMirror's own selection layer.
      drawSelection(),
      history(),
      keymap.of(historyKeymap),
      // Left to the browser, WebKit's own Enter drops repeated empty lines at the end.
      keymap.of([{ key: "Enter", run: insertNewline }]),
      EditorView.lineWrapping,
      field === "away" || field === "towards" ? tallTheme : shortTheme,
      placeholder(spec.hint),
      EditorView.contentAttributes.of({ "aria-label": spec.label }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#actor.send({ type: "_edit", field, value: update.state.doc.toString() });
      }),
      EditorView.domEventHandlers({
        blur: () => {
          // WebKit keeps the document's selection inside a blurred editor, and a later
          // key nobody cancels is typed there; dropping it leaves nothing to type into.
          document.getSelection()?.removeAllRanges();
          this.#actor.send({ type: "_blur" });
        },
      }),
    ];
  }

  // Editors are made when the sheet opens and dropped when it folds; an open one follows
  // its draft text (a change from the fact while nothing waits to save) and Vim.
  #syncBoxes() {
    const vimOn = this.#actor.snapshot?.context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll(".box[data-key]")].map((r) => [r.dataset.key, r]));
    for (const [key, box] of this.#boxes) {
      if (regions.get(key) === box.region && box.view.dom.parentNode === box.region) continue;
      box.view.destroy();
      this.#boxes.delete(key);
    }
    for (const [key, region] of regions) {
      const spec = this.#wanted.get(key);
      if (!spec) continue;
      let box = this.#boxes.get(key);
      if (!box) {
        region.replaceChildren();
        box = { region, vim: new Compartment(), vimOn };
        this.#boxes.set(key, box);
        box.view = new EditorView({
          parent: region,
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there (7.5), so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: spec.text, extensions: this.#extensions(key, spec.field, spec, vimOn) }),
        });
        continue;
      }
      const effects = [];
      if (box.vimOn !== vimOn) {
        box.vimOn = vimOn;
        effects.push(box.vim.reconfigure(vimExtensions(vimOn)));
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
    this.#send({ type: "_add" }, `.box[data-field="situation"]`);
  }

  #open(id) {
    this.#send({ type: "_open", id }, `.box[data-field="situation"]`);
  }

  #done(id) {
    this.#send({ type: "_done" }, `.card[data-id="${id}"]`);
  }

  #delete() {
    this.#send({ type: "_delete" }, ".pill");
  }

  #card(r) {
    const move = (kind, label, text) =>
      html`<span class="move ${kind}"><b>${label}</b><span>${text.trim() || "—"}</span></span>`;
    return html`<button type="button" class="card" data-id=${r.id} @click=${() => this.#open(r.id)}>
      <span class="sit ${r.situation.trim() ? "" : "none"}">${r.situation.trim() || "A choice point"}</span>
      ${move("away", "Away", r.away)} ${move("towards", "Towards", r.towards)}
    </button>`;
  }

  // One box as the render wants it; the editor inside it is made in updated(). A press on
  // the caption puts the keyboard in its box, as a label does for a field.
  #box(draft, field) {
    const { label, hint } = BOXES[field];
    const key = `${draft.id}:${field}`;
    this.#wanted.set(key, { field, label, hint, text: draft[field] });
    const focus = () => {
      const box = this.#boxes.get(key);
      if (box) this.#focusBox(box);
    };
    return html`<div class="field ${field}">
      <span aria-hidden="true" @click=${focus}>${label}</span>
      <div class="box" data-key=${key} data-field=${field}></div>
    </div>`;
  }

  #sheet(snapshot) {
    const { context } = snapshot;
    const { draft } = context;
    const status = snapshot.matches({ ready: { open: "dirty" } })
      ? "Saving…"
      : savable(context)
        ? "Saved"
        : "Kept once you write in a box";
    // Escape on a button closes the sheet like Done; the key is taken so nothing around
    // it acts too. The boxes decide their own Escape, for Vim (#keys).
    const keydown = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      this.#done(draft.id);
    };
    return html`<div class="sheet" role="group" aria-label="Choice point" @keydown=${keydown}>
      <div class="grid">
        ${this.#box(draft, "away")}
        <div class="v">${vee}</div>
        ${this.#box(draft, "towards")}
        <div class="bottom">${this.#box(draft, "situation")} ${this.#box(draft, "thoughts")}</div>
      </div>
      <div class="foot">
        <span class="status" role="status">${status}</span>
        <div class="buttons">
          <button type="button" class="delete" @click=${() => this.#delete()}>Delete</button>
          <button type="button" class="done" @click=${() => this.#done(draft.id)}>Done</button>
        </div>
      </div>
    </div>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const ready = snapshot.matches("ready");
    const failed = snapshot.matches("failed");
    const { choicePoints, draft } = snapshot.context;
    // A new choice point joins the list where it will stand once kept, last, so the sheet
    // keeps its place (and the keyboard) when the fact first announces it.
    const shown = choicePoints.filter((r) => !r.removing);
    this.#wanted.clear();
    const items = draft && !shown.some((r) => r.id === draft.id) ? [...shown, draft] : shown;
    return html`<section tabindex="-1" aria-labelledby="heading">
      <div class="head">
        <h3 id="heading">Choice points</h3>
        <button type="button" class="pill" ?disabled=${!ready} @click=${() => this.#add()}>
          ${icon("arrows-split")} Choice point
        </button>
      </div>
      ${failed ? html`<p class="empty">Choice points are unavailable.</p>` : nothing}
      ${items.length
        ? html`<div class="list">${items.map((r) => (draft?.id === r.id ? this.#sheet(snapshot) : this.#card(r)))}</div>`
        : nothing}
    </section>`;
  }
}

customElements.define("choice-point-cards", ChoicePointCards);
