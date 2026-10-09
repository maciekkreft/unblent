import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, onTools, menus, cards, blocked, uses, judging, stopped, errorText } from "./machine.js";
import saved from "./events/case.saved.json" with { type: "json" };
import selected from "./events/case.selected.json" with { type: "json" };
import requested from "./events/judging.requested.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid },
      events: { "case.saved": saved, "case.selected": selected, "judging.requested": requested, "removal.started": started },
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

class CaseEditor extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // in the case's text.
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
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }
    .caption,
    legend {
      padding: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .mute {
      color: var(--color-mute);
    }
    textarea,
    select {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-xs) var(--space-sm);
    }
    textarea {
      resize: vertical;
      field-sizing: content;
      min-height: calc(var(--text-body) * var(--leading-normal) * 3 + var(--space-sm) * 2);
      padding: var(--space-sm);
      line-height: var(--leading-normal);
    }
    textarea::placeholder {
      color: var(--color-mute);
    }
    textarea:focus-visible,
    select:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .answers {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .answer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) calc(var(--space-2xl) * 2.5);
      gap: var(--space-xs) var(--space-md);
      align-items: center;
      font-size: var(--text-sm);
    }
    .answer .q b {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    .run {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-sm) var(--space-md);
    }
    .line {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
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
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button.dark {
      padding: var(--space-xs) var(--space-md);
      border-color: var(--color-ink);
      background: var(--color-ink);
      color: var(--color-canvas);
    }
    button.dark:disabled {
      cursor: default;
      background: var(--color-surface-active);
      border-color: var(--color-surface-active);
      color: var(--color-body-mid);
    }
    button.big {
      align-self: flex-start;
      font-size: var(--text-subtitle);
      padding: var(--space-sm) var(--space-lg);
      border-radius: var(--radius-md);
    }
    button.quiet {
      border-color: transparent;
      background: transparent;
      color: var(--color-body);
    }
    button.quiet:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    .actions {
      display: flex;
      justify-content: flex-end;
    }
    .error {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .progress {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .track {
      position: relative;
      height: calc(var(--space-xs) + var(--space-2xs));
      border-radius: var(--radius-full);
      background: var(--color-surface-active);
      overflow: hidden;
    }
    /* One case is one request: there is no share to show, so the fill slides. */
    .track .fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: 40%;
      border-radius: var(--radius-full);
      background: var(--color-accent);
      animation: slide calc(var(--duration-slide) * 4) var(--ease) infinite;
    }
    @keyframes slide {
      from {
        left: -40%;
      }
      to {
        left: 100%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .track .fill {
        animation: none;
        width: 60%;
      }
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-md);
      align-items: start;
    }
    @container (width < 40rem) {
      .cards {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    @container (width < 28rem) {
      .answer {
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
    .card h3 {
      margin: 0;
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      line-height: var(--leading-tight);
    }
    .qblock {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      border-top: var(--border-width) solid var(--color-border);
      padding-top: var(--space-sm);
    }
    .qtext {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .pickline {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: var(--space-2xs) var(--space-sm);
    }
    .pick {
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      line-height: var(--leading-tight);
    }
    .sure {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .verdict {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      font-size: var(--text-sm);
    }
    .verdict.right {
      color: var(--color-success);
    }
    .verdict.wrong {
      color: var(--color-danger);
    }
    .opts {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) calc(var(--space-xl) + var(--space-sm));
      gap: var(--space-2xs) var(--space-sm);
      align-items: center;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
      font-variant-numeric: tabular-nums;
    }
    .pct {
      text-align: right;
      white-space: nowrap;
    }
    .bar {
      height: calc(var(--space-xs) + var(--space-2xs));
      border-radius: var(--radius-full);
      background: var(--color-surface-active);
      overflow: hidden;
    }
    .bar > i {
      display: block;
      height: 100%;
      border-radius: var(--radius-full);
      background: var(--color-mute);
    }
    .yn {
      display: grid;
      grid-template-columns: minmax(0, 1fr) calc(var(--space-2xl) + var(--space-sm)) calc(var(--space-xl) + var(--space-sm) + var(--space-xs));
      gap: var(--space-xs) var(--space-sm);
      align-items: center;
      font-size: var(--text-sm);
    }
    .yn .label {
      line-height: var(--leading-tight);
      color: var(--color-body);
    }
    .yn .pct {
      font-size: var(--text-caption);
      font-variant-numeric: tabular-nums;
      color: var(--color-body-mid);
    }
    .yn .bar > i {
      background: var(--color-body-mid);
    }
    .yn .bar.yes > i {
      background: var(--color-success);
    }
    .yn .bar.no > i {
      background: var(--color-danger);
    }
    .yn .rowsep {
      grid-column: 1 / -1;
      border-top: var(--border-width) solid var(--color-border);
    }
  `;

  #actor = new ActorController(this);

  #send(event) {
    this.#actor.send(event);
  }

  // New case puts the keyboard in the text of the case it opens, once it shows.
  #focusText = false;

  #new() {
    this.#focusText = true;
    this.#send({ type: "_new" });
  }

  updated() {
    const text = this.renderRoot.querySelector("textarea.text");
    if (this.#focusText && text) {
      this.#focusText = false;
      text.focus();
    }
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty page">Cases unavailable.</p>`;
    const { context } = snapshot;
    const { draft, current, cases, rubrics, decisions, run } = context;
    if (!draft) return this.#none(cases.some((c) => c.project === current && !c.removing));
    const tools = onTools(rubrics, current);
    const rows = menus(tools, draft.answers);
    const why = blocked(context);
    // While this case is judged, the progress under the button says so, and the line
    // beside it keeps naming the tools.
    const going = judging(run, current, draft.id);
    const error = going ? null : stopped(run, current, draft.id);
    const stored = cases.some((c) => c.id === draft.id);
    return html`
      <div class="scroll">
        <div class="page" @focusout=${() => this.#send({ type: "_blur" })}>
          <label class="field">
            <span class="caption">Text</span>
            <textarea
              class="text"
              placeholder="Write or paste the text to judge"
              .value=${draft.text}
              @input=${(e) => this.#send({ type: "_edit", text: e.target.value })}
            ></textarea>
          </label>
          ${rows.length
            ? html`<fieldset class="field">
                <legend>Right answers <span class="mute">(optional)</span></legend>
                <div class="answers">${rows.map((m) => this.#menu(m))}</div>
              </fieldset>`
            : nothing}
          <div class="run">
            <button type="button" class="dark judge" ?disabled=${why !== null} @click=${() => this.#send({ type: "_judge" })}>Judge</button>
            <span class="line">${going || why === null ? uses(rubrics, current) : why}</span>
          </div>
          ${error ? html`<p class="error" role="status">${errorText(error)}</p>` : nothing}
          ${this.#verdicts(tools, decisions, draft, going)}
          ${stored
            ? html`<div class="actions">
                <button type="button" class="quiet delete" @click=${() => this.#send({ type: "_delete" })}>Delete case</button>
              </div>`
            : nothing}
        </div>
      </div>
    `;
  }

  #none(hasCases) {
    return html`
      <div class="scroll">
        <div class="page">
          <p class="empty">
            ${hasCases
              ? "Pick a case in Cases, or make a new one."
              : "No cases yet. A case is a piece of text you want judged, with the answer you expect."}
          </p>
          <button type="button" class="dark big new" @click=${() => this.#new()}>New case</button>
        </div>
      </div>
    `;
  }

  // The property, not the attribute: once the user has picked an option by hand, the
  // browser ignores that option's selected attribute, so a case opened later would show
  // the wrong right answer.
  #menu(m) {
    return html`
      <div class="answer">
        <span class="q"><b>${m.tool}</b> · ${m.question}</span>
        <select
          aria-label="Right answer for: ${m.question}"
          data-id=${m.id}
          @change=${(e) => this.#send({ type: "_answer", id: m.id, value: e.target.value })}
        >
          <option value="" .selected=${m.value === ""}>No right answer</option>
          ${m.choices.map((c) => html`<option value=${c.value} .selected=${m.value === c.value}>${c.label}</option>`)}
        </select>
      </div>
    `;
  }

  #verdicts(tools, decisions, draft, going) {
    if (!tools.length) return nothing;
    if (going)
      return html`<div class="progress" role="status">
        <span>Judging this case…</span>
        <div class="track"><div class="fill"></div></div>
      </div>`;
    const shown = cards(tools, decisions, draft);
    if (!shown) return html`<p class="empty">Not judged yet. Press Judge to see what Jev says.</p>`;
    return html`<div class="cards">${shown.map((c) => this.#card(c))}</div>`;
  }

  #card(c) {
    return html`
      <article class="card" data-id=${c.id}>
        <h3>${c.name}</h3>
        ${c.picks.map((q) => this.#pick(q))} ${c.yesnos.length ? this.#yesnos(c.yesnos) : nothing}
      </article>
    `;
  }

  #mark(m) {
    if (!m) return nothing;
    return m.right
      ? html`<span class="verdict right">${icon("check")} Right</span>`
      : html`<span class="verdict wrong">${icon("x")} Right answer: ${m.answer}</span>`;
  }

  #pick(q) {
    if (!q.block)
      return html`<div class="qblock">
        <p class="qtext">${q.text}</p>
        <p class="empty">Not judged yet.</p>
      </div>`;
    const b = q.block;
    return html`
      <div class="qblock pickq">
        <p class="qtext">${q.text}</p>
        <div class="pickline">
          <span class="pick">${b.pick}</span><span class="sure">${b.sure}% sure</span>${this.#mark(b.mark)}
        </div>
        <div class="opts">
          ${b.others.map(
            (o) => html`<span>${o.name}</span>
              <div class="bar"><i style="width: ${o.pct}%"></i></div>
              <span class="pct">${o.pct}%</span>`,
          )}
        </div>
      </div>
    `;
  }

  // The yes / no rows sit in one grid, so their bars line up; a mark is the icon alone,
  // named for a screen reader and on hover, as there is no room for the words.
  #yesnos(rows) {
    return html`
      <div class="qblock">
        <div class="yn">
          ${rows.map((q, i) => {
            const sep = i ? html`<span class="rowsep"></span>` : nothing;
            if (!q.row) return html`${sep}<span class="label">${q.text}</span><span></span><span class="pct">Not judged</span>`;
            const m = q.row.mark;
            const v = !m
              ? nothing
              : m.right
                ? html` <span class="verdict right" title="Right" aria-label="Right">${icon("check")}</span>`
                : html` <span class="verdict wrong" title="Right answer: ${m.answer}" aria-label="Right answer: ${m.answer}">${icon("x")}</span>`;
            return html`${sep}<span class="label">${q.text}${v}</span>
              <div class="bar ${q.row.tone}"><i style="width: ${q.row.pct}%"></i></div>
              <span class="pct">${q.row.pct}% yes</span>`;
          })}
        </div>
      </div>
    `;
  }
}

customElements.define("case-editor", CaseEditor);
