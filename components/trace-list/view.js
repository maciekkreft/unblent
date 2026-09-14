import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
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
    // The relative "time ago" column advances without new traffic: a 1 s tick
    // feeds the machine's clock (machine.js `_tick`). The controller owns it, so it
    // starts and stops with the element on the bus.
    this.ticker = setInterval(() => this.send({ type: "_tick", now: Date.now() }), 1000);
  }

  hostDisconnected() {
    clearInterval(this.ticker);
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

// Relative "time ago" from the record's absolute `at` (7.1) and the view's clock,
// so it reads at a glance in the compact layout where the full timestamp does not
// fit. Intl, not a vendored library (section 10, user's choice). A past record is a
// negative offset to RelativeTimeFormat; the largest unit under its next threshold
// wins (seconds < 60, minutes < 60, hours < 24, else days).
const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const ago = (at, now) => {
  const sec = Math.round((at - now) / 1000);
  if (Math.abs(sec) < 60) return rtf.format(sec, "second");
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return rtf.format(min, "minute");
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return rtf.format(hr, "hour");
  return rtf.format(Math.round(hr / 24), "day");
};

// The kind a row reads (4.3, fifth rule): a view emits a gesture, a fact emits a
// fact, so an event splits by the sender's kind; a query and a reply keep their
// kind. A record without `fromKind` (an older tab over the bridge) reads `event`.
const kindLabel = (r) => {
  if (r.kind !== "event") return r.kind;
  if (r.fromKind === "view") return "gesture";
  if (r.fromKind === "fact") return "fact";
  return "event";
};

// Recipients, an ignored one marked with ~ as in the console line (section 10).
const recipients = (r) => r.to.map((t) => (r.ignored.includes(t) ? `~${t}` : t)).join(", ");

// Each recipient's resulting state after delivery (section 10), as id=state; empty
// for a record that carries none (a reply). The record carries each state as a
// JSON string (7.1); here a string state prints bare and a nested one as
// {child: value, …}, so it wraps at its natural points and no single token can
// widen the table past wherever the view is placed.
const stateText = (state) =>
  state && typeof state === "object"
    ? `{${Object.entries(state)
        .map(([k, v]) => `${k}: ${stateText(v)}`)
        .join(", ")}}`
    : String(state);
const parsed = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
// One `id=state` line per recipient, for the expanded panel. A stateless machine
// (e.g. `dock`) reaches its recipients with `{}`; that line carries nothing, so it
// is dropped rather than printing `id={}`.
const stateLines = (r) =>
  r.states
    ? Object.entries(r.states)
        .map(([id, text]) => [id, parsed(text)])
        .filter(([, state]) => !(state && typeof state === "object" && Object.keys(state).length === 0))
        .map(([id, state]) => `${id}=${stateText(state)}`)
    : [];

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
    /* One thin row above the table: the count on the left, Clear on the right.
       Clear empties what is shown, not what the trace fact keeps (3.1): it is the
       console's clear button, and a reload shows the records again. */
    .bar {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .clear {
      font: inherit;
      color: var(--color-body);
      background: none;
      border: 0;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .clear:hover:enabled {
      background: var(--color-surface-hover);
    }
    .clear:focus-visible {
      outline: var(--focus-ring);
    }
    .clear:disabled {
      color: var(--color-mute);
      cursor: default;
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
      display: inline-flex;
      vertical-align: middle;
      margin-right: var(--space-2xs);
      color: var(--color-mute);
      transition: transform var(--duration-fast) var(--ease);
    }
    .row.open .caret {
      transform: rotate(90deg);
    }
    /* The long columns wrap at every width (they never fit a phone on one line);
       the short columns stay nowrap. overflow-wrap lets an unbreakable token (a
       nested state, a long key list) break too, so the table's min-content width
       never exceeds its container: the same table fits wherever the view is
       placed, on its own stem page or on a stage beside a dock. */
    .route,
    .shape,
    .state {
      white-space: normal;
      overflow-wrap: anywhere;
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
    /* Two time cells share one column's worth of meaning: the absolute timestamp
       reads on the desk, the relative "time ago" in the compact layout. Each layout
       shows one and hides the other, so the row never carries both. */
    .ago {
      display: none;
    }
    /* The expanded panel's footer: the absolute time (the compact layout never
       shows it otherwise) and each recipient's resulting state, one per line,
       below the payload JSON. */
    .detail {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      margin-top: var(--space-xs);
      font-size: var(--text-caption);
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
    /* Below the width where the table stops fitting, stack each record so it reads
       without sideways scrolling. 45rem is the table plus the card and host
       padding; it is a literal, not a token, because 7.4 admits only tokens for
       lengths that place or size a box, and a container breakpoint is neither.
       Range syntax: WebKit ≥ 16.4 and Chromium support it. */
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
      /* Lay each record out as two lines with flex order: a header (#, kind, name,
         outcome on the right), then the route and a muted "time ago" below. The
         absolute time and the payload shape drop; the time returns, absolute, when
         the row is expanded (.detail). */
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
      .time,
      .shape {
        display: none;
      }
      .ago {
        display: block;
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
      .ago {
        order: 6;
      }
      .tab {
        order: 7;
      }
      .ago,
      .tab {
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
    const { records, expanded, now } = snapshot.context;
    // The tab column earns its place only when the traffic spans more than one tab
    // (over the bridge, section 12); with a single tab it is noise, so it is left
    // out of both layouts. Expanded-row ids still carry the tab (tab:seq).
    const showTab = new Set(records.map((r) => r.tab)).size > 1;
    return html`
      <article class="card">
        <div class="bar">
          <span class="count">${records.length} records</span>
          <button class="clear" ?disabled=${!records.length} @click=${() => this.#actor.send({ type: "_clear" })}>
            Clear
          </button>
        </div>
        ${records.length ? this.#table(records, expanded, now, showTab) : html`<p class="empty">No traffic yet.</p>`}
      </article>
    `;
  }

  #table(records, expanded, now, showTab) {
    return html`
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th class="num">#</th>
              <th>time</th>
              ${showTab ? html`<th class="tab">tab</th>` : nothing}
              <th>kind</th>
              <th>name</th>
              <th>from → to</th>
              <th>outcome</th>
              <th>payload</th>
            </tr>
          </thead>
          <tbody>
            ${records.map((r) => this.#row(r, expanded, now, showTab))}
          </tbody>
        </table>
      </div>
    `;
  }

  #row(r, expanded, now, showTab) {
    const id = `${r.tab}:${r.seq}`;
    const open = expanded.has(id);
    // The desk table (thead present) spans #, time, [tab], kind, name, route,
    // outcome, shape; the .ago cell is display:none there and does not count.
    const colspan = showTab ? 8 : 7;
    const lines = stateLines(r);
    return html`
      <tr
        class="row ${open ? "open" : ""}"
        aria-expanded=${open}
        @click=${() => this.#actor.send({ type: "_toggle", id })}
      >
        <td class="num"><span class="caret">${icon("caret-right")}</span>#${r.seq}</td>
        <td class="time">${time(r.at)}</td>
        <td class="ago">${ago(r.at, now)}</td>
        ${showTab ? html`<td class="tab">${r.tab.slice(-4)}</td>` : nothing}
        <td class="kind">${kindLabel(r)}</td>
        <td class="name">${r.name}</td>
        <td class="route">${r.from} → ${recipients(r)}</td>
        <td class="outcome">
          <span class=${OUTCOME_CLASS[r.outcome] ?? nothing}>${r.outcome}</span>
          ${r.reason ? html` <span class="reason">${r.reason}</span>` : nothing}
        </td>
        <td class="shape">${summary(r.payload)}</td>
      </tr>
      ${open
        ? html`<tr class="payload">
            <td colspan=${colspan}>
              <pre>${JSON.stringify(r.payload, null, 2)}</pre>
              <div class="detail">
                <span class="at">${time(r.at)}</span>
                ${lines.map((l) => html`<div class="state">${l}</div>`)}
              </div>
            </td>
          </tr>`
        : nothing}
    `;
  }
}

customElements.define("trace-list", TraceList);
