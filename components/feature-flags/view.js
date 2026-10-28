import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, FEATURES, onOf } from "./machine.js";
import flagSwitched from "./events/flag.switched.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "flag.switched": flagSwitched },
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

class FeatureFlags extends LitElement {
  // The same column and rows as the Settings tab (settings-sheet), so the tabs read as
  // one sheet: a name on the left, its switch on the right, what it hides under it.
  static styles = css`
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
    }
    h3 {
      margin: 0 0 var(--space-md);
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .part {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .field {
      display: grid;
      grid-template-columns: 2fr 3fr;
      align-items: center;
      column-gap: var(--space-md);
      row-gap: var(--space-2xs);
      white-space: normal;
    }
    .field > :not(:first-child) {
      justify-self: start;
    }
    .field > .help {
      grid-column: 2;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .hint {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .refused {
      margin: 0;
      color: var(--color-ink);
      font-size: var(--text-sm);
    }
    input[type="checkbox"] {
      margin: 0;
      accent-color: var(--color-accent);
    }
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
  `;

  #actor = new ActorController(this);

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on its first switch.
  focus(options) {
    const target = this.renderRoot?.querySelector("input");
    if (target) target.focus(options);
    else super.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    if (context.off === null) return html`<h3>Feature flags</h3>`;
    const refused = FEATURES.find((f) => f.id === context.refused);
    return html`
      <h3>Feature flags</h3>
      <div class="part">
        <p class="hint">A feature turned off is hidden from everyone, you included: from you at once, from others at their next visit.</p>
        ${FEATURES.map((f) => {
          const on = onOf(context, f.id);
          return html`
            <label class="field">
              <span>${f.name}</span>
              <input
                type="checkbox"
                role="switch"
                .checked=${on}
                aria-checked=${on ? "true" : "false"}
                @change=${(e) => this.#actor.send({ type: "_switch", feature: f.id, on: e.target.checked })}
              />
              <span class="help">${f.says}</span>
            </label>
          `;
        })}
        ${refused
          ? html`<p class="refused" role="status">${refused.name} could not be changed. Check the connection and try again.</p>`
          : nothing}
      </div>
    `;
  }
}

customElements.define("feature-flags", FeatureFlags);
