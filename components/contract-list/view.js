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

// A schema's alternatives: a oneOf lists them, anything else is one shape.
const alternatives = (schema) => (Array.isArray(schema?.oneOf) ? schema.oneOf : [schema]);

// What a property's type reads as in the table: an enum, a const, or a JSON type.
const typeLabel = (prop) => {
  if (!prop || typeof prop !== "object") return "";
  if ("const" in prop) return JSON.stringify(prop.const);
  if (Array.isArray(prop.enum)) return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(prop.oneOf)) return "oneOf";
  if (prop.type) return Array.isArray(prop.type) ? prop.type.join(" | ") : prop.type;
  return "object";
};

class ContractList extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-xl);
      padding: var(--space-xl) var(--space-md);
    }
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    h2 {
      margin: 0;
      font-size: var(--text-heading);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
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
    h3 {
      margin: 0;
      font-size: var(--text-subtitle);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      word-break: break-word;
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
    .shape {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .label {
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
      text-transform: uppercase;
    }
    table {
      border-collapse: collapse;
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    th,
    td {
      text-align: left;
      padding: var(--space-2xs) var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      vertical-align: top;
    }
    th {
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
    }
    .field {
      color: var(--color-ink);
    }
    .req {
      text-align: center;
      color: var(--color-accent);
    }
    .nofields {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    details {
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    summary {
      cursor: pointer;
      color: var(--color-body-mid);
    }
    pre {
      margin: 0;
      overflow-x: auto;
      padding: var(--space-sm);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      font-size: var(--text-caption);
      color: var(--color-body);
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
    if (snapshot.matches("failed")) return html`<p class="failed">contracts unavailable</p>`;
    const { events, queries, commands } = snapshot.context;
    return html`
      ${this.#section("Events", events, this.#event)}
      ${this.#section("Queries", queries, this.#query)}
      ${this.#section("Commands", commands, this.#command)}
    `;
  }

  #section(title, entries, card) {
    return html`
      <section>
        <h2>${title}</h2>
        ${entries.length ? entries.map(card) : html`<p class="empty">none yet</p>`}
      </section>
    `;
  }

  #event = (e) => html`
    <article class="card">
      <h3>${e.name}</h3>
      <dl>
        <dt>owner</dt>
        <dd>${e.owner}</dd>
        <dt>consumers</dt>
        <dd>${e.consumers.length ? e.consumers.join(", ") : "—"}</dd>
      </dl>
      ${this.#shape(null, e.schema)}
      ${this.#raw(e.schema)}
    </article>
  `;

  #query = (q) => html`
    <article class="card">
      <h3>${q.target}: ${q.name}</h3>
      <dl>
        <dt>target</dt>
        <dd>${q.target}</dd>
        <dt>askers</dt>
        <dd>${q.askers.length ? q.askers.join(", ") : "—"}</dd>
      </dl>
      ${this.#shape("payload", q.payload)}
      ${this.#shape("reply", q.reply)}
      ${this.#raw({ payload: q.payload, reply: q.reply })}
    </article>
  `;

  #command = (c) => html`
    <article class="card">
      <h3>${c.target}: ${c.name}</h3>
      <dl>
        <dt>target</dt>
        <dd>${c.target}</dd>
      </dl>
      ${this.#shape("payload", c.payload)}
      ${this.#raw(c.payload)}
    </article>
  `;

  // One table per alternative of a schema; a label names payload or reply.
  #shape(label, schema) {
    return html`
      <div class="shape">
        ${label ? html`<span class="label">${label}</span>` : nothing}
        ${alternatives(schema).map((alt) => this.#table(alt))}
      </div>
    `;
  }

  #table(schema) {
    const properties = schema?.properties ?? {};
    const names = Object.keys(properties);
    if (!names.length) return html`<p class="nofields">no fields</p>`;
    const required = new Set(schema.required ?? []);
    return html`
      <table>
        <thead>
          <tr>
            <th>field</th>
            <th>type</th>
            <th class="req">req</th>
          </tr>
        </thead>
        <tbody>
          ${names.map(
            (name) => html`
              <tr>
                <td class="field">${name}</td>
                <td>${typeLabel(properties[name])}</td>
                <td class="req">${required.has(name) ? "✓" : nothing}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  #raw(value) {
    return html`
      <details>
        <summary>schema</summary>
        <pre>${JSON.stringify(value, null, 2)}</pre>
      </details>
    `;
  }
}

customElements.define("contract-list", ContractList);
