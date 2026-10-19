import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, shownOf } from "./machine.js";
import tabsShown from "./events/tabs.shown.json" with { type: "json" };
import switched from "./events/book.switched.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "tabs.shown": tabsShown, "book.switched": switched },
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
  `;

  #actor = new ActorController(this);
  #shownWas;
  #hadFocus = false;

  // The first child reads an ordinary book, the second shows the written one.
  #child(shown) {
    return this.children[shown === "written" ? 1 : 0] ?? this.children[0];
  }

  #shown() {
    const snapshot = this.#actor.snapshot;
    return snapshot ? shownOf(snapshot.context) : "reader";
  }

  // dock-desk's Ctrl+h/j/k/l lands the keyboard in what the stage shows (12).
  focus(options) {
    this.#child(this.#shown())?.focus(options);
  }

  render() {
    if (!this.#actor.snapshot) return nothing;
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
    this.renderRoot.querySelector("slot")?.assign(...(child ? [child] : []));
    // The keyboard follows a change made from the stage; one made elsewhere (a tile
    // clicked in Books) never takes the focus.
    if (follow) child?.focus();
  }
}

customElements.define("book-stage", BookStage);
