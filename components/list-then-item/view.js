import { LitElement, html, css, nothing } from "lit";
import { mount, unmount } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";

// A child's address (4.1): its role or tag name, with `#id` when the page gave it one,
// so a composer swap (3.6) keeps the shown state (the chosen member carries data-role)
// and two instances of a view stay distinct.
const addressOf = (child) =>
  (child.getAttribute("data-role") ?? child.localName) + (child.id ? "#" + child.id : "");

// The shown child, kept across reloads (3.1): the view's own UI state under a key named
// for this component and its instance id, so it follows the browser, not the account,
// and losing it loses nothing. Wrapped like note-editor's stores: a browser refusing
// storage reads null and drops the write.
const key = (id) => "list-then-item:" + (id || "");
const memory = {
  recall(id) {
    try {
      return localStorage.getItem(key(id));
    } catch {
      return null;
    }
  },
  remember(id, name) {
    try {
      if (name) localStorage.setItem(key(id), name);
      else localStorage.removeItem(key(id));
    } catch {
      // No persistence available; the shown child lives only for this page.
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
    const children = this.host.children_();
    // 4.1: a container can be on a page more than once (Books and Notes), so it mounts
    // and asks under its tag `id`; a page without a second instance gives none.
    this.actor = mount(machine, {
      input: { ...children, shown: memory.recall(this.host.id) },
      instance: this.host.id || undefined,
    });
    this.subscription = this.actor.subscribe(() => {
      this.host.requestUpdate();
      memory.remember(this.host.id, this.actor.getSnapshot().context.shown);
    });
    // The composer (3.6) swaps a role element in place; a child list change is the one
    // thing outside the actor that must re-read the children (6.4).
    this.observer = new MutationObserver(() => {
      const c = this.host.children_();
      this.actor.send({ type: "_children", list: c.list, items: c.items });
    });
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

class ListThenItem extends LitElement {
  // Manual slot assignment: every child stays connected, so its actor stays mounted,
  // whether it is the shown one or behind it. No attribute is written on any child, so
  // the container never touches another component.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, slotAssignment: "manual" };

  // The one attribute the tag understands (6.4): `height="fill"` lets an item fill the
  // space a dock body gives it, as it does on the desk.
  static properties = { height: { type: String, reflect: true } };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    /* The Back bar (6.4): the panel's handle back to the list. Its height and rule match
       a dock strip so the container reads as one place. */
    .bar {
      display: flex;
      align-items: center;
      height: var(--space-xl);
      padding: 0 var(--space-md);
      border-bottom: var(--border-width) solid var(--color-border);
      font-size: var(--text-sm);
    }
    button {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2xs);
      font: inherit;
      color: var(--color-body);
      background: none;
      border: 0;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    main {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: auto;
    }
  `;

  #actor = new ActorController(this);
  // The child shown at the last render, so a change of it can be told from a re-render.
  #shownWas;
  #hadFocus = false;

  constructor() {
    super();
    this.addEventListener("keydown", (e) => this.#escape(e));
  }

  // Escape is the Back button's keyboard twin, on the item or on the Back bar (the
  // target is this host then). Only an Escape the item left unhandled
  // counts: an editor that uses it (leaving insert mode under Vim, stopping an answer)
  // prevents it, so one Escape leaves insert mode and the next leaves the item.
  #escape(event) {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const shown = this.#actor.snapshot?.context.shown;
    if (!shown || !(event.target === this || this.#child(shown)?.contains(event.target))) return;
    event.preventDefault();
    this.#back();
  }

  #child(name) {
    return name ? [...this.children].find((c) => addressOf(c) === name) : this.children[0];
  }

  // A panel's focus lands in what it shows (dock-desk's Ctrl+h/j/k/l, 12): the list, or
  // the item picked from it.
  focus(options) {
    const shown = this.#actor.snapshot?.context.shown;
    this.#child(shown)?.focus(options);
    // An item with nothing to focus (a chat box with no model chosen) leaves the keyboard
    // on the Back button, never on the bare page where letters fall through.
    if (shown && !this.contains(document.activeElement)) this.renderRoot.querySelector(".bar button")?.focus(options);
  }

  // The children as the page declares them (6.4): the first is the list, the rest are
  // items keyed by their own `shows-on`. Read from this element's light DOM, so the
  // machine only ever sees names and stays importable in Node.
  children_() {
    const [list, ...items] = [...this.children];
    return {
      list: list ? addressOf(list) : null,
      items: items.map((child) => ({
        name: addressOf(child),
        showsOn: child.getAttribute("shows-on") ?? undefined,
      })),
    };
  }

  #back() {
    this.#actor.send({ type: "_back" });
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { shown } = snapshot.context;
    const list = this.children[0];
    const label = list?.getAttribute("label") ?? list?.localName ?? "";
    return html`
      ${shown
        ? html`
            <div class="bar">
              <button aria-label="Back to ${label}" @click=${() => this.#back()}>
                ${icon("caret-left")}<span>${label}</span>
              </button>
            </div>
          `
        : nothing}
      <main><slot></slot></main>
    `;
  }

  // Read before the render: the Back bar a render removes, or the child leaving the
  // slot, takes the focus with it.
  willUpdate() {
    this.#hadFocus = this.contains(document.activeElement);
  }

  updated() {
    const shown = this.#actor.snapshot?.context.shown;
    const slot = this.renderRoot.querySelector("slot");
    const child = this.#child(shown);
    const follow = this.#shownWas !== undefined && shown !== this.#shownWas && this.#hadFocus;
    this.#shownWas = shown;
    slot?.assign(...(child ? [child] : []));
    // The keyboard follows a pick made inside this panel (Enter on a row lands in the
    // editor, Escape lands back on the row); a pick made elsewhere never steals focus.
    if (follow) {
      child?.focus();
      // An item with nothing to focus yet (a chat box waiting for a key) leaves the
      // keyboard on the Back button, not on the list it just hid.
      if (shown && !child?.contains(document.activeElement)) this.renderRoot.querySelector(".bar button")?.focus();
    }
  }
}

customElements.define("list-then-item", ListThenItem);
