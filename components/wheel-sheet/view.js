import { LitElement, html, svg, css, nothing } from "lit";
import { mount, unmount, ask, send } from "bus";
import { ulid } from "ulid";
import { machine, AREAS, writable, dayWheels, summaryOf, scoreLine, wheelLabel, caption, wantedLabel, sheetKey, rowKey, areaTarget } from "./machine.js";
import saved from "./events/wheel.saved.json" with { type: "json" };
import add from "./commands/add.json" with { type: "json" };

// The view sits in journal-entry's slot, under the day's text inside its scrolling page (the
// product page nests it), so it scrolls with the day it is about. It is drawn like
// choice-point-cards: the same section, card, sheet and buttons.

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
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        send: (target, name, payload) => send(machine, target, name, payload),
        mint: ulid,
        now: () => Date.now(),
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
    /* A sheet and its card have a fixed shape, so on a wide stage they stop at a form's width:
       past it a square would stretch into a long bar, and a score would stand far from its name. */
    .card {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      width: 100%;
      max-width: var(--width-form);
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
    .sum {
      flex: 1;
      min-width: 0;
      display: grid;
      grid-template-columns: 1fr 1fr;
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
      max-width: var(--width-form);
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
    .rate {
      display: flex;
      gap: var(--space-md);
      align-items: flex-start;
    }
    .wheel {
      flex: none;
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
    .w-last {
      fill: none;
      stroke: var(--color-ink);
      stroke-width: 2;
      stroke-linecap: round;
      pointer-events: none;
    }
    .rows {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .area {
      display: grid;
      grid-template-columns: calc(var(--space-xl) + var(--space-md) - var(--space-2xs)) minmax(0, 1fr) calc(var(--space-xl) - var(--space-xs));
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
    /* A narrow page (a phone, or a narrow stage): the wheel stands above the rows, and the
       targets are large enough for a finger. Below this width, beside the wheel, a square
       would be too narrow to press. */
    @container (width < 28rem) {
      .rate {
        flex-direction: column;
        align-items: stretch;
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
  // Whether the keyboard was inside before this render, and whether the last thing the user
  // did here was a press: after a press nothing moves, as a keyboard moved onto text would come
  // up on a phone.
  #holding = false;
  #byPress = false;

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
    const snapshot = this.#actor.snapshot;
    this.toggleAttribute("idle", !snapshot || !(snapshot.matches("failed") || this.#items(snapshot.context).length));
  }

  updated() {
    const context = this.#actor.snapshot?.context;
    if (context && context.landing !== this.#landed) {
      this.#landed = context.landing;
      this.#focusNext = '.area[data-i="0"]';
    }
    if (this.#focusNext) {
      this.renderRoot.querySelector(this.#focusNext)?.focus();
      this.#focusNext = null;
    }
    // What held the keyboard went (a wheel not kept, a delete, an Undo).
    if (this.#holding && !this.#byPress && !this.matches(":focus-within")) this.#actor.send({ type: "_handBack" });
  }

  // Focused by any way, an area is the one the keys act on.
  #focusArea(i, options) {
    this.#actor.send({ type: "_cursor", to: i });
    this.renderRoot.querySelector(`.area[data-i="${i}"]`)?.focus(options);
  }

  // A card takes the keyboard itself; an open sheet on its first area (its last, coming from
  // below), or on Close when it can only be read.
  #focusRow(row, edge) {
    if (!row.classList.contains("sheet")) return row.focus();
    if (row.classList.contains("read")) return row.querySelector(".close")?.focus();
    this.#focusArea(edge === "last" ? AREAS.length - 1 : 0);
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
    if (event.defaultPrevented) return;
    this.#byPress = false;
    const { context } = this.#actor.snapshot;
    const target = event.composedPath()[0];
    const rows = this.#rows();
    const at = rows.findIndex((r) => r.contains(target));
    if (at < 0) return;
    const onSheet = rows[at].classList.contains("sheet");
    const onArea = target.classList?.contains("area") === true;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    // Enter on a button is the button's.
    if (onSheet && (event.key === "Escape" || (event.key === "Enter" && onArea))) {
      take();
      return this.#done();
    }
    const write = onSheet && writable(context);
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const key = (write ? sheetKey : rowKey)(event, context.vimKeys === true, afterG);
    this.#gAt = key?.wait ? Date.now() : 0;
    if (!key) return;
    if (key.wait) return event.preventDefault();
    if (key.step) {
      take();
      this.#actor.send({ type: "_step", more: key.more, wanted: key.wanted });
      return this.#focusArea(this.#actor.snapshot.context.cursor);
    }
    const { move } = key;
    if (write) {
      // From a button of the sheet, up or down first goes to the area the keys act on.
      const stepping = move === "up" || move === "down";
      const to = !onArea && stepping ? context.cursor : areaTarget(move, context.cursor);
      if (to !== "leave") {
        take();
        return this.#focusArea(to);
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

  // An earlier day's sheet takes no score, so it opens with the keyboard on Close.
  #open(id) {
    const write = writable(this.#actor.snapshot.context);
    this.#send({ type: "_open", id }, write ? '.area[data-i="0"]' : ".sheet .close");
  }

  // A press sets the score and leaves the keyboard on that area, without scrolling to it: on a
  // phone the rows may stand below the wheel that was pressed.
  #pick = (area, value) => {
    this.#actor.send({ type: "_press", area, value });
    this.#focusArea(area, { preventScroll: true });
  };

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

  #area(context, draft, name, i, write) {
    return html`<div
      class="area ${write && i === context.cursor ? "cur" : ""}"
      data-i=${i}
      role="group"
      aria-label=${name}
      tabindex=${write ? (i === context.cursor ? "0" : "-1") : nothing}
      @focus=${() => this.#actor.send({ type: "_cursor", to: i })}
    >
      <span>${name}</span>
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

  #sheet(context, draft) {
    const write = writable(context);
    const choice = (mode, label) =>
      html`<button type="button" class=${context.mode === mode ? "on" : ""} aria-pressed=${context.mode === mode ? "true" : "false"} @click=${() => this.#actor.send({ type: "_mode", mode })}>${label}</button>`;
    return html`<div class="sheet ${write ? "" : "read"}" data-id=${draft.id} role="group" aria-label="Wheel of Life">
      ${write ? html`<div class="modes" role="group" aria-label="Which score a click sets">${choice("actual", "Actual")}${choice("wanted", "Wanted")}</div>` : nothing}
      <p class="caption">${caption(context)}</p>
      <div class="rate">
        <svg class="wheel" viewBox="0 0 200 200" role="img" aria-label=${wheelLabel(draft)}>
          ${wheelPaths(draft, write ? { cursor: context.cursor, pick: this.#pick } : {})}
        </svg>
        <div class="rows">${AREAS.map((name, i) => this.#area(context, draft, name, i, write))}</div>
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
