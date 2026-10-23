import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine } from "./machine.js";
import signin from "./events/signin.requested.json" with { type: "json" };
import signout from "./events/signout.requested.json" with { type: "json" };

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
        // Read once: the Mac put its details in the address that opened the page.
        search: location.search,
        go: (url) => location.assign(url),
      },
      events: { "signin.requested": signin, "signout.requested": signout },
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

class DeviceConnect extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      min-height: 100dvh;
      padding: var(--space-lg) var(--space-md);
      color: var(--color-ink);
      background: var(--color-canvas);
    }
    :host-context(html[data-viewport="phone"]) {
      min-height: 100%;
    }
    .column {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-md);
      width: 100%;
      max-width: calc(var(--width-form) * 0.75);
      text-align: center;
    }
    h1 {
      margin: 0;
      font-size: var(--text-heading);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    p {
      margin: 0;
      font-size: var(--text-body);
      line-height: var(--leading-normal);
      color: var(--color-body-mid);
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: var(--space-sm);
    }
    button {
      min-height: calc(var(--space-xl) + var(--space-xs));
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-md);
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
    }
    button:focus-visible,
    a:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button.primary {
      padding: var(--space-sm) calc(var(--space-md) + var(--space-xs));
      border: 0;
      background: var(--color-accent);
      color: var(--color-accent-text);
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
    }
    button.primary:hover {
      background: var(--color-accent-hover);
    }
    button.primary:active {
      background: var(--color-accent-active);
    }
    button.primary:disabled {
      cursor: progress;
      background: var(--color-accent-hover);
    }
    button.secondary {
      border: var(--border-width) solid var(--color-border-strong);
      background: var(--color-canvas);
      color: var(--color-ink);
    }
    button.secondary:hover {
      background: var(--color-surface-hover);
    }
    .small {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .small button {
      min-height: 0;
      padding: 0;
      border: 0;
      background: none;
      color: var(--color-accent);
      font-size: inherit;
      text-decoration: underline;
    }
    .small button:hover {
      color: var(--color-accent-hover);
    }
    .problem {
      color: var(--color-danger);
      font-size: var(--text-sm);
    }
  `;

  #actor = new ActorController(this);

  #send(type) {
    return () => this.#actor.send({ type });
  }

  #notYou() {
    return html`<span class="small">Not you? <button type="button" @click=${this.#send("_signOut")}>Sign out</button></span>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { name, problem } = snapshot.context;
    const state = snapshot.value;
    let body;
    if (state === "broken") {
      body = html`<h1>This link is not complete</h1>
        <p>Open the Unblent app on your Mac and press Connect account again.</p>`;
    } else if (state === "signedOut") {
      body = html`<h1>Connect your Mac</h1>
        <p>Sign in to choose the account your Unblent app on the Mac will use.</p>
        <button type="button" class="primary" @click=${this.#send("_signIn")}>Sign in with passkey</button>`;
    } else if (state === "ready" || state === "connecting") {
      const busy = state === "connecting";
      body = html`<h1>Connect this Mac to ${name || "this account"}?</h1>
        <p>The Unblent app on your Mac will show this account and keep it in step with your phone and the web.</p>
        <div class="buttons">
          <button type="button" class="secondary" ?disabled=${busy} @click=${this.#send("_cancel")}>Cancel</button>
          <button type="button" class="primary" ?disabled=${busy} @click=${this.#send("_connect")}>
            ${busy ? "Connecting…" : "Connect"}
          </button>
        </div>
        ${problem ? html`<p class="problem" role="alert">Could not reach your account. Try Connect again.</p>` : nothing}
        ${this.#notYou()}`;
    } else if (state === "off") {
      body = html`<h1>Sync is not turned on for this account</h1>
        <p>The admin can turn on Can sync for ${name || "this account"} in Settings › Administration. Then open this page again from the Mac app.</p>
        ${this.#notYou()}`;
    } else if (state === "failed") {
      body = html`<h1>Connect your Mac</h1>
        <p>Your account could not be reached.</p>
        <button type="button" class="secondary" @click=${this.#send("_retry")}>Try again</button>`;
    } else if (state === "leaving") {
      body = html`<h1>Going back to your Mac…</h1>`;
    } else {
      return nothing;
    }
    return html`<div class="column" aria-live="polite">${body}</div>`;
  }
}

customElements.define("device-connect", DeviceConnect);
