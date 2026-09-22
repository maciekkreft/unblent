import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import switched from "./events/profile.switched.json" with { type: "json" };

// Icon name is a literal (7.6) so the icon check can read it: the toolbox is the
// door into the workshop.
const TOOLBOX = icon("toolbox");

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "profile.switched": switched },
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

class ProfileSwitch extends LitElement {
  static styles = css`
    /* An inline control slotted into page-nav or a desk's stage header (6.4), left
       of the auth icon, flush with the other controls. */
    :host {
      display: inline-flex;
      align-items: center;
      font-size: var(--text-subtitle);
    }
    /* One size for every header button (6.4): a 20px glyph in 8px of padding is 36px
       across, so the door lines up with the gear and the session button and is an
       easy target on a phone. */
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
      outline: var(--focus-ring);
    }
    /* In the product the door is deliberately not a visible signifier (§12): the
       button holds its place — still tappable on touch — but stays transparent until
       hover or keyboard focus reveals it. */
    :host([data-profile="product"]) button {
      opacity: 0;
      transition: opacity var(--duration-fast) var(--ease);
    }
    :host([data-profile="product"]) button:hover,
    :host([data-profile="product"]) button:focus-visible {
      opacity: 1;
    }
    /* In the workshop the way back is always visible and reads as engaged, filled
       with the accent like the layout switch when arranging. */
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
    // No settings on the page (or an older one without a profile): nothing to switch.
    if (snapshot.matches("failed")) return nothing;
    const { profile } = snapshot.context;
    // Reflect the active profile onto this host so the CSS can key on it; writes only
    // to this element, never the document.
    this.setAttribute("data-profile", profile);
    const workshop = profile === "workshop";
    return html`
      <button aria-pressed=${workshop ? "true" : "false"} aria-label="Workshop" title="Workshop"
        @click=${() => this.#actor.send({ type: "_toggle" })}>
        ${TOOLBOX}
      </button>
    `;
  }
}

customElements.define("profile-switch", ProfileSwitch);
