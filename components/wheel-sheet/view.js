import { LitElement, html, svg, css, nothing, render } from "lit";
import { mount, unmount, ask, send } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Prec, Annotation } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs, toRegister } from "editor";
import { machine, AREAS, writable, dayWheels, summaryOf, scoreLine, wheelLabel, caption, wantedLabel, sheetKey, sheetTarget, rowKey, boxEdge, hasAnswer, panelOf, panelHint, panelTarget, pastLastBox } from "./machine.js";
import saved from "./events/wheel.saved.json" with { type: "json" };
import add from "./commands/add.json" with { type: "json" };

// The view sits in journal-entry's slot, under the day's text inside its scrolling page (the
// product page nests it), so it scrolls with the day it is about. It is drawn like
// choice-point-cards: the same section, card, sheet and buttons.

// The answers are CodeMirror editors, one per question, built on the editor kit (10), so they
// take Vim's keys when the "Vim keys" preference (12) is on and make paragraphs on Enter.

// The box grows with what is written, from two lines; its frame is drawn around it by .box, so
// the theme draws none. Only what differs from the kit's theme, which yields.
const boxTheme = EditorView.theme({
  "&": { flex: "1" },
  ".cm-content": {
    padding: "var(--space-xs) var(--space-sm)",
    minHeight: "calc(var(--text-sm) * var(--leading-normal) * 2)",
  },
  ".cm-line": { fontSize: "var(--text-sm)" },
});

// An answer on a day that can no longer be written: drawn by the kit like a box, so a list stays a
// list rather than showing its stored "- ", but as plain text with no frame and no keyboard stop.
const readTheme = EditorView.theme({
  ".cm-content": { padding: "0 var(--space-sm)", minHeight: "0", color: "var(--color-body)" },
});
const readOnly = [EditorState.readOnly.of(true), EditorView.editable.of(false), readTheme];

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

// The wheel's drawing, in its own 200 by 200 units: eight areas, each ten rings out.
const CENTER = 100;
const INNER = 10;
const RING = 8.8;
const point = (r, a) => `${(CENTER + r * Math.cos(a)).toFixed(2)} ${(CENTER + r * Math.sin(a)).toFixed(2)}`;
const angle = (i) => -Math.PI / 2 + (i * Math.PI) / 4;

const sector = (i, ring) => {
  const r0 = INNER + (ring - 1) * RING;
  const r1 = INNER + ring * RING;
  const [a, b] = [angle(i), angle(i + 1)];
  return `M${point(r0, a)} A${r0} ${r0} 0 0 1 ${point(r0, b)} L${point(r1, b)} A${r1} ${r1} 0 0 0 ${point(r1, a)} Z`;
};

// The line stops short of the area's edges, so two neighbors' lines never read as one.
const arc = (i, score) => {
  const r = INNER + score * RING;
  return `M${point(r, angle(i) + 0.04)} A${r} ${r} 0 0 1 ${point(r, angle(i + 1) - 0.04)}`;
};

const RINGS = Array.from({ length: 10 }, (_, n) => n + 1);

// The cells of the wheel and the Wanted line over them. Without `pick` the wheel only shows.
const wheelPaths = ({ actual, wanted }, { cursor = -1, pick } = {}) => svg`
  ${AREAS.map((_, i) =>
    RINGS.map(
      (ring) =>
        svg`<path
          class="w-cell ${(actual[i] ?? 0) >= ring ? "on" : ""} ${i === cursor ? "cur" : ""} ${pick ? "" : "ro"}"
          d=${sector(i, ring)}
          @click=${pick ? () => pick(i, ring) : nothing}
        ></path>`,
    ),
  )}
  ${wanted.map((v, i) => (v === null ? nothing : svg`<path class="w-last" d=${arc(i, v)}></path>`))}
`;

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      // Vim's registers are one per page, so text put there is what any editor's p pastes.
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        send: (target, name, payload) => send(machine, target, name, payload),
        mint: ulid,
        now: () => Date.now(),
        pushRegister: toRegister,
      },
      events: { "wheel.saved": saved },
      commands: { add },
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

