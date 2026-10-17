import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine } from "./machine.js";
import viewasRequested from "./events/viewas.requested.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "viewas.requested": viewasRequested },
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

class ViewasBar extends LitElement {
  static styles = css`
    /* The page is a column one viewport tall (base.css), so the first tag in it sits
       above everything and the rest of the page takes what is left: the bar never
       covers a control, and on the phone it is the top of the phone's screen. */
    :host {
      display: block;
      flex: none;
      position: sticky;
      top: 0;
      z-index: 4;
    }
    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-xs) var(--space-md);
      padding: var(--space-xs) var(--space-md);
      background: var(--color-accent);
      color: var(--color-accent-text);
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    button {
      padding: var(--space-2xs) var(--space-sm);
      border: 0;
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      color: var(--color-ink);
      font: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--color-canvas-soft);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: default;
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    const { viewingAs, leaving } = snapshot?.context ?? {};
    if (!viewingAs) return nothing;
    return html`<div class="bar" role="status">
      <span>Viewing as ${viewingAs} · what you change is changed for them</span>
      <button type="button" ?disabled=${leaving} @click=${() => this.#actor.actor.send({ type: "_back" })}>
        ${leaving ? "Switching…" : "Back to you"}
      </button>
    </div>`;
  }
}

customElements.define("viewas-bar", ViewasBar);
