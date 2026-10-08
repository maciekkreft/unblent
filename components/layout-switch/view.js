import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import switched from "./events/layout.switched.json" with { type: "json" };

// Icon names are literals (7.6), so the icon check can read them: one glyph for the
// layout, a pressed toggle when arranging is on.
const LAYOUT = icon("layout");

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "layout.switched": switched },
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

class LayoutSwitch extends LitElement {
  static styles = css`
    /* An inline control slotted into page-nav or a desk's stage header (6.4), flush
       with its neighbours rather than a floating pill: no surface of its own, the
       strip carries it. Visible on touch devices too: arranging matters on a phone. */
    :host {
      display: inline-flex;
      align-items: center;
      font-size: var(--text-subtitle);
    }
    :host([hidden]) {
      display: none;
    }
    /* One size for every header button (6.4): a 20px glyph in 8px of padding is 36px
       across, an easy target on a phone, lined up with the gear, the session button
       and the desk's own strip buttons. font-size is set here, not left to the
       button's UA default, so the glyph reads that size in every engine. */
    button {
      border: none;
      background: none;
      cursor: pointer;
      padding: var(--space-sm);
      border-radius: var(--radius-full);
      color: var(--color-body);
      font-size: var(--text-subtitle);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button:hover {
      background: var(--color-surface-hover);
      color: var(--color-ink);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* Pressed = arranging: a lone button whose state must read at a glance, so it
       fills with the accent rather than viewport-switch's fainter surface-active. */
    button[aria-pressed="true"] {
      background: var(--color-accent-subtle);
      color: var(--color-accent-active);
    }
    button svg {
      display: block;
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    // No settings on the page means no arranging: the switch leaves the page.
    if (snapshot.matches("failed")) {
      this.hidden = true;
      return nothing;
    }
    const { arranging, hidden } = snapshot.context;
    // Reflect the settings choice onto this switch's own host, so it leaves the
    // page when hidden (arranging stays off regardless).
    this.hidden = hidden;
    if (hidden) return nothing;
    const label = "Arrange the layout";
    return html`
      <button aria-pressed=${arranging ? "true" : "false"} aria-label=${label} title=${label}
        @click=${() => this.#actor.send({ type: "_toggle" })}>
        ${LAYOUT}
      </button>
    `;
  }
}

customElements.define("layout-switch", LayoutSwitch);
