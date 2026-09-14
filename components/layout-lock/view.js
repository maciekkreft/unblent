import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import locked from "./events/layout.locked.json" with { type: "json" };

// Icon names are literals (7.6), so the icon check can read them: a closed padlock
// for the locked layout, an open one for the unlocked.
const LOCKED = icon("lock");
const UNLOCKED = icon("lock-open");

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "layout.locked": locked },
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

class LayoutLock extends LitElement {
  static styles = css`
    /* Fixed to the window's bottom-left, the mirror of viewport-switch at the
       bottom-right. Visible on touch devices too: a locked layout matters on a
       phone. */
    :host {
      position: fixed;
      inset: auto auto var(--space-md) var(--space-md);
      display: flex;
      padding: var(--space-2xs);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      box-shadow: var(--shadow-card);
      font-size: var(--text-body);
    }
    :host([hidden]) {
      display: none;
    }
    button {
      border: none;
      background: none;
      cursor: pointer;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-full);
      color: var(--color-body);
      display: inline-flex;
      align-items: center;
    }
    button:hover {
      background: var(--color-surface-hover);
      color: var(--color-ink);
    }
    button:focus-visible {
      outline: var(--focus-ring);
    }
    button[aria-pressed="true"] {
      color: var(--color-ink);
    }
    button svg {
      display: block;
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    // No settings on the page means no lock: the switch leaves the page.
    if (snapshot.matches("failed")) {
      this.hidden = true;
      return nothing;
    }
    const { locked, hidden } = snapshot.context;
    // Reflect the settings choice onto this switch's own host, so it leaves the
    // page when hidden (the desk stays locked regardless).
    this.hidden = hidden;
    if (hidden) return nothing;
    const label = locked ? "Unlock the layout" : "Lock the layout";
    return html`
      <button aria-pressed=${locked ? "true" : "false"} aria-label=${label} title=${label}
        @click=${() => this.#actor.send({ type: "_toggle" })}>
        ${locked ? LOCKED : UNLOCKED}
      </button>
    `;
  }
}

customElements.define("layout-lock", LayoutLock);
