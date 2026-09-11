import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine } from "./machine.js";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
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
}

// Render order of the contract lists on a card.
const LISTS = ["emits", "consumes", "accepts", "answers", "asks"];

class ComponentList extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: var(--space-xl) var(--space-md);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-2xl) * 5), 1fr));
      gap: var(--space-md);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md);
      border-radius: var(--radius-md);
      background: var(--color-canvas-soft);
      min-width: 0;
    }
    h2 {
      margin: 0;
      font-size: var(--text-subtitle);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      word-break: break-word;
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-xs);
    }
    .badge {
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      color: var(--color-body);
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-full);
      border: var(--border-width) solid var(--color-border);
    }
    /* Built is the norm and goes unsaid (7.3); only a planned component is marked. */
    .badge.planned {
      background: var(--color-accent-subtle);
      color: var(--color-ink);
    }
    .owns {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    dl {
      display: grid;
      grid-template-columns: max-content 1fr;
      gap: var(--space-2xs) var(--space-sm);
      margin: 0;
      font-size: var(--text-sm);
    }
    dt {
      color: var(--color-body-mid);
    }
    dd {
      margin: 0;
      color: var(--color-body);
      word-break: break-word;
    }
    h3 {
      margin: 0;
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
      text-transform: uppercase;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .with {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    .failed {
      font-size: var(--text-body);
      color: var(--color-body);
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="failed">catalog unavailable</p>`;
    return html`<div class="grid">${snapshot.context.components.map(this.#card)}</div>`;
  }

  #card = (c) => html`
    <article class="card">
      <h2>${c.name}</h2>
      <div class="badges">
        ${c.status === "planned" ? html`<span class="badge planned">planned</span>` : nothing}
        <span class="badge">${c.kind}</span>
        ${c.shape ? html`<span class="badge">${c.shape}</span>` : nothing}
      </div>
      ${c.owns ? html`<p class="owns">owns ${c.owns}</p>` : nothing}
      ${this.#lists(c)}
      ${c.interacts.length
        ? html`
            <h3>interacts with</h3>
            <ul>
              ${c.interacts.map(
                (i) => html`<li><span class="with">${i.with}</span> · ${i.how} ${i.via}</li>`,
              )}
            </ul>
          `
        : nothing}
    </article>
  `;

  #lists(c) {
    const rows = LISTS.filter((key) => c[key].length > 0);
    if (!rows.length) return nothing;
    return html`
      <dl>
        ${rows.map((key) => html`<dt>${key}</dt><dd>${c[key].join(", ")}</dd>`)}
      </dl>
    `;
  }
}

customElements.define("component-list", ComponentList);
