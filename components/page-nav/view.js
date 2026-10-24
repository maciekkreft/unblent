import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, grouped } from "./machine.js";

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
      outline: none;
      box-shadow: var(--focus-ring);
    }
    a[aria-current="page"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    /* The muted group label; a label preceded by links (any but the first group)
       carries a divider from the group before it. */
    .label {
      color: var(--color-body-mid);
      padding: var(--space-2xs) var(--space-xs);
      white-space: nowrap;
    }
    a ~ .label {
      margin-left: var(--space-xs);
      padding-left: var(--space-md);
      border-left: var(--border-width) solid var(--color-border);
    }
    /* Right-aligned home for page controls slotted into the bar (e.g. layout-switch),
       pushed clear of the links; wraps with them when the row is too narrow. */
    .controls {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
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
    if (snapshot.matches("failed")) return snapshot.context.profile === "product" ? nothing : html`<p class="failed">pages unavailable</p>`;
    const { pages, nav, current, profile } = snapshot.context;
    const groups = grouped(pages, nav, current, profile);
    // With no links (the product profile, §8/§12) and nothing slotted in, the bar
    // takes no space: the page controls live elsewhere (a desk's stage header, 6.4)
    // and the bar returns on its own where there are links to show (the workshop).
    if (!groups.length && !this.children.length) return nothing;
    return html`
      <nav aria-label="Pages">
        ${groups.map(
          (group) => html`
            <span class="label">${group.label}</span>
            ${group.rows.map(
              (p) => html`
                <a href=${p.path} aria-current=${p.path === current ? "page" : nothing}>${p.title}</a>
              `,
            )}
          `,
        )}
        <span class="controls"><slot></slot></span>
      </nav>
    `;
  }
}

customElements.define("page-nav", PageNav);
