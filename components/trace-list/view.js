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

// Each recipient's resulting state after delivery (section 10), as id=state; empty
// for a record that carries none (a reply).
const states = (r) =>
  r.states ? Object.entries(r.states).map(([id, state]) => `${id}=${state}`).join(" ") : "";

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
      /* 3.1/7.5: the preview narrows the body, so the host's own width is the
         honest signal for the layout on both the phone preview and a real phone. */
      container-type: inline-size;
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
    /* The disclosure chevron is the signifier that a row opens to its payload,
       so no prose has to say it. It rotates when the row is open. */
    .caret {
      display: inline-block;
      margin-right: var(--space-2xs);
      color: var(--color-mute);
      transition: transform var(--duration-fast) var(--ease);
    }
    .caret::before {
      content: "\\25B8";
    }
    .row.open .caret {
      transform: rotate(90deg);
    }
    /* The long columns wrap at every width (they never fit a phone on one line);
       the short columns stay nowrap. */
    .route,
    .shape,
    .state {
      white-space: normal;
    }
    .state {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
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
    /* Below the width where the eight-column table stops fitting, stack each
       record so it reads without sideways scrolling. 45rem is the table (~660px)
       plus the card and host padding; it is a literal, not a token, because 7.4
       admits only tokens for lengths that place or size a box, and a container
       breakpoint is neither. Range syntax: WebKit ≥ 16.4 and Chromium support it. */
    @container (width < 45rem) {
      thead {
        display: none;
      }
      table,
      tbody {
        display: block;
      }
      table {
        width: 100%;
      }
      /* Lay each record out as three lines with flex order, so the id keeps its
         own width instead of sharing a grid column with the timestamp below it:
         header (#, kind, name, outcome), then route, then a muted meta line. */
      tr.row {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        column-gap: var(--space-sm);
        row-gap: var(--space-2xs);
        padding: var(--space-sm) 0;
        border-bottom: var(--border-width) solid var(--color-border);
      }
      td {
        padding: 0;
        border: 0;
        white-space: normal;
      }
      .num {
        order: 1;
      }
      .kind {
        order: 2;
      }
      .name {
        order: 3;
      }
      .outcome {
        order: 4;
        margin-left: auto;
        text-align: right;
      }
      .route {
        order: 5;
        flex-basis: 100%;
      }
      .state {
        order: 6;
        flex-basis: 100%;
      }
      .time {
        order: 7;
      }
      .tab {
        order: 8;
      }
      .shape {
        order: 9;
      }
      .time,
      .tab,
      .shape {
        font-size: var(--text-caption);
        color: var(--color-body-mid);
      }
      tr.payload,
      tr.payload td {
        display: block;
      }
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
              <th>state</th>
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
      <tr
        class="row ${open ? "open" : ""}"
        aria-expanded=${open}
        @click=${() => this.#actor.send({ type: "_toggle", id })}
      >
        <td class="num"><span class="caret" aria-hidden="true"></span>${r.seq}</td>
        <td class="time">${time(r.at)}</td>
        <td class="tab">${r.tab.slice(-4)}</td>
        <td class="kind">${r.kind}</td>
        <td class="name">${r.name}</td>
        <td class="route">${r.from} → ${recipients(r)}</td>
        <td class="state">${states(r)}</td>
        <td class="outcome">
          <span class=${OUTCOME_CLASS[r.outcome] ?? nothing}>${r.outcome}</span>
          ${r.reason ? html` <span class="reason">${r.reason}</span>` : nothing}
        </td>
        <td class="shape">${summary(r.payload)}</td>
      </tr>
      ${open
        ? html`<tr class="payload">
            <td colspan="9"><pre>${JSON.stringify(r.payload, null, 2)}</pre></td>
          </tr>`
        : nothing}
    `;
  }
}

customElements.define("trace-list", TraceList);
