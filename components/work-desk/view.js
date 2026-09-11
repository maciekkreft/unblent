import { LitElement, html, css, nothing } from "lit";
import { mount, unmount } from "bus";
import { machine } from "./machine.js";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // The children are what the page put on the desk (8); reading them is a
    // read of this element's own light DOM, and the machine only sees names.
    this.actor = mount(machine, {
      input: { views: [...this.host.children].map((child) => child.localName) },
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

class WorkDesk extends LitElement {
  // Manual slot assignment: every child stays connected, so its actor stays
  // mounted, but only the open one is rendered. No attribute is written on any
  // child, so the desk never touches another component.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, slotAssignment: "manual" };

  static styles = css`
    :host {
      display: block;
    }
    nav {
      display: flex;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border-bottom: var(--border-width) solid var(--color-border);
      font-size: var(--text-sm);
    }
    button {
      font: inherit;
      color: var(--color-body);
      background: none;
      border: 0;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    button:hover {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: var(--focus-ring);
    }
    button[aria-current="page"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
  `;

  #actor = new ActorController(this);

  #open(name) {
    this.#actor.actor.send({ type: "_open", name });
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { views, open } = snapshot.context;
    return html`
      <nav aria-label="Desk">
        ${views.map(
          (name) => html`
            <button aria-current=${name === open ? "page" : nothing} @click=${() => this.#open(name)}>
              ${name}
            </button>
          `,
        )}
      </nav>
      <main><slot></slot></main>
    `;
  }

  updated() {
    const open = this.#actor.snapshot?.context.open;
    const slot = this.renderRoot.querySelector("slot");
    const child = [...this.children].find((c) => c.localName === open);
    slot?.assign(...(child ? [child] : []));
  }
}

customElements.define("work-desk", WorkDesk);
