import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask, send } from "bus";
import { machine, shownOf, showing } from "./machine.js";
import tabsShown from "./events/tabs.shown.json" with { type: "json" };
import switched from "./events/book.switched.json" with { type: "json" };

// Reading localStorage itself can throw (blocked site data), so the tabs then last one load.
const deviceStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // 4.1: the tabs it announces name its address, so the desk's gestures come back to it.
    const instance = this.host.id || undefined;
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload, instance),
        send: (target, name, payload) => send(machine, target, name, payload, instance),
        address: instance ? `book-stage#${instance}` : "book-stage",
        storage: deviceStorage(),
        // A try page (8) shows the stage signed out.
        tryPage: location.pathname.startsWith("/try/"),
      },
      events: { "tabs.shown": tabsShown, "book.switched": switched },
      instance,
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

class BookStage extends LitElement {
  // Manual slot assignment, as list-then-item does: both children stay connected, so
  // their actors stay mounted, and only the shown one is slotted. No attribute is written
  // on any child, so the container never touches another component.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, slotAssignment: "manual" };

  // `height="fill"` lets the shown view fill the stage, as it fills a page.
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
    main {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0;
      padding: var(--space-2xl) var(--space-md);
      text-align: center;
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);
  #shownWas;
  #hadFocus = false;
  // A focus asked for while nothing is drawn (session not answered yet, or a session that
  // starts signed out and is then confirmed), given to the shown child once it is drawn.
  #focusLater = null;

  // The first child reads an ordinary book, the second shows the written one, the third
  // the note whose tab is in front.
  #child(shown) {
    return this.children[{ reader: 0, written: 1, note: 2 }[shown]] ?? this.children[0];
  }

  #shown() {
    const snapshot = this.#actor.snapshot;
    return snapshot ? shownOf(snapshot.context) : "reader";
  }

  // dock-desk's Ctrl+h/j/k/l lands the keyboard in what the stage shows (12).
  focus(options) {
    const snapshot = this.#actor.snapshot;
    const account = snapshot ? showing(snapshot.context) : "wait";
    this.#focusLater = account === "show" ? null : (options ?? {});
    if (account === "show") this.#child(this.#shown())?.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    // Signed out nothing of the account shows (machine.js: showing): with no slot drawn,
    // no child is shown, so the reader, the journal's page and the note editor hide at once.
    const account = showing(snapshot.context);
    if (account === "wait") return nothing;
    if (account === "sign-in") return html`<p class="empty">Sign in to read.</p>`;
    return html`<main><slot></slot></main>`;
  }

  // Read before the render: the child leaving the slot takes the focus with it.
  willUpdate() {
    this.#hadFocus = this.contains(document.activeElement);
  }

  updated() {
    const shown = this.#shown();
    const child = this.#child(shown);
    const follow = this.#shownWas !== undefined && shown !== this.#shownWas && this.#hadFocus;
    this.#shownWas = shown;
    const slot = this.renderRoot.querySelector("slot");
    // Only a change is assigned: WebKit lays a re-assigned child out anew and then scrolls
    // the editor that holds the caret to its bottom edge, so the journal would jump while
    // the user types.
    const want = child ? [child] : [];
    const held = slot?.assignedNodes() ?? [];
    if (slot && (held.length !== want.length || held[0] !== want[0])) slot.assign(...want);
    // The keyboard follows a change made from the stage; one made elsewhere (a tile
    // clicked in Books) never takes the focus, and a child not shown never takes it.
    if (follow && slot) child?.focus();
    // A focus asked for while hidden is given once the child is drawn, unless the user has
    // put the keyboard somewhere since; the desk holds it on its own tabs meanwhile.
    if (slot && this.#focusLater) {
      const active = document.activeElement;
      if (!active || active.localName === "body" || active.localName === "dock-desk") child?.focus(this.#focusLater);
      this.#focusLater = null;
    }
  }
}

customElements.define("book-stage", BookStage);
