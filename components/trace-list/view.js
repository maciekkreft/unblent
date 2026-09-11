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

  send(event) {
    this.actor?.send(event);
  }
}

// hh:mm:ss.mmm from the record's `at` (7.1), the resolution the console line lacks.
const time = (at) => {
  const d = new Date(at);
  const p = (n, len = 2) => String(n).padStart(len, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

// Recipients, an ignored one marked with ~ as in the console line (section 10).
const recipients = (r) => r.to.map((t) => (r.ignored.includes(t) ? `~${t}` : t)).join(", ");

// One cell's worth of a payload: its shape, so a row can be read without opening
// it. Nothing is ∅, a list its length, an object its top-level keys, a scalar
// itself, cut short.
const SCALAR_MAX = 40;
const summary = (payload) => {
  if (payload == null) return "∅";
  if (Array.isArray(payload)) return `${payload.length} items`;
  if (typeof payload === "object") {
    const keys = Object.keys(payload);
    return keys.length ? `{${keys.join(", ")}}` : "∅";
  }
  const text = JSON.stringify(payload);
  return text.length > SCALAR_MAX ? `${text.slice(0, SCALAR_MAX)}…` : text;
};

// An outcome's colour: a delivery is success, a soft failure a warning, a refusal
// danger, an open question muted (the tokens of 7.4).
const OUTCOME_CLASS = {
  delivered: "ok",
  replied: "ok",
  dropped: "warn",
  ignored: "warn",
  unanswered: "warn",
  refused: "danger",
  "no-answerer": "danger",
  "unknown-query": "danger",
  asked: "mute",
};

class TraceList extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: var(--space-xl) var(--space-md);
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
    }
    .lead,
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .scroll {
      overflow-x: auto;
    }
    table {
      border-collapse: collapse;
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    th,
    td {
      text-align: left;
      padding: var(--space-xs) var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      vertical-align: top;
      white-space: nowrap;
    }
    th {
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
    }
    .row {
      cursor: pointer;
    }
    .name {
      color: var(--color-ink);
    }
    .num {
      text-align: right;
      color: var(--color-body-mid);
    }
    .ok {
      color: var(--color-success);
    }
    .warn {
      color: var(--color-warning);
    }
    .danger {
      color: var(--color-danger);
    }
    .mute {
      color: var(--color-mute);
    }
    .reason {
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
      white-space: pre-wrap;
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { records, expanded } = snapshot.context;
    return html`
      <article class="card">
        <h2>Bus traffic</h2>
        <p class="lead">
          Every routing decision the bus made this session, in this tab and the other tabs of
          this origin. Click a row for its payload.
        </p>
        ${records.length ? this.#table(records, expanded) : html`<p class="empty">No traffic yet.</p>`}
      </article>
    `;
  }

  #table(records, expanded) {
    return html`
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="num">#</th>
              <th>time</th>
              <th>tab</th>
              <th>kind</th>
              <th>name</th>
              <th>from → to</th>
              <th>outcome</th>
              <th>payload</th>
            </tr>
          </thead>
          <tbody>
            ${records.map((r) => this.#row(r, expanded))}
          </tbody>
        </table>
      </div>
    `;
  }

  #row(r, expanded) {
    const id = `${r.tab}:${r.seq}`;
    const open = expanded === id;
    return html`
      <tr class="row" @click=${() => this.#actor.send({ type: "_toggle", id })}>
        <td class="num">${r.seq}</td>
        <td>${time(r.at)}</td>
        <td>${r.tab.slice(-4)}</td>
        <td>${r.kind}</td>
        <td class="name">${r.name}</td>
        <td>${r.from} → ${recipients(r)}</td>
        <td>
          <span class=${OUTCOME_CLASS[r.outcome] ?? nothing}>${r.outcome}</span>
          ${r.reason ? html` <span class="reason">${r.reason}</span>` : nothing}
        </td>
        <td>${summary(r.payload)}</td>
      </tr>
      ${open
        ? html`<tr class="payload">
            <td colspan="8"><pre>${JSON.stringify(r.payload, null, 2)}</pre></td>
          </tr>`
        : nothing}
    `;
  }
}

customElements.define("trace-list", TraceList);