class WheelSheet extends LitElement {
  static styles = css`
    :host {
      display: block;
      container-type: inline-size;
      color: var(--color-body);
    }
    /* The page around spaces what it holds with a gap, so a day without a wheel must take
       no place in it at all to look unchanged. */
    :host([idle]) {
      display: none;
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
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .card {
      display: flex;
      align-items: center;
      gap: var(--space-md);
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
    .mini {
      flex: none;
      display: block;
      width: calc(var(--space-2xl) + var(--space-lg));
      height: calc(var(--space-2xl) + var(--space-lg));
    }
    /* The columns stop growing, so a score never stands far from its name on a wide card. */
    .sum {
      flex: 1;
      min-width: 0;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, calc(var(--space-2xl) * 2 + var(--space-lg))));
      justify-content: start;
      gap: 0 var(--space-md);
      font-size: var(--text-sm);
    }
    .it {
      display: flex;
      justify-content: space-between;
      gap: var(--space-xs);
    }
    .n {
      color: var(--color-body);
    }
    .v {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    .d {
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
      margin-left: var(--space-xs);
    }
    .sheet {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      box-sizing: border-box;
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
    }
    .modes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      padding: calc(var(--space-2xs) + var(--border-width));
      border-radius: var(--radius-sm);
      background: var(--color-canvas-soft);
    }
    .modes button {
      padding: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-body);
    }
    .modes button.on {
      background: var(--color-canvas);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .caption {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    /* One grid for the normal and the wide page. The wheel and the rows stay at a form's width
       so a square never stretches into a long bar, the third track takes what is left, and the
       rows and the one panel are placed in it through .rows' display: contents. One panel element
       serves every layout and every area, so a resize or a move never rebuilds what it holds. */
    .wbody {
      display: grid;
      grid-template-columns:
        calc(var(--space-2xl) * 2 + var(--space-xl) + var(--space-xs) + var(--space-md))
        minmax(0, calc(var(--width-form) - var(--space-md) * 3 - var(--border-width) * 2 - var(--space-2xl) * 2 - var(--space-xl) - var(--space-xs)))
        minmax(0, 1fr);
      grid-template-rows: auto auto repeat(8, auto) auto;
    }
    .modes {
      grid-column: 1 / 3;
      grid-row: 1;
      margin-bottom: var(--space-sm);
    }
    .say {
      grid-column: 1 / 3;
      grid-row: 2;
      margin-bottom: var(--space-sm);
    }
    .rows {
      display: contents;
    }
    .wheel {
      grid-column: 1;
      grid-row: 3 / span 8;
      display: block;
      width: calc(var(--space-2xl) * 2 + var(--space-xl) + var(--space-xs));
      height: calc(var(--space-2xl) * 2 + var(--space-xl) + var(--space-xs));
    }
    .w-cell {
      fill: var(--color-canvas-soft);
      stroke: var(--color-canvas);
      stroke-width: 1;
      cursor: pointer;
    }
    .w-cell:hover,
    .w-cell.cur {
      fill: var(--color-surface-active);
    }
    .w-cell.on,
    .w-cell.on:hover {
      fill: var(--color-accent);
    }
    .w-cell.ro {
      cursor: default;
    }
    .w-cell.ro:hover {
      fill: var(--color-canvas-soft);
    }
    .w-cell.ro.on:hover {
      fill: var(--color-accent);
    }
    .w-cell.ro.cur,
    .w-cell.ro.cur:hover {
      fill: var(--color-surface-active);
    }
    .w-cell.on.cur,
    .w-cell.on.cur:hover,
    .w-cell.ro.on.cur,
    .w-cell.ro.on.cur:hover {
      fill: var(--color-accent-hover);
    }
    .w-last {
      fill: none;
      stroke: var(--color-ink);
      stroke-width: 2;
      stroke-linecap: round;
      pointer-events: none;
    }
    .area {
      grid-column: 2;
      display: grid;
      grid-template-columns: calc(var(--space-xl) + var(--space-md) * 2 + var(--space-2xs)) minmax(0, 1fr) calc(var(--space-xl) - var(--space-xs));
      gap: var(--space-xs);
      align-items: center;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      color: var(--color-ink);
    }
    .area.cur {
      background: var(--color-surface-hover);
    }
    .area:focus {
      outline: none;
    }
    .area:focus-visible {
      box-shadow: var(--focus-ring);
    }
    .opener {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent;
      text-align: left;
    }
    .arrow {
      flex: none;
      display: inline-grid;
      place-items: center;
      width: var(--space-md);
      height: var(--space-md);
      border-radius: var(--radius-full);
      font-size: calc(var(--space-md) - var(--space-xs));
      color: var(--color-body-mid);
    }
    .arrow svg {
      display: block;
    }
    .opener:hover .arrow {
      background: var(--color-surface-active);
      color: var(--color-ink);
    }
    .arrow.open svg {
      transform: rotate(90deg);
    }
    .arrow.marked,
    .opener:hover .arrow.marked {
      background: var(--color-accent);
      color: var(--color-accent-text);
    }
    .scale {
      display: grid;
      grid-template-columns: repeat(10, minmax(0, 1fr));
      gap: var(--space-2xs);
    }
    .sq {
      height: var(--space-md);
      padding: 0;
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--space-2xs);
      background: var(--color-canvas);
    }
    .sq.on {
      background: var(--color-accent);
      border-color: var(--color-accent);
    }
    .sq.was {
      border: var(--space-2xs) solid var(--color-ink);
    }
    .sq[disabled] {
      cursor: default;
    }
    .score {
      text-align: right;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
    }
    .qs {
      grid-column: 1 / -1;
      grid-row: 11;
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      min-width: 0;
      margin-top: var(--space-md);
      padding-top: var(--space-md);
      border-top: var(--border-width) solid var(--color-border);
    }
    .q-title {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-sm);
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .q-groups {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .q-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      min-width: 0;
    }
    .q-group h4 {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-body-mid);
    }
    .q {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .q-text {
      font-size: var(--text-sm);
      color: var(--color-ink);
    }
    /* CodeMirror owns everything inside .box; the frame is drawn here, around it. */
    .box {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      color: var(--color-ink);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .box:focus-within {
      box-shadow: var(--focus-ring);
    }
    .q-hint {
      display: none;
    }
    /* The key's long line breaks beside the buttons rather than pushing them to a row of their
       own, so the first change to a Wanted score, which shortens it, barely moves them. */
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
    }
    .legend {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      gap: var(--space-xs);
      text-wrap: balance;
    }
    .legend b,
    .legend i {
      display: inline-block;
      flex: none;
      width: calc(var(--space-md) - var(--space-xs));
      height: calc(var(--space-md) - var(--space-xs));
      box-sizing: border-box;
      border-radius: var(--space-2xs);
    }
    .legend b {
      background: var(--color-accent);
    }
    .legend i {
      margin-left: var(--space-sm);
      border: var(--space-2xs) solid var(--color-ink);
    }
    .buttons {
      flex: none;
      display: flex;
      gap: var(--space-sm);
      margin-left: auto;
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
    /* A panel this wide reads better with its two groups side by side, and needs less scrolling
       to reach below the wheel. */
    @container (width >= 40rem) {
      .q-groups {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-items: start;
        gap: var(--space-lg);
      }
    }
    /* Four columns of scores with the small wheel beside them need this much of the card. */
    @container (width >= 52rem) {
      .sum {
        grid-template-columns: repeat(4, calc(var(--space-2xl) * 2 + var(--space-lg)));
        gap: 0 var(--space-lg);
      }
    }
    /* A wide page has room for the panel beside the wheel and the rows: from this width each
       box holds about five words a line, and narrower ones wrap a sentence over four lines, where
       the panel below the rows reads better. The last row track is flexible so a tall panel does
       not spread the rows. */
    @container (width >= 66rem) {
      .wbody {
        grid-template-rows: auto auto repeat(8, auto) minmax(0, 1fr);
      }
      .qs,
      .q-hint {
        grid-column: 3;
        grid-row: 1 / -1;
        margin: 0 0 0 var(--space-lg);
        padding: 0 0 0 var(--space-lg);
        border-top: 0;
        border-left: var(--border-width) solid var(--color-border);
      }
      .q-hint {
        display: block;
      }
    }
    /* A narrow page (a phone, or a narrow stage): the wheel stands above the rows, and the
       targets are large enough for a finger. Below this width, beside the wheel, a square
       would be too narrow to press. The panel opens under its row, through its order. */
    @container (width < 28rem) {
      .wbody {
        display: flex;
        flex-direction: column;
        gap: var(--space-sm);
      }
      .modes,
      .say {
        margin-bottom: 0;
      }
      .rows {
        display: flex;
        flex-direction: column;
      }
      .opener {
        min-height: var(--space-xl);
      }
      .qs {
        margin: 0;
        padding: var(--space-sm) var(--space-xs) var(--space-md);
        border-top: 0;
        border-bottom: var(--border-width) solid var(--color-border);
      }
      .q-title {
        display: none;
      }
      .wheel {
        align-self: center;
        width: calc(var(--space-2xl) * 3 + var(--space-xl) + var(--space-sm));
        max-width: 100%;
        height: auto;
        aspect-ratio: 1;
      }
      .foot {
        flex-wrap: wrap;
      }
      .modes button {
        min-height: var(--space-xl);
      }
      .sq {
        height: calc(var(--space-md) * 2);
      }
      .sum {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    /* Narrower still (a stage squeezed between both panels, a small phone): the name and score
       stand above the squares, which otherwise get too thin to press, and the small wheel above
       its card's lines. */
    @container (width < 20rem) {
      .area {
        grid-template-columns: minmax(0, 1fr) auto;
      }
      .scale {
        grid-column: 1 / -1;
        grid-row: 2;
      }
      .score {
        grid-column: 2;
        grid-row: 1;
      }
      .card {
        flex-direction: column;
        align-items: stretch;
      }
      .mini {
        align-self: center;
      }
    }
  `;

