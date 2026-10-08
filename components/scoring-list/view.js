import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine, when } from "./machine.js";
import selected from "./events/scoring.selected.json" with { type: "json" };
import discarded from "./events/scoring.discarded.json" with { type: "json" };

// The band words, the same as on the cards, so a colour always comes with a word.
const BAND = { high: "High", mixed: "Mixed", low: "Low" };

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo window;
// the token is the one clock.
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), undoMs },
      events: { "scoring.selected": selected, "scoring.discarded": discarded },
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

class ScoringList extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
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
      align-items: flex-start;
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
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .row[aria-selected="true"] {
      background: var(--color-accent-subtle);
    }
    .text {
      flex: 1;
      min-width: 0;
    }
    .post {
      display: block;
      color: var(--color-body);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .post.untitled {
      color: var(--color-mute);
    }
    .bands {
      display: flex;
      flex-wrap: wrap;
      column-gap: var(--space-xs);
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
    }
    .high {
      color: var(--color-success);
    }
    .mixed {
      color: var(--color-warning);
    }
    .low {
      color: var(--color-danger);
    }
    /* The time and the bin share one cell, so the bin appears in place on hover or
       focus without shifting the row. */
    .trailing {
      flex: none;
      display: grid;
      justify-items: end;
    }
    .time,
    .bin {
      grid-area: 1 / 1;
    }
    .time {
      font-size: var(--text-caption);
      color: var(--color-mute);
      white-space: nowrap;
    }
    .bin {
      display: inline-flex;
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      margin: 0;
      font: inherit;
      cursor: pointer;
      color: var(--color-body-mid);
      visibility: hidden;
    }
    .bin svg {
      display: block;
    }
    .row:hover .bin,
    .row:focus-within .bin,
    .row:focus .bin {
      visibility: visible;
    }
    .row:hover .time,
    .row:focus-within .time,
    .row:focus .time {
      visibility: hidden;
    }
    .bin:hover {
      color: var(--color-danger);
    }
    .bin:focus-visible,
    .undo:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .row.deleting {
      cursor: default;
    }
    .row.deleting .post {
      color: var(--color-mute);
      text-decoration: line-through;
    }
    .undo {
      flex: none;
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      color: var(--color-accent);
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

  #focusRow(rows, open) {
    const has = (id) => rows.some((r) => r.id === id);
    if (this.#focusId && has(this.#focusId)) return this.#focusId;
    if (open && has(open)) return open;
    return rows[0]?.id ?? null;
  }

  #keydown(event, rows) {
    if (event.target.closest("button")) return;
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
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      this.#actor.send({ type: "_delete", id: current });
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
    if (snapshot.matches("failed")) return html`<p class="empty">History unavailable.</p>`;
    const { scorings, open, deleting } = snapshot.context;
    if (!scorings.length) return html`<p class="empty">No scores yet</p>`;
    const focusId = this.#focusRow(scorings, open);
    const now = Date.now();
    return html`
      <ul class="list" role="listbox" aria-label="History" @keydown=${(e) => this.#keydown(e, scorings)}>
        ${scorings.map((s) => this.#row(s, open, focusId, deleting.has(s.id), now))}
      </ul>
    `;
  }

  #row(s, open, focusId, isDeleting, now) {
    const first = s.text.trim();
    const bands = s.gauges.filter((g) => g.band);
    return html`
      <li
        class="row ${isDeleting ? "deleting" : ""}"
        role="option"
        data-id=${s.id}
        aria-selected=${s.id === open}
        tabindex=${s.id === focusId ? 0 : -1}
        @click=${() => this.#pick(s.id)}
      >
        <span class="text">
          <span class="post ${first ? "" : "untitled"}">${first || "Empty post"}</span>
          ${bands.length
            ? html`<span class="bands">${bands.map((g) => html`<span class=${g.band} title=${g.name}>${BAND[g.band]}</span>`)}</span>`
            : nothing}
        </span>
        ${isDeleting
          ? html`<button
              class="undo"
              type="button"
              @click=${(e) => {
                e.stopPropagation();
                this.#actor.send({ type: "_undo", id: s.id });
              }}
            >
              Deleted · Undo
            </button>`
          : html`<span class="trailing"
              ><span class="time">${when(s.at, now)}</span
              ><button
                class="bin"
                type="button"
                tabindex="-1"
                aria-label="Delete this score"
                @click=${(e) => {
                  e.stopPropagation();
                  this.#actor.send({ type: "_delete", id: s.id });
                }}
              >
                ${icon("trash-simple")}
              </button></span
            >`}
      </li>
    `;
  }
}

customElements.define("scoring-list", ScoringList);
