import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, tabsOf, shownOf, slottedOf } from "./machine.js";

// The children as the machine reads them: each one's tab label, whether it is the admin's
// alone, the edition it is marked for (`web` or `mac`), and the feature flag that hides it (8). Read from this element's own light DOM,
// never written to.
const childrenOf = (host) =>
  [...host.children].map((c) => ({
    label: c.getAttribute("label") ?? c.localName,
    admin: c.hasAttribute("admin"),
    ...(c.hasAttribute("web") ? { edition: "web" } : c.hasAttribute("mac") ? { edition: "mac" } : {}),
    ...(c.hasAttribute("flag") ? { flag: c.getAttribute("flag") } : {}),
  }));

// The tab picked, kept across reloads (3.1): the view's own UI state, so it follows the
// browser, not the account, and losing it loses nothing. Wrapped like list-then-item's: a
// browser refusing storage reads null and drops the write.
const KEY = "settings-tabs:picked";
const memory = {
  recall() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  remember(label) {
    try {
      if (label) localStorage.setItem(KEY, label);
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the pick lives only for this page.
    }
  },
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        children: childrenOf(this.host),
        picked: memory.recall(),
      },
    });
    let kept = this.actor.getSnapshot().context.picked;
    this.subscription = this.actor.subscribe(({ context }) => {
      if (context.picked !== kept) memory.remember((kept = context.picked));
      this.host.requestUpdate();
    });
    // The composer (3.6) swaps a role element in place; a child list change is the one
    // thing outside the actor that must re-read the children.
    this.observer = new MutationObserver(() => this.actor.send({ type: "_children", children: childrenOf(this.host) }));
    this.observer.observe(this.host, { childList: true });
  }

  hostDisconnected() {
    this.subscription?.unsubscribe();
    this.observer?.disconnect();
    unmount(this.actor);
  }

  get snapshot() {
    return this.actor?.getSnapshot();
  }

  send(event) {
    this.actor?.send(event);
  }
}

class SettingsTabs extends LitElement {
  // Manual slot assignment: every child stays connected, so its actor stays mounted,
  // whether its tab is shown or not. No attribute is written on any child, so the
  // container never touches another component.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, slotAssignment: "manual" };

  static styles = css`
    /* The sheet fills the panel it sits in, so an admin tab's tint covers the whole area. */
    :host {
      display: flex;
      flex-direction: column;
      flex: 1 0 auto;
    }
    .area {
      flex: 1 0 auto;
    }
    /* The tab bar: the names of the sheet's parts, the shown one underlined in the
       accent, the way a section is marked elsewhere on the desk. */
    [role="tablist"] {
      display: flex;
      gap: var(--space-lg);
      padding: var(--space-sm) var(--space-md) 0;
      border-bottom: var(--border-width) solid var(--color-border);
      overflow-x: auto;
    }
    [role="tab"] {
      font: inherit;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      background: none;
      border: 0;
      border-bottom: calc(var(--border-width) * 2) solid transparent;
      padding: var(--space-xs) 0 var(--space-sm);
      white-space: nowrap;
      cursor: pointer;
    }
    [role="tab"]:hover {
      color: var(--color-ink);
    }
    [role="tab"][aria-selected="true"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      border-bottom-color: var(--color-accent);
    }
    /* A tab whose parts are all marked admin, and its area, sit on the admin tint (7.4);
       they are offered only to the admin, so nothing else is ever tinted. */
    [role="tab"].admin {
      background: var(--color-admin-subtle);
      padding-inline: var(--space-xs);
      border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    }
    .area.admin {
      background: var(--color-admin-subtle);
    }
    [role="tab"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
  `;

  #actor = new ActorController(this);

  #state() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return null;
    const { children, admin, picked, hidden, edition } = snapshot.context;
    const tabs = tabsOf(children, admin, hidden, edition);
    // A tab is the admin's when every part offered under it is marked admin.
    const slotted = (label) => slottedOf(children, admin, label, hidden, edition);
    const admins = tabs.filter((label) => slotted(label).every((i) => children[i].admin));
    return {
      tabs,
      admins,
      shown: shownOf(children, admin, picked, hidden, edition),
      slotted: slottedOf(children, admin, picked, hidden, edition),
    };
  }

  // The arrow keys move between the tabs, as in every tab bar; Home and End jump.
  #key(e, tabs, shown) {
    const i = tabs.indexOf(shown);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const label = tabs[(next + tabs.length) % tabs.length];
    this.#actor.send({ type: "_pick", label });
    this.updateComplete.then(() => this.renderRoot.querySelector('[role="tab"][aria-selected="true"]')?.focus());
  }

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: hand it to the shown part.
  focus(options) {
    const first = this.#state()?.slotted[0];
    const child = first === undefined ? null : this.children[first];
    if (child) child.focus(options);
    else super.focus(options);
  }

  render() {
    const state = this.#state();
    if (!state) return nothing;
    const { tabs, admins, shown } = state;
    return html`
      ${tabs.length > 1
        ? html`
            <div role="tablist" aria-label="Settings" @keydown=${(e) => this.#key(e, tabs, shown)}>
              ${tabs.map(
                (label) => html`
                  <button
                    role="tab"
                    class=${admins.includes(label) ? "admin" : ""}
                    aria-selected=${label === shown ? "true" : "false"}
                    tabindex=${label === shown ? "0" : "-1"}
                    @click=${() => this.#actor.send({ type: "_pick", label })}
                  >
                    ${label}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
      <div class="area ${admins.includes(shown) ? "admin" : ""}"><slot></slot></div>
    `;
  }

  updated() {
    const state = this.#state();
    const slot = this.renderRoot.querySelector("slot");
    if (!state || !slot) return;
    const want = state.slotted.map((i) => this.children[i]).filter(Boolean);
    const have = slot.assignedElements();
    if (want.length !== have.length || want.some((el, i) => el !== have[i])) slot.assign(...want);
  }
}

customElements.define("settings-tabs", SettingsTabs);
