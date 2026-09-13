import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine } from "./machine.js";
import selected from "./events/viewport.selected.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "viewport.selected": selected },
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

const VIEWPORTS = [
  { id: "desk", label: "Desk" },
  { id: "phone", label: "Phone" },
];

class ViewportSwitch extends LitElement {
  static styles = css`
    /* Fixed to the window's bottom-right so it stays outside the phone frame
       base.css draws (7.5). Hidden on a touch device: a phone never previews a
       phone, matching the (pointer: fine) guard in base.css. */
    :host {
      position: fixed;
      inset: auto var(--space-md) var(--space-md) auto;
      display: flex;
      gap: var(--space-2xs);
      padding: var(--space-2xs);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      box-shadow: var(--shadow-card);
      font-size: var(--text-sm);
    }
    button {
      border: none;
      background: none;
      cursor: pointer;
      padding: var(--space-2xs) var(--space-md);
      border-radius: var(--radius-full);
      font-family: inherit;
      font-size: inherit;
      color: var(--color-body);
    }
    button:hover {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: var(--focus-ring);
    }
    button[aria-pressed="true"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      background: var(--color-surface-active);
    }
    @media (pointer: coarse) {
      :host {
        display: none;
      }
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || !snapshot.matches("ready")) return nothing;
    const { viewport } = snapshot.context;
    return html`
      ${VIEWPORTS.map(
        (v) => html`
          <button
            aria-pressed=${v.id === viewport ? "true" : "false"}
            @click=${() => this.#actor.send({ type: "_select", viewport: v.id })}
          >
            ${v.label}
          </button>
        `,
      )}
    `;
  }
}

customElements.define("viewport-switch", ViewportSwitch);
