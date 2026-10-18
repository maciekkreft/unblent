import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, groupsOf, countText, PATH } from "./machine.js";
import ticked from "./events/starter.ticked.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "starter.ticked": ticked },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
    // The part reads its data each time it comes into view: the sheet shows it only to
    // the admin, so nobody else asks.
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.actor.send({ type: "_shown" });
    });
    this.observer.observe(this.host);
  }

  hostDisconnected() {
    this.observer?.disconnect();
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

// How long "Copied" stays on the button before it reads Copy link again.
const COPIED_MS = 2000;

class EvaluatorStarters extends LitElement {
  // `copied` is the button's own feedback after a copy; nothing else is kept here.
  static properties = { copied: { state: true } };

  constructor() {
    super();
    this.copied = false;
  }

  // The same column and heading as the other parts of Administration (guest-limits), so
  // the tab reads as one sheet.
  static styles = css`
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
    }
    h3 {
      margin: 0 0 var(--space-md);
      padding-top: var(--space-lg);
      border-top: var(--border-width) solid var(--color-border);
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .hint {
      margin: 0 0 var(--space-sm);
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .try {
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--space-sm) var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-xs) var(--space-sm);
      padding-bottom: var(--space-2xs);
    }
    .head .name {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .head .url {
      color: var(--color-body-mid);
      overflow-wrap: anywhere;
    }
    button.act {
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-md);
      cursor: pointer;
      white-space: nowrap;
    }
    button.act:hover {
      background: var(--color-surface-hover);
    }
    button.act:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .book {
      margin: var(--space-xs) 0 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-body-mid);
    }
    label.check {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-2xs) 0;
      color: var(--color-ink);
      cursor: pointer;
    }
    label.check .count {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    input[type="checkbox"] {
      flex: none;
      width: calc(var(--space-md) + var(--space-2xs));
      height: calc(var(--space-md) + var(--space-2xs));
      margin: 0;
      accent-color: var(--color-accent);
      cursor: pointer;
    }
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
  `;

  #actor = new ActorController(this);
  #timer = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on its first control.
  focus(options) {
    const target = this.renderRoot?.querySelector("button, input");
    if (target) target.focus(options);
    else super.focus(options);
  }

  // The link is this site's own, so it is right on every host the product runs on.
  async #copy(link) {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Without the clipboard the link is selected instead, ready for the user to copy.
      const url = this.renderRoot.querySelector(".url");
      if (url) getSelection()?.selectAllChildren(url);
      return;
    }
    this.copied = true;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => (this.copied = false), COPIED_MS);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot?.context.read) return nothing;
    const { context } = snapshot;
    const link = `${location.origin}${PATH}`;
    const groups = groupsOf(context);
    return html`
      <h3>Starters</h3>
      <p class="hint">One group for each try page. A new guest on that page gets a copy of what is ticked.</p>
      <div class="try">
        <div class="head">
          <span class="name">${context.title ?? "Evaluators"}</span>
          <span class="url">${location.host}${PATH}</span>
          <button class="act" aria-label="Copy link to ${location.host}${PATH}" @click=${() => this.#copy(link)}>
            ${this.copied ? "Copied" : "Copy link"}
          </button>
        </div>
        ${context.failed
          ? html`<p class="hint">Your evaluators could not be read. Open this tab again to try again.</p>`
          : groups.length === 0
            ? html`<p class="hint">You have no evaluators yet. Make one in a book's Evaluators to offer it here.</p>`
            : groups.map(
                (group) => html`
                  <p class="book">${group.title}</p>
                  ${group.evaluators.map(
                    (e) => html`
                      <label class="check">
                        <input
                          type="checkbox"
                          .checked=${e.ticked}
                          @change=${(event) => this.#actor.send({ type: "_tick", evaluator: e.id, on: event.target.checked })}
                        />
                        <span>${e.name} <span class="count">· ${countText(e.questions)}</span></span>
                      </label>
                    `,
                  )}
                `,
              )}
      </div>
    `;
  }
}

customElements.define("evaluator-starters", EvaluatorStarters);
