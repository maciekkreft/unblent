import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, rows, kept } from "./machine.js";
import selected from "./events/day.selected.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "day.selected": selected },
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

// The next local midnight after `now`, when "today" moves on and the pills change.
const midnightAfter = (now) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

class JournalDays extends LitElement {
  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // on the first row.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: var(--space-2xs);
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .row {
      appearance: none;
      box-sizing: border-box;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding: var(--space-xs) var(--space-sm);
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      font: inherit;
      text-align: left;
      color: inherit;
      cursor: pointer;
    }
    .row:hover {
      background: var(--color-surface-hover);
    }
    .row:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .row[aria-current="true"] {
      background: var(--color-accent-subtle);
    }
    .top {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-sm);
    }
    .date {
      color: var(--color-ink);
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
    }
    .count {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
      font-variant-numeric: tabular-nums;
    }
    .pill {
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-full);
      background: var(--color-accent);
      color: var(--color-accent-text);
      white-space: nowrap;
    }
    .first {
      font-size: var(--text-sm);
      color: var(--color-body);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .first.none {
      color: var(--color-mute);
      font-style: italic;
    }
    .kept,
    .empty {
      margin: 0;
      padding: var(--space-sm);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .kept {
      border-top: var(--border-width) solid var(--color-border);
    }
  `;

  #actor = new ActorController(this);
  #timer = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }

  // Up and Down move between the rows, as in the other lists.
  #keydown(event) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [...this.renderRoot.querySelectorAll(".row")];
    const next = buttons[buttons.indexOf(this.renderRoot.activeElement) + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty">The journal is unavailable.</p>`;
    const { days, open, signedIn, current } = snapshot.context;
    const now = Date.now();
    // Nobody acts at midnight, so a timer redraws the pills when "today" moves on.
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.requestUpdate(), midnightAfter(now) - now + 1000);
    return html`
      <div class="scroll">
        <ul class="list" aria-label="Days" @keydown=${(e) => this.#keydown(e)}>
          ${rows(days, open, now).map(
            (r) => html`<li>
              <button
                type="button"
                class="row"
                data-day=${r.day ?? "new"}
                aria-current=${r.id === current ? "true" : "false"}
                @click=${() => this.#actor.send({ type: "_pick", id: r.id })}
              >
                <span class="top">
                  <span class="date">${r.date}</span>
                  ${r.pill ? html`<span class="pill">${r.pill}</span>` : html`<span class="count">${r.count} ¶</span>`}
                </span>
                <span class="first ${r.first ? "" : "none"}">${r.first || "Nothing written yet"}</span>
              </button>
            </li>`,
          )}
        </ul>
      </div>
      <p class="kept">${kept(signedIn)}</p>
    `;
  }
}

customElements.define("journal-days", JournalDays);
