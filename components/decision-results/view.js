import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine, blocks, progress, emptyLine } from "./machine.js";
import selected from "./events/case.selected.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "case.selected": selected },
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

class DecisionResults extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // on the first miss.
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
    }
    .page {
      box-sizing: border-box;
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
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
      height: calc(var(--space-xs) + var(--space-2xs));
      border-radius: var(--radius-full);
      background: var(--color-surface-active);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: var(--color-accent);
      border-radius: var(--radius-full);
      transition: width var(--duration-fast) linear;
    }
    .blocks {
      display: flex;
      flex-direction: column;
      gap: var(--space-xl);
    }
    /* While a run is going the old results stay readable but are clearly not current. */
    .blocks.dim {
      opacity: 0.45;
    }
    hr {
      margin: 0;
      border: 0;
      border-top: var(--border-width) solid var(--color-border);
    }
    .block,
    .section {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .block {
      gap: var(--space-md);
    }
    .summary {
      font-size: var(--text-heading);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      line-height: var(--leading-tight);
      font-variant-numeric: tabular-nums;
    }
    .qtext {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .qtext b {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    h4 {
      margin: 0;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .groups {
      display: grid;
      grid-template-columns: calc(var(--space-2xl) + var(--space-sm)) minmax(0, 1fr) calc(var(--space-2xl) + var(--space-sm));
      gap: var(--space-xs) var(--space-sm);
      align-items: center;
      max-width: calc(var(--space-2xl) * 7.5);
      font-size: var(--text-sm);
      font-variant-numeric: tabular-nums;
    }
    .groups .n {
      text-align: right;
      color: var(--color-body-mid);
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
      background: var(--color-accent);
    }
    .bar.good > i {
      background: var(--color-success);
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      border-collapse: collapse;
      font-size: var(--text-sm);
      font-variant-numeric: tabular-nums;
    }
    th,
    td {
      padding: var(--space-xs) var(--space-sm);
      text-align: center;
      border: var(--border-width) solid var(--color-border);
    }
    th {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      background: var(--color-canvas-soft);
    }
    th.rowh {
      text-align: left;
    }
    th.corner {
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
      text-align: left;
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
    }
    td {
      min-width: calc(var(--space-xl) + var(--space-md));
      color: var(--color-body);
    }
    td.hit {
      background: var(--color-success-subtle);
      color: var(--color-success);
      font-weight: var(--weight-semibold);
    }
    td.miss {
      background: var(--color-danger-subtle);
      color: var(--color-danger);
      font-weight: var(--weight-semibold);
    }
    td.zero {
      color: var(--color-mute);
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
    }
    .row:hover {
      background: var(--color-surface-hover);
    }
    .row:has(.open:focus-visible) {
      box-shadow: var(--focus-ring);
    }
    .mark {
      flex: none;
      display: inline-flex;
      justify-content: center;
      width: calc(var(--text-body) * 1.25);
      font-size: var(--text-body);
      color: var(--color-danger);
    }
    /* The row's text is its open button, so a miss is one tab stop. */
    .open {
      flex: 1;
      min-width: 0;
      display: block;
      font: inherit;
      text-align: left;
      color: inherit;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
    }
    .open:focus-visible {
      outline: none;
    }
    .name {
      display: block;
      color: var(--color-ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sub {
      display: block;
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty page">Results unavailable.</p>`;
    const { context } = snapshot;
    const shown = blocks(context);
    const going = progress(context.run, context.current);
    const empty = emptyLine(context, shown);
    return html`
      <div class="scroll">
        <div class="page">
          ${going
            ? html`<div class="progress" role="status">
                <span>${going.text}</span>
                <div class="track"><div class="fill" style="width: ${going.share * 100}%"></div></div>
              </div>`
            : nothing}
          ${empty
            ? html`<p class="empty">${empty}</p>`
            : html`<div class="blocks ${going ? "dim" : ""}">
                ${shown.map((b, i) => html`${i ? html`<hr />` : nothing}${this.#block(b)}`)}
              </div>`}
        </div>
      </div>
    `;
  }

  #block(b) {
    return html`
      <section class="block" data-id=${b.id}>
        <div class="section">
          <span class="summary">${b.right} of ${b.total} right</span>
          <p class="qtext"><b>${b.tool}</b> · ${b.question}</p>
        </div>
        <div class="section">
          <h4>By right answer</h4>
          <div class="groups">
            ${b.groups.map(
              (g) => html`<span>${g.name}</span>
                <div class="bar ${g.right === g.total ? "good" : ""}"><i style="width: ${(g.right / g.total) * 100}%"></i></div>
                <span class="n">${g.right} of ${g.total}</span>`,
            )}
          </div>
        </div>
        <div class="section">
          <h4>What Jev picked</h4>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th class="corner">Right answer ↓<br />Jev picked →</th>
                  ${b.names.map((n) => html`<th scope="col">${n}</th>`)}
                </tr>
              </thead>
              <tbody>
                ${b.names.map(
                  (n, i) => html`<tr>
                    <th class="rowh" scope="row">${n}</th>
                    ${b.grid[i].map((v, j) => html`<td class=${v === 0 ? "zero" : i === j ? "hit" : "miss"}>${v}</td>`)}
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div class="section">
          <h4>Misses (${b.misses.length})</h4>
          ${b.misses.length
            ? html`<ul class="list">
                ${b.misses.map(
                  (m) => html`<li class="row miss-row" data-case=${m.id} @click=${() => this.#actor.send({ type: "_open", id: m.id })}>
                    <span class="mark" aria-hidden="true">${icon("x")}</span>
                    <button class="open" type="button">
                      <span class="name">${m.text}</span>
                      <span class="sub">${m.line}</span>
                    </button>
                  </li>`,
                )}
              </ul>`
            : html`<p class="empty">No misses.</p>`}
        </div>
      </section>
    `;
  }
}

customElements.define("decision-results", DecisionResults);