  #actor = new ActorController(this);

  // Where the keyboard goes once the next render lands, as a selector. Kept here because the
  // elements exist only after render.
  #focusNext = null;
  // The last add the keyboard was given for.
  #landed = 0;
  // What the last render showed of the panel, so a move or an opening can keep things in view,
  // and whether this change came from the wheel, where a scroll would take away what was pressed.
  #shownPanel = false;
  #shownCursor = 0;
  #fromWheel = false;
  // Whether the keyboard was inside before this render, and whether the last thing the user
  // did here was a press: after a press nothing moves, as a keyboard moved onto text would come
  // up on a phone.
  #holding = false;
  #byPress = false;
  // Whether a box had the keyboard before this render: when the render takes that box away (the
  // day closed at 2:00) the keyboard stays with the sheet, on the area the box was about.
  #inBox = false;
  // Which box of the panel the keyboard lands in once the next render has made it: "first",
  // "last", or null.
  #landNext = null;
  // The panel's editors by key ("<area>:<question>"), each with the region it is drawn in, and
  // what the last render asked of each. Keyed by area, so a box's history never holds another
  // area's text.
  #boxes = new Map();
  #wanted = new Map();

  #rows() {
    return [...(this.renderRoot?.querySelectorAll(".list > *") ?? [])];
  }

  #send(event, focus) {
    this.#focusNext = focus;
    this.#actor.send(event);
    this.requestUpdate();
  }

  willUpdate() {
    this.#holding = this.matches(":focus-within");
    this.#inBox = Boolean(this.renderRoot?.activeElement?.closest?.(".box"));
    const snapshot = this.#actor.snapshot;
    this.toggleAttribute("idle", !snapshot || !(snapshot.matches("failed") || this.#items(snapshot.context).length));
  }

  updated() {
    this.#syncBoxes();
    const context = this.#actor.snapshot?.context;
    if (context && context.landing !== this.#landed) {
      this.#landed = context.landing;
      this.#focusNext = '.area[data-i="0"]';
    }
    if (this.#focusNext) {
      this.renderRoot.querySelector(this.#focusNext)?.focus();
      this.#focusNext = null;
    }
    if (context) this.#keepInView(context);
    // After keepInView, so on a phone the box ends in sight rather than the area above it.
    if (this.#landNext) {
      const regions = [...this.renderRoot.querySelectorAll(".box[data-key]")];
      const region = this.#landNext === "first" ? regions[0] : regions.at(-1);
      const box = region && this.#boxes.get(region.dataset.key);
      if (box) this.#landIn(box, this.#landNext);
      this.#landNext = null;
    }
    if (this.matches(":focus-within")) return;
    if (this.#inBox && context?.draft) this.#focusArea(context.cursor);
    // What held the keyboard went (a wheel not kept, a delete, an Undo).
    else if (this.#holding && !this.#byPress) this.#actor.send({ type: "_handBack" });
  }

  // A box given the keyboard by Enter takes it in Vim's insert mode when Vim keys is on, so the
  // first key typed is text. The editor takes focus without scrolling, and the box may stand
  // below the fold.
  #focusBox(box) {
    box.view.focus();
    box.region.scrollIntoView({ block: "nearest" });
    const cm = box.vimOn ? getCM(box.view) : null;
    if (cm && cm.state?.vim?.insertMode !== true) Vim.handleKey(cm, "i", "user");
  }

  // Escape (12): with Vim on, an Escape in insert or visual mode is Vim's, back to normal mode;
  // any other leaves the box onto its area. A keydown handler at Prec.highest, not a keymap,
  // because the Vim plugin's handler runs before every keymap and would take it. The key never
  // reaches what is around the box, so nothing there acts on it too.
  #keys(key) {
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (this.#leaveAtEdge(event, view, key)) return true;
          if (event.key !== "Escape" || event.isComposing) return false;
          event.stopPropagation();
          const mode = this.#boxes.get(key)?.vimOn ? getCM(view)?.state?.vim : null;
          if (mode?.insertMode || mode?.visualMode) return false;
          event.preventDefault();
          this.#focusArea(this.#actor.snapshot.context.cursor);
          return true;
        },
      }),
    );
  }

  // j on a box's last line or k on its first (boxEdge) goes to the next or the previous box of
  // the panel. Past the first box k goes back onto the area, and past the last j goes on.
  #leaveAtEdge(event, view, key) {
    const box = this.#boxes.get(key);
    if (!box?.vimOn) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const step = boxEdge(event, getCM(view)?.state?.vim, line, { first: 1, last: view.state.doc.lines });
    if (!step) return false;
    const regions = [...this.renderRoot.querySelectorAll(".box[data-key]")];
    const next = regions[regions.indexOf(box.region) + (step === "down" ? 1 : -1)];
    const to = next && this.#boxes.get(next.dataset.key);
    const { cursor } = this.#actor.snapshot.context;
    if (to) this.#landIn(to, step === "down" ? "first" : "last");
    else if (step === "up") this.#focusArea(cursor);
    else this.#pastLast(cursor);
    event.preventDefault();
    return true;
  }

  // Past the last box: the next area, or past the last area what follows the sheet. The page
  // around ignores a key whose target is a box, where a letter is text, so the key is sent on
  // from the host, where nothing has used it.
  #pastLast(cursor) {
    const to = pastLastBox(cursor);
    if (to !== "leave") return this.#focusArea(to);
    const rows = this.#rows();
    const next = rows[rows.findIndex((r) => r.classList.contains("sheet")) + 1];
    if (next) return this.#focusRow(next, "first");
    this.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true, composed: true, cancelable: true }));
  }

  // The area's panel has to render before the box exists.
  #walkTo({ area, edge }) {
    this.#landNext = edge;
    this.#actor.send({ type: "_cursor", to: area });
    this.requestUpdate();
  }

  // A box takes the keyboard in Vim's normal mode, at the start of its first line or of its last.
  #landIn(box, edge) {
    const { doc } = box.view.state;
    box.view.focus();
    // A box left in insert mode, by a press outside it, would take the next j as text.
    const cm = box.vimOn ? getCM(box.view) : null;
    if (cm?.state?.vim?.insertMode) Vim.handleKey(cm, "<Esc>", "user");
    const n = edge === "first" ? 1 : doc.lines;
    box.view.dispatch({ selection: { anchor: doc.line(n).from }, scrollIntoView: true });
    box.region.scrollIntoView({ block: "nearest" });
  }

  #extensions(key, spec, vimOn) {
    const { area, question } = spec;
    return [
      this.#keys(key),
      ...baseExtensions({ vim: vimOn }),
      paragraphs({ box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      boxTheme,
      ...(spec.read ? readOnly : []),
      ...(spec.hint ? [placeholder(spec.hint)] : []),
      this.#boxes.get(key).label.of(EditorView.contentAttributes.of({ "aria-label": spec.text })),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#actor.send({ type: "_edit", area, question, value: update.state.doc.toString() });
      }),
      EditorView.domEventHandlers({
        focus: () => this.#actor.send({ type: "_boxIn" }),
        blur: () => this.#actor.send({ type: "_boxOut" }),
      }),
    ];
  }

  // Editors are made when the panel draws a question and dropped when it goes; one kept follows
  // its draft text (a change from the fact while nothing waits to save), its wording, and Vim.
  // Lit draws the questions by position, so an editor moves to the region now drawn for it
  // rather than being made again.
  #syncBoxes() {
    const vimOn = this.#actor.snapshot?.context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll("[data-key]")].map((r) => [r.dataset.key, r]));
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
        const vim = vimOn && !spec.read;
        box = { region, vimOn: vim, label: new Compartment(), labelOn: spec.text };
        this.#boxes.set(key, box);
        box.view = new EditorView({
          parent: region,
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there, so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: spec.value, extensions: this.#extensions(key, spec, vim) }),
        });
        continue;
      }
      if (!spec.read) {
        box.vimOn = vimOn;
        setVim(box.view, vimOn);
      }
      const effects = [];
      // "What makes it a 6" follows the score.
      if (box.labelOn !== spec.text) {
        box.labelOn = spec.text;
        effects.push(box.label.reconfigure(EditorView.contentAttributes.of({ "aria-label": spec.text })));
      }
      const doc = box.view.state.doc.toString();
      const changes = doc === spec.value ? undefined : { from: 0, to: doc.length, insert: spec.value };
      if (changes || effects.length) box.view.dispatch({ changes, effects, annotations: changes ? fromDraft.of(true) : undefined });
    }
  }

  disconnectedCallback() {
    for (const box of this.#boxes.values()) box.view.destroy();
    this.#boxes.clear();
    super.disconnectedCallback();
  }

  // Moving with the panel open under a row shifts the rows after the focus has scrolled, so the
  // row is brought back in view here; an opening shows the panel, with the row kept in view if
  // the panel is too tall for both.
  #keepInView({ draft, panel, cursor }) {
    const open = Boolean(draft) && panel;
    const opened = open && !this.#shownPanel;
    const moved = open && !opened && cursor !== this.#shownCursor;
    if (opened) this.renderRoot.querySelector(".qs")?.scrollIntoView({ block: "nearest" });
    if (opened || (moved && !this.#fromWheel)) this.renderRoot.querySelector(".area.cur")?.scrollIntoView({ block: "nearest" });
    this.#shownPanel = open;
    this.#shownCursor = cursor;
    this.#fromWheel = false;
  }

  // Focused by any way, an area is the one the keys act on.
  #focusArea(i, options) {
    this.#actor.send({ type: "_cursor", to: i });
    this.renderRoot.querySelector(`.area[data-i="${i}"]`)?.focus(options);
  }

  // Where a move inside the sheet landed (sheetTarget).
  #focusPlace(place) {
    if (typeof place === "number") return this.#focusArea(place);
    this.renderRoot.querySelector(place === "tabs" ? ".modes button.on" : ".close")?.focus();
  }

  // A card takes the keyboard itself; an open sheet at the end of its path it is entered from:
  // the first row from above, the last from below, so each way out has its way back.
  #focusRow(row, edge) {
    if (!row.classList.contains("sheet")) return row.focus();
    const read = row.classList.contains("read");
    if (edge === "last") {
      this.#actor.send({ type: "_cursor", to: AREAS.length - 1 });
      this.#focusPlace(read ? "close" : AREAS.length - 1);
      // The area takes the keyboard at once, because the page around asks right after this
      // whether the view took it; the box follows once it is drawn.
      const { vimKeys, panel } = this.#actor.snapshot.context;
      if (!read && vimKeys && panel) this.#walkTo({ area: AREAS.length - 1, edge: "last" });
      return;
    }
    this.#focusPlace(read ? 0 : "tabs");
  }

  // journal-entry hands the keyboard by the host: the first row, or the last when it comes from
  // below. With nothing to land on it stays where it was, so the entry passes this view over.
  focus(options) {
    const rows = this.#rows();
    const below = options?.from === "below";
    const row = below ? rows.at(-1) : rows[0];
    if (row) this.#focusRow(row, below ? "last" : "first");
  }

  #gAt = 0;
  #key = (event) => {
    this.#byPress = false;
    const target = event.composedPath()[0];
    // A box decides its own keys (#keys), so j, h and l stay text.
    if (event.defaultPrevented || target.closest?.(".box")) return;
    const { context } = this.#actor.snapshot;
    const rows = this.#rows();
    const at = rows.findIndex((r) => r.contains(target));
    if (at < 0) return;
    const onSheet = rows[at].classList.contains("sheet");
    const onArea = target.classList?.contains("area") === true;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (onSheet && event.key === "Escape") {
      take();
      return this.#escape();
    }
    // Enter on a button is the button's. On an area it opens the panel, then goes into its first
    // box; a panel only read has none, and nothing moves.
    if (onSheet && event.key === "Enter" && onArea) {
      take();
      if (!context.panel) return this.#actor.send({ type: "_enter" });
      const first = this.renderRoot.querySelector(".box[data-key]");
      const box = first && this.#boxes.get(first.dataset.key);
      if (box) this.#focusBox(box);
      return;
    }
    const write = onSheet && writable(context);
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const key = (write ? sheetKey : rowKey)(event, context.vimKeys === true, afterG);
    this.#gAt = key?.wait ? Date.now() : 0;
    if (!key) return;
    if (key.wait) return event.preventDefault();
    const onTabs = target.parentElement?.classList.contains("modes") === true;
    // On the tabs left and right switch them, and the keyboard goes with the choice.
    if (key.choose || (key.step && onTabs)) {
      take();
      const mode = key.choose ?? (key.more ? "wanted" : "actual");
      return this.#send({ type: "_mode", mode }, onTabs ? `.modes button[data-mode="${mode}"]` : null);
    }
    if (key.step) {
      take();
      this.#actor.send({ type: "_step", more: key.more });
      return this.#focusArea(this.#actor.snapshot.context.cursor);
    }
    const { move } = key;
    if (onSheet) {
      const into = key.walk && onArea && write && context.panel ? panelTarget(move, context.cursor) : null;
      if (into) {
        take();
        return this.#walkTo(into);
      }
      const on = onArea ? "area" : onTabs ? "tabs" : target.classList?.contains("close") ? "close" : "button";
      const to = sheetTarget(move, on, context.cursor, write);
      if (to !== "leave") {
        take();
        return this.#focusPlace(to);
      }
    }
    // Past either end the key is not used here, so it bubbles on to the page around.
    const next = { down: at + 1, up: at - 1, first: 0, last: rows.length - 1 }[move];
    if (!rows[next]) return;
    take();
    this.#focusRow(rows[next], move === "up" || move === "last" ? "last" : "first");
  };

  #press = () => {
    this.#byPress = true;
  };

  // A press on the sheet's own text or blank part puts the keyboard on the section, outside the
  // keyboard path, where j would leave the sheet; it stays with the area the keys act on.
  #keepPath = () => {
    if (this.renderRoot.activeElement?.tagName === "SECTION") this.#focusArea(this.#actor.snapshot.context.cursor, { preventScroll: true });
  };

  // The sheet folds only once the panel is closed; then the keyboard goes to the card.
  #escape() {
    const { draft, panel } = this.#actor.snapshot.context;
    this.#send({ type: "_escape" }, panel ? null : `.card[data-id="${draft.id}"]`);
  }

  #done() {
    const id = this.#actor.snapshot.context.draft?.id;
    this.#send({ type: "_done" }, `.card[data-id="${id}"]`);
  }

  // The keyboard moves on to the next row, or the one before; with none it goes to + Add sheet.
  #delete() {
    const rows = this.#rows();
    const at = rows.findIndex((r) => r.classList.contains("sheet"));
    const next = rows[at + 1] ?? rows[at - 1];
    this.#send({ type: "_delete" }, next ? `[data-id="${next.dataset.id}"]` : null);
  }

  #open(id) {
    this.#send({ type: "_open", id }, '.area[data-i="0"]');
  }

  // A press sets the score and leaves the keyboard on that area, without scrolling to it: on a
  // phone the rows may stand below the wheel that was pressed.
  #pick = (area, value) => {
    this.#actor.send({ type: "_press", area, value });
    this.#focusArea(area, { preventScroll: true });
  };

  #pickOnWheel = (area, value) => {
    this.#fromWheel = true;
    this.#pick(area, value);
  };

  // A press leaves the keyboard on that area, as a press on a square does.
  #toggle(area) {
    this.#actor.send({ type: "_toggle", area });
    this.#focusArea(area, { preventScroll: true });
  }

  #card(w) {
    return html`<button type="button" class="card" data-id=${w.id} aria-label="Wheel of Life, press to open" @click=${() => this.#open(w.id)}>
      <svg class="mini" viewBox="0 0 200 200" aria-hidden="true">${wheelPaths(w)}</svg>
      <span class="sum">
        ${summaryOf(w).map(
          ({ name, score, gap }) => html`<span class="it"><span class="n">${name}</span><span class="v">${score}<span class="d">${gap}</span></span></span>`,
        )}
      </span>
    </button>`;
  }

  // The arrow and the name are one button. It takes no Tab, as the squares take none: Enter on
  // the area does the same. Every area and the panel stand in one list, ordered so that a narrow
  // page shows the panel under its row (the order) and the grid places them otherwise (the row).
  #area(context, draft, name, i, write) {
    const current = i === context.cursor;
    const open = current && context.panel;
    const answered = hasAnswer(draft, i);
    return html`<div
      class="area ${current ? "cur" : ""}"
      style="order: ${i * 2}; grid-row: ${i + 3}"
      data-i=${i}
      role="group"
      aria-label=${name}
      tabindex=${current ? "0" : "-1"}
      @focus=${() => this.#actor.send({ type: "_cursor", to: i })}
    >
      <button type="button" class="opener" tabindex="-1" aria-expanded=${open ? "true" : "false"} aria-label="${name} questions${answered ? ", answered" : ""}" @click=${() => this.#toggle(i)}>
        <span class="arrow ${open ? "open" : ""} ${answered ? "marked" : ""}">${icon("caret-right")}</span>
        <span>${name}</span>
      </button>
      <span class="scale">
        ${Array.from(
          { length: 10 },
          (_, n) =>
            html`<button
              type="button"
              class="sq ${(draft.actual[i] ?? 0) > n ? "on" : ""} ${draft.wanted[i] === n + 1 ? "was" : ""}"
              aria-label="${name} ${n + 1}"
              tabindex="-1"
              ?disabled=${!write}
              @click=${() => this.#pick(i, n + 1)}
            ></button>`,
        )}
      </span>
      <span class="score">${scoreLine(draft.actual[i], draft.wanted[i])}</span>
    </div>`;
  }

  // A day that can be written has a box, its editor made in updated(); a press on the question
  // puts the keyboard in it, as a label does for a field. An earlier day's answer is only read,
  // under a key of its own, so at 2:00 the editor that took typing goes.
  #question(spec, write) {
    if (!write) {
      const key = `read:${spec.area}:${spec.question}`;
      this.#wanted.set(key, { ...spec, read: true });
      return html`<div class="q">
        <span class="q-text">${spec.text}</span>
        <div class="q-read" data-key=${key}></div>
      </div>`;
    }
    const key = `${spec.area}:${spec.question}`;
    this.#wanted.set(key, spec);
    const focus = () => {
      const box = this.#boxes.get(key);
      if (box) this.#focusBox(box);
    };
    return html`<div class="q">
      <span class="q-text" aria-hidden="true" @click=${focus}>${spec.text}</span>
      <div class="box" data-key=${key}></div>
    </div>`;
  }

  #panel(context, draft) {
    const { name, score, label, groups, emptyLine } = panelOf(context, draft);
    const write = writable(context);
    return html`<div class="qs" style="order: ${context.cursor * 2 + 1}" role="group" aria-label=${label}>
      <div class="q-title"><span>${name}</span><span class="score">${score}</span></div>
      ${emptyLine ? html`<p class="caption">${emptyLine}</p>` : nothing}
      ${groups.length
        ? html`<div class="q-groups">
            ${groups.map(
              (g) => html`<div class="q-group">
                <h4>${g.title}</h4>
                ${g.note ? html`<p class="caption">${g.note}</p>` : nothing}
                ${g.items.map((q) => this.#question({ ...q, area: context.cursor }, write))}
              </div>`,
            )}
          </div>`
        : nothing}
    </div>`;
  }

  #sheet(context, draft) {
    const write = writable(context);
    const choice = (mode, label) =>
      html`<button type="button" class=${context.mode === mode ? "on" : ""} data-mode=${mode} aria-pressed=${context.mode === mode ? "true" : "false"} @click=${() => this.#actor.send({ type: "_mode", mode })}>${label}</button>`;
    return html`<div class="sheet ${write ? "" : "read"}" data-id=${draft.id} role="group" aria-label="Wheel of Life" @click=${this.#keepPath}>
      <div class="wbody">
        ${write ? html`<div class="modes" role="group" aria-label="Which score a click sets">${choice("actual", "Actual")}${choice("wanted", "Wanted")}</div>` : nothing}
        <p class="caption say">${caption(context)}</p>
        <svg class="wheel" viewBox="0 0 200 200" role="img" aria-label=${wheelLabel(draft)}>
          ${wheelPaths(draft, { cursor: context.cursor, pick: write ? this.#pickOnWheel : undefined })}
        </svg>
        <div class="rows">
          ${AREAS.map((name, i) => this.#area(context, draft, name, i, write))}
          ${context.panel ? this.#panel(context, draft) : nothing}
        </div>
        ${context.panel ? nothing : html`<p class="caption q-hint">${panelHint(context)}</p>`}
      </div>
      <div class="foot">
        <span class="caption legend"><b></b>Actual<i></i>${wantedLabel(context, draft)}</span>
        <div class="buttons">
          ${write
            ? html`<button type="button" class="delete" @click=${() => this.#delete()}>Delete</button>
                <button type="button" class="done" @click=${() => this.#done()}>Done</button>`
            : html`<button type="button" class="close" @click=${() => this.#done()}>Close</button>`}
        </div>
      </div>
    </div>`;
  }

  // The shown day's wheels; a new one not kept yet stands last, where it will stand once kept,
  // so the sheet keeps its place and the keyboard when the fact first announces it.
  #items(context) {
    const { draft } = context;
    const kept = dayWheels(context);
    return draft && !kept.some((w) => w.id === draft.id) ? [...kept, draft] : kept;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    this.#wanted.clear();
    const { context } = snapshot;
    const items = this.#items(context);
    const failed = snapshot.matches("failed");
    if (!failed && !items.length) return nothing;
    return html`<section tabindex="-1" aria-label="Wheel of Life">
      <h3>Wheel of Life</h3>
      ${failed
        ? html`<p class="empty">The Wheel of Life is unavailable.</p>`
        : html`<div class="list" @keydown=${this.#key} @pointerdown=${this.#press}>
            ${items.map((w) => (context.draft?.id === w.id ? this.#sheet(context, context.draft) : this.#card(w)))}
          </div>`}
    </section>`;
  }
}

customElements.define("wheel-sheet", WheelSheet);
