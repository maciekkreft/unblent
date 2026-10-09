import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, rows, subtitle } from "./machine.js";
import selected from "./events/rubric.selected.json" with { type: "json" };
import switched from "./events/rubric.switched.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid },
      events: { "rubric.selected": selected, "rubric.switched": switched },
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

class RubricList extends LitElement {
  // A panel's focus lands in what it shows (list-then-item, dock-desk): delegating it
  // puts the keyboard on the first row.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
    }
    .list {
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
    .row:has(.open:focus-visible) {
      box-shadow: var(--focus-ring);
    }
    .row.current {
      background: var(--color-accent-subtle);
    }
    input[type="checkbox"] {
      flex: none;
      width: calc(var(--space-md) + var(--space-2xs));
      height: calc(var(--space-md) + var(--space-2xs));
      margin: 0;
      accent-color: var(--color-accent);
      cursor: pointer;
    }
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The row's name is its open button: the whole text area opens the tool, the tick
       box beside it only switches it. */
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
      color: var(--color-body);
      font-weight: var(--weight-semibold);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name.off {
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .name.untitled {
      color: var(--color-mute);
      font-weight: var(--weight-normal);
    }
    .name.draft {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .name.draft svg {
      font-size: var(--text-body);
    }
    .sub {
      display: block;
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-body-mid);
    }
    .hint,
    .empty {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .hint {
      padding: 0 var(--space-sm) var(--space-md);
    }
    .empty {
      padding: var(--space-xs) var(--space-sm);
      font-size: var(--text-sm);
    }
  `;

  #actor = new ActorController(this);

  #pick(id) {
    this.#actor.send({ type: "_pick", id });
  }

  // A click anywhere on a row opens it, except on its tick box, which only switches.
  #rowClick(event, id) {
    if (event.target.closest?.('input[type="checkbox"]')) return;
    this.#pick(id);
  }

  // Up and Down move between the rows' open buttons, as in the other lists.
  #keydown(event) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [...this.renderRoot.querySelectorAll(".open")];
    const at = buttons.findIndex((b) => b === this.renderRoot.activeElement || b.parentElement.contains(this.renderRoot.activeElement));
    const next = buttons[at + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty">Tools unavailable.</p>`;
    const { draft, open, rubrics, current } = snapshot.context;
    const tools = rows(rubrics, current);
    return html`
      <ul class="list" aria-label="Tools" @keydown=${(e) => this.#keydown(e)}>
        <li class="row new" @click=${(e) => this.#rowClick(e, draft)}>
          <button class="open" type="button">
            <span class="name draft">${icon("plus")}New tool</span>
          </button>
        </li>
        ${tools.map((t) => this.#row(t, open))}
      </ul>
      ${tools.length
        ? html`<p class="hint">Only tools with a tick are used when judging.</p>`
        : html`<p class="empty">No tools yet. Use New tool to write the questions Jev should answer.</p>`}
    `;
  }

  #row(t, open) {
    const name = t.name.trim();
    return html`
      <li class="row ${t.id === open ? "current" : ""}" data-id=${t.id} @click=${(e) => this.#rowClick(e, t.id)}>
        <input
          type="checkbox"
          .checked=${t.on}
          aria-label="Use ${name || "Untitled tool"} when judging"
          @change=${(e) => this.#actor.send({ type: "_switch", id: t.id, on: e.target.checked })}
        />
        <button class="open" type="button" aria-current=${t.id === open ? "true" : nothing}>
          <span class="name ${name ? (t.on ? "" : "off") : "untitled"}">${name || "Untitled tool"}</span>
          <span class="sub">${subtitle(t)}</span>
        </button>
      </li>
    `;
  }
}

customElements.define("rubric-list", RubricList);
