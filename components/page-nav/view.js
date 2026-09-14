import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, visible } from "./machine.js";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      // Reading `location` is a read of the document, allowed to a view; the
      // machine only ever receives the value, so it stays importable in Node.
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        current: location.pathname,
      },
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

class PageNav extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    nav {
      display: flex;
      /* Wrap whole links to a new row when the window is too narrow (a phone),
         rather than letting a label break across lines. */
      flex-wrap: wrap;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border-bottom: var(--border-width) solid var(--color-border);
      font-size: var(--text-sm);
    }
    a {
      color: var(--color-body);
      text-decoration: none;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
      white-space: nowrap;
    }
    a:hover {
      background: var(--color-surface-hover);
    }
    a:focus-visible {
      outline: var(--focus-ring);
    }
    a[aria-current="page"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    .failed {
      margin: 0;
      padding: var(--space-sm) var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body);
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loadingPages") || snapshot.matches("loadingSettings")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="failed">pages unavailable</p>`;
    const { pages, nav, current } = snapshot.context;
    return html`
      <nav aria-label="Pages">
        ${visible(pages, nav, current).map(
          (p) => html`
            <a href=${p.path} aria-current=${p.path === current ? "page" : nothing}>${p.title}</a>
          `,
        )}
      </nav>
    `;
  }
}

customElements.define("page-nav", PageNav);
