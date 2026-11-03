import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine, keyOf } from "./machine.js";
import requested from "./events/step.requested.json" with { type: "json" };

// Icon names are literals (7.6). Redo is the same glyph mirrored, so the pair reads as
// one control turning either way.
const ARROW = icon("arrow-u-up-left");

// The inputs whose own history undoes typing; a checkbox or a button has none.
const TEXT_INPUTS = new Set(["text", "search", "url", "tel", "email", "password", "number", "date", "time", "datetime-local", "month", "week"]);
const isTextBox = (n) =>
  n instanceof HTMLElement &&
  (n.isContentEditable || n instanceof HTMLTextAreaElement || n instanceof HTMLSelectElement || (n instanceof HTMLInputElement && TEXT_INPUTS.has(n.type)));

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "step.requested": requested },
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

class UndoBar extends LitElement {
  static styles = css`
    /* An inline control slotted into the desk's stage header (6.4), flush with its
       neighbours like the layout switch and the gear: no surface of its own. */
    :host {
      display: inline-flex;
      align-items: center;
      font-size: var(--text-subtitle);
    }
    /* One size for every header button (6.4): a 20px glyph in 8px of padding is 36px
       across, an easy target on a phone, lined up with the gear and the layout switch. */
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
    button:hover:not(:disabled) {
      background: var(--color-surface-hover);
      color: var(--color-ink);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* Greyed while there is nothing to reverse, as the desk's own strip buttons are. */
    button:disabled {
      color: var(--color-border);
      cursor: default;
    }
    button svg {
      display: block;
    }
    .redo svg {
      transform: scaleX(-1);
    }
  `;

  #actor = new ActorController(this);

  // On the window, so it runs after every view on the key's path has had its turn and
  // `defaultPrevented` says whether one used it.
  #onKeydown = (e) => {
    const context = this.#actor.snapshot?.context;
    if (!context) return;
    const direction = keyOf(e, { vimKeys: context.vimKeys, editable: e.composedPath().some(isTextBox) });
    if (!direction) return;
    // Ctrl+R would reload the page and Cmd+Z reach the browser's own undo.
    e.preventDefault();
    this.#actor.send({ type: "_request", direction });
  };

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.#onKeydown);
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this.#onKeydown);
    super.disconnectedCallback();
  }

  #button(direction, step) {
    const word = direction === "undo" ? "Undo" : "Redo";
    const title = step ? `${word}: ${step.label}` : `Nothing to ${direction}`;
    return html`
      <button class=${direction} ?disabled=${!step} aria-label=${title} title=${title}
        @click=${() => this.#actor.send({ type: "_request", direction })}>
        ${ARROW}
      </button>
    `;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { undo, redo } = snapshot.context;
    return html`${this.#button("undo", undo)}${this.#button("redo", redo)}`;
  }
}

customElements.define("undo-bar", UndoBar);
