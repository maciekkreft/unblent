import { LitElement, html, svg, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { machine, band, leaning, errorText, blocked, cost } from "./machine.js";
import read from "./events/gauge.read.json" with { type: "json" };
import scored from "./events/post.scored.json" with { type: "json" };

// The post is UI state worth keeping across a reload (3.1): kept on the device under a
// key beginning with the view's name.
const KEY = "gauge-post.text";
const recall = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const remember = (text) => {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    // No storage: the post lives only for this page.
  }
};

const BAND = { high: "High", mixed: "Mixed", low: "Low" };
// The half-dial's arc, M10 50 A40 40 0 0 1 90 50: half a circle of radius 40.
const ARC = 125.7;

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), recall, remember, mint: ulid, now: () => Date.now() },
      events: { "gauge.read": read, "post.scored": scored },
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

class GaugePost extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      container-type: inline-size;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    .page {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    label.post {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: calc(var(--space-2xl) * 2);
      resize: vertical;
      font: inherit;
      font-size: var(--text-body);
      line-height: var(--leading-normal);
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-sm);
    }
    textarea:focus-visible {
      outline: var(--focus-ring);
    }
    .run {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-sm) var(--space-md);
    }
    button {
      appearance: none;
      font: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm);
      padding: var(--space-xs) var(--space-md);
      border: var(--border-width) solid var(--color-ink);
      background: var(--color-ink);
      color: var(--color-canvas);
    }
    button:disabled {
      cursor: default;
      background: var(--color-surface-active);
      border-color: var(--color-surface-active);
      color: var(--color-body-mid);
    }
    button:focus-visible {
      outline: var(--focus-ring);
    }
    .line {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .line.error {
      color: var(--color-danger);
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-md);
    }
    /* One column once the stage is narrower than two readable cards (the phone). */
    @container (width < 40rem) {
      .cards {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
      box-shadow: var(--shadow-card);
      min-width: 0;
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--space-md);
    }
    h3 {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
      margin: 0;
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .unscored {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-mute);
    }
    .dial {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .dial svg {
      display: block;
      width: calc(var(--space-2xl) * 1.5);
      height: calc(var(--space-2xl) * 0.84);
    }
    .dial .track {
      fill: none;
      stroke: var(--color-border);
    }
    .dial .fill {
      fill: none;
    }
    .high .fill {
      stroke: var(--color-success);
    }
    .mixed .fill {
      stroke: var(--color-warning);
    }
    .low .fill {
      stroke: var(--color-danger);
    }
    .bandword {
      font-size: var(--text-caption);
      font-weight: var(--weight-normal);
    }
    .bandword.high {
      color: var(--color-success);
    }
    .bandword.mixed {
      color: var(--color-warning);
    }
    .bandword.low {
      color: var(--color-danger);
    }
    .headline {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      text-align: center;
      overflow-wrap: anywhere;
    }
    .rows {
      display: grid;
      grid-template-columns: minmax(0, 1fr) calc(var(--space-2xl) * 1.25) calc(var(--space-2xl) * 1.1);
      column-gap: var(--space-sm);
      row-gap: var(--space-xs);
      align-items: center;
      font-size: var(--text-sm);
    }
    .why {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: subgrid;
      align-items: baseline;
      border-top: var(--border-width) solid var(--color-border);
      padding-top: var(--space-xs);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .scale {
      grid-column: 2;
      display: flex;
      justify-content: space-between;
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .label {
      overflow-wrap: anywhere;
      line-height: var(--leading-tight);
    }
    /* The No-to-Yes line: a track with the unsure middle fifth shaded, and a dot at the
       answer. */
    .lean {
      position: relative;
      height: var(--space-md);
    }
    .lean::before,
    .lean::after {
      content: "";
      position: absolute;
      top: 50%;
    }
    .lean::before {
      left: 0;
      right: 0;
      border-top: var(--border-width) solid var(--color-border-strong);
    }
    .lean::after {
      left: 40%;
      width: 20%;
      height: var(--space-sm);
      transform: translateY(-50%);
      background: var(--color-surface-active);
      border-radius: var(--radius-sm);
    }
    .dot {
      position: absolute;
      top: 50%;
      z-index: 1;
      width: var(--space-sm);
      height: var(--space-sm);
      border-radius: var(--radius-full);
      transform: translate(-50%, -50%);
      box-sizing: border-box;
    }
    .word {
      font-size: var(--text-caption);
      white-space: nowrap;
    }
    .yes .dot {
      background: var(--color-success);
    }
    .no .dot {
      background: var(--color-danger);
    }
    .unsure .dot {
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-body-mid);
    }
    .word.yes {
      color: var(--color-success);
    }
    .word.no {
      color: var(--color-danger);
    }
    .word.unsure {
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.hasTag("loading")) return nothing;
    const { text, last, error, shown } = snapshot.context;
    const scoring = snapshot.matches("scoring");
    const why = blocked(snapshot.context);
    let line = nothing;
    if (scoring) line = html`<span class="line">Asking Jev…</span>`;
    else if (error) line = html`<span class="line error">${errorText(error)}</span>`;
    else if (why) line = html`<span class="line">${why}</span>`;
    else if (last)
      line = html`<span class="line"
        >${last.tools} tool${last.tools === 1 ? "" : "s"} · ${last.questions} question${last.questions === 1 ? "" : "s"} in one
        request · ${last.ms} ms · ${cost(last.inputTokens)}</span
      >`;
    return html`
      <div class="page">
        <label class="post">
          Post
          <textarea .value=${text} @input=${(e) => this.#actor.send({ type: "_type", text: e.target.value })}></textarea>
        </label>
        <div class="run">
          <button ?disabled=${scoring || why !== null} @click=${() => this.#actor.send({ type: "_score" })}>
            ${scoring ? "Scoring…" : "Score"}
          </button>
          ${line}
        </div>
        ${shown
          ? html`<div class="cards">${shown.gauges.filter((g) => g.direct != null || g.questions.length).map((g) => this.#card(g))}</div>`
          : html`<p class="unscored">Nothing scored yet. Paste a post and press Score.</p>`}
      </div>
    `;
  }

  // One gauge of the scoring on the stage, as it was when it was scored.
  #card(g) {
    return html`
      <section class="card" data-id=${g.id}>
        <div class="head">
          <h3>${g.name || "Untitled"}</h3>
          ${g.direct != null ? this.#dial(g.direct) : html`<p class="unscored">Add the tool's question to score it</p>`}
        </div>
        ${g.direct != null ? html`<p class="headline">${g.label}</p>` : nothing}
        ${g.questions.length
          ? html`<div class="rows">
              <span class="why"><span>Why, in Jev's reading</span><span class="scale"><span>No</span><span>Yes</span></span></span>
              ${g.questions.map((q) => this.#row(q.label, q.p))}
            </div>`
          : nothing}
      </section>
    `;
  }

  // No number on the dial: the band word says what the reading can bear, and a figure
  // would dress a guess as a measurement.
  #dial(score) {
    const b = band(score);
    return html`<div class="dial ${b}">
      <svg viewBox="0 0 100 56" role="img" aria-label=${BAND[b]}>
        ${svg`<path class="track" d="M10 50 A40 40 0 0 1 90 50" stroke-width="10" stroke-linecap="round"></path>
          <path class="fill" d="M10 50 A40 40 0 0 1 90 50" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${ARC * score} ${ARC}"></path>`}
      </svg>
      <span class="bandword ${b}">${BAND[b]}</span>
    </div>`;
  }

  #row(label, p) {
    const l = leaning(p);
    return html`
      <span class="label">${label}</span>
      <span class="lean ${l.side}"><span class="dot" style="left: ${p * 100}%"></span></span>
      <span class="word ${l.side}">${l.word}</span>
    `;
  }
}

customElements.define("gauge-post", GaugePost);
