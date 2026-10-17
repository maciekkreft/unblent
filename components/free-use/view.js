import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, levelOf, percentOf } from "./machine.js";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: {},
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

class FreeUse extends LitElement {
  static styles = css`
    /* A control slotted into the desk's stage header (6.4), where an account's page has
       Settings and sign-in: flush with the strip, no surface of its own. */
    :host {
      display: inline-flex;
      align-items: center;
      min-width: 0;
    }
    :host([hidden]) {
      display: none;
    }
    .use {
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
      padding: 0 var(--space-sm);
      font-size: var(--text-caption);
      color: var(--color-body);
      white-space: nowrap;
    }
    .track {
      width: calc(var(--space-2xl) + var(--space-lg));
      height: calc(var(--space-xs) + var(--space-2xs));
      background: var(--color-surface-active);
      border-radius: var(--radius-full);
      overflow: hidden;
    }
    .fill {
      display: block;
      height: 100%;
      border-radius: var(--radius-full);
      background: var(--color-accent);
    }
    /* 10% or less: the warning colour; nothing left: the danger colour (screen 2). */
    .low {
      color: var(--color-warning);
    }
    .low .fill {
      background: var(--color-warning);
    }
    .out {
      color: var(--color-danger);
    }
    .left {
      font-variant-numeric: tabular-nums;
    }
  `;

  #actor = new ActorController(this);

  render() {
    const share = this.#actor.snapshot?.context.share ?? null;
    const level = levelOf(share);
    // Nothing for an account that is not a guest, so the strip keeps its own controls.
    this.hidden = level == null;
    if (level == null) return nothing;
    const percent = percentOf(share);
    const said = level === "out" ? "used up" : `${percent}% left`;
    return html`
      <span class="use ${level}">
        <span>Free use</span>
        <span class="track" role="meter" aria-label="Free use left" aria-valuemin="0" aria-valuemax="100"
          aria-valuenow=${percent} aria-valuetext=${said}>
          <span class="fill" style="width: ${percent}%"></span>
        </span>
        <span class="left">${said}</span>
      </span>
    `;
  }
}

customElements.define("free-use", FreeUse);
