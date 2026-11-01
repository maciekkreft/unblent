import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, FEATURES, onOf, rowsOf } from "./machine.js";
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
  // The same column and type as the Settings tab (settings-sheet), so the tabs read as
  // one sheet: a feature's name on the left with what it holds under it, its switches on
  // the right, each column named once above them.
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
    .grid {
      display: grid;
      grid-template-columns: 1fr auto auto;
      align-items: center;
      column-gap: var(--space-md);
      row-gap: var(--space-sm);
    }
    .grid.one {
      grid-template-columns: 1fr auto;
    }
    .head {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
      justify-self: center;
    }
    .name {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .help,
    .hint {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .switch {
      justify-self: center;
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
    const target = this.renderRoot?.querySelector("input:not(:disabled)");
    if (target) target.focus(options);
    else super.focus(options);
  }

  #switch(context, column, f) {
    const on = onOf(context, column, f.id);
    const label = `${column === "release" ? "Release" : "Show"} ${f.name}`;
    return html`<input
      class="switch ${column}"
      type="checkbox"
      role="switch"
      aria-label=${label}
      .checked=${on}
      aria-checked=${on ? "true" : "false"}
      ?disabled=${column === "show" && !context.signedIn}
      @change=${(e) => this.#actor.send({ type: "_switch", column, feature: f.id, on: e.target.checked })}
    />`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    if (context.released === null) return html`<h3>Features</h3>`;
    const rows = rowsOf(context);
    const release = context.mayRelease;
    const refused = context.refused && FEATURES.find((f) => f.id === context.refused.id);
    return html`
      <h3>Features</h3>
      <div class="part">
        <p class="hint">
          ${release
            ? "Release gives a feature to everyone; one not released is hidden from everyone but you. Show hides a feature from you alone."
            : "Show hides a feature from you alone."}
        </p>
        ${rows.length === 0
          ? html`<p class="hint">There is nothing to choose here yet.</p>`
          : html`<div class="grid ${release ? "" : "one"}">
              <span></span>
              ${release ? html`<span class="head release">Release</span>` : nothing}
              <span class="head">Show</span>
              ${rows.map(
                (f) => html`
                  <div class="name"><span>${f.name}</span><span class="help">${f.says}</span></div>
                  ${release ? this.#switch(context, "release", f) : nothing}
                  ${this.#switch(context, "show", f)}
                `,
              )}
            </div>`}
        ${context.signedIn ? nothing : html`<p class="hint">Sign in to choose what you see.</p>`}
        ${refused
          ? html`<p class="refused" role="status">${refused.name} could not be changed. Check the connection and try again.</p>`
          : nothing}
      </div>
    `;
  }
}

customElements.define("feature-flags", FeatureFlags);
