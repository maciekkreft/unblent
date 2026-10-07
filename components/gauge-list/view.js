import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, subtitle } from "./machine.js";
import selected from "./events/gauge.selected.json" with { type: "json" };

// The band words, the same on the card and here, so a colour always comes with a word.
const BAND = { high: "High", mixed: "Mixed", low: "Low" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid },
      events: { "gauge.selected": selected },
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

class GaugeList extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      list-style: none;
      margin: 0;
      padding: var(--space-2xs);
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
    .row:focus-visible {
      outline: var(--focus-ring);
    }
    .row[aria-selected="true"] {
      background: var(--color-accent-subtle);
    }
    .text {
      flex: 1;
      min-width: 0;
    }
    .name {
      display: block;
      color: var(--color-body);
      font-weight: var(--weight-semibold);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name.untitled {
      color: var(--color-mute);
      font-weight: var(--weight-normal);
    }
    .name.draft {
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .mark {
      display: inline-flex;
      vertical-align: middle;
      margin-right: var(--space-xs);
    }
    .mark svg {
      display: block;
    }
    .subtitle {
      display: block;
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-mute);
    }
    .band {
      flex: none;
      font-size: var(--text-caption);
    }
    .band.high {
      color: var(--color-success);
    }
    .band.mixed {
      color: var(--color-warning);
    }
    .band.low {
      color: var(--color-danger);
    }
    .empty {
      margin: 0;
      padding: var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);
  // Which row holds the roving tabindex. Ephemeral focus, not a fact.
  #focusId = null;

  #rows(context) {
    return [{ id: context.draft, draft: true }, ...context.gauges];
  }

  #focusRow(rows, open) {
    const has = (id) => rows.some((r) => r.id === id);
    if (this.#focusId && has(this.#focusId)) return this.#focusId;
    if (open && has(open)) return open;
    return rows[0]?.id ?? null;
  }

  #keydown(event, rows) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const current = this.#focusRow(rows, this.#actor.snapshot.context.open);
    if (step) {
      const at = rows.findIndex((r) => r.id === current);
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + step))];
      if (!next || next.id === current) return;
      event.preventDefault();
      this.#focusId = next.id;
      this.requestUpdate();
      this.updateComplete.then(() => this.renderRoot.querySelector(`.row[data-id="${next.id}"]`)?.focus());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.#pick(current);
    }
  }

  #pick(id) {
    if (!id) return;
    this.#focusId = id;
    this.#actor.send({ type: "_pick", id });
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty">Tools unavailable.</p>`;
    const { open } = snapshot.context;
    const rows = this.#rows(snapshot.context);
    const focusId = this.#focusRow(rows, open);
    return html`
      <ul class="list" role="listbox" aria-label="Tools" @keydown=${(e) => this.#keydown(e, rows)}>
        ${rows.map((r) => this.#row(r, open, focusId))}
      </ul>
    `;
  }

  #row(r, open, focusId) {
    const band = r.reading?.band;
    return html`
      <li
        class="row"
        role="option"
        data-id=${r.id}
        aria-selected=${r.id === open}
        tabindex=${r.id === focusId ? 0 : -1}
        @click=${() => this.#pick(r.id)}
      >
        <span class="text">
          ${r.draft
            ? html`<span class="name draft"><span class="mark">${icon("plus")}</span>New tool</span>`
            : html`<span class="name ${r.name ? "" : "untitled"}">${r.name || "Untitled"}</span>
                <span class="subtitle">${subtitle(r)}</span>`}
        </span>
        ${band ? html`<span class="band ${band}">${BAND[band]}</span>` : nothing}
      </li>
    `;
  }
}

customElements.define("gauge-list", GaugeList);
