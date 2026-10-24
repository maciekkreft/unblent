import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import requested from "./events/connect.requested.json" with { type: "json" };
import confirmed from "./events/connect.confirmed.json" with { type: "json" };
import disconnect from "./events/disconnect.requested.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "connect.requested": requested, "connect.confirmed": confirmed, "disconnect.requested": disconnect },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
    // Coming back from Safari (3.4): the window regains focus, though it may never
    // have been hidden behind it.
    this.onFocus = () => this.actor.send({ type: "_focused" });
    window.addEventListener("focus", this.onFocus);
  }

  hostDisconnected() {
    window.removeEventListener("focus", this.onFocus);
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

class MacAccount extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
      color: var(--color-ink);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    h2 {
      margin: 0;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    p {
      margin: 0;
      font-size: var(--text-body);
      line-height: var(--leading-normal);
    }
    p.more {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .small {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .waiting-on {
      font-size: var(--text-caption);
      color: var(--color-warning);
    }
    /* The state in one line, its sign beside it, so it reads before the explanation. */
    .status {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }
    .status svg {
      flex: none;
      font-size: var(--text-subtitle);
    }
    .status.on svg {
      color: var(--color-success);
    }
    .status.off svg {
      color: var(--color-warning);
    }
    .spinner {
      flex: none;
      box-sizing: border-box;
      width: var(--space-md);
      height: var(--space-md);
      border: calc(var(--border-width) * 2) solid var(--color-accent);
      border-right-color: transparent;
      border-radius: var(--radius-full);
      animation: turn calc(var(--duration-slide) * 4) linear infinite;
    }
    @keyframes turn {
      to {
        transform: rotate(1turn);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
    .action {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-sm);
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .buttons.apart {
      justify-content: space-between;
      align-items: center;
    }
    button {
      min-height: calc(var(--space-xl) + var(--space-xs));
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-md);
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: progress;
    }
    /* A button that cannot be used now, as against one busy working. */
    button.unavailable:disabled,
    button.unavailable:disabled:hover {
      cursor: not-allowed;
      color: var(--color-body-mid);
      background: var(--color-canvas);
    }
    .primary {
      padding: var(--space-sm) calc(var(--space-md) + var(--space-xs));
      border: 0;
      background: var(--color-accent);
      color: var(--color-accent-text);
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
    }
    .primary:hover {
      background: var(--color-accent-hover);
    }
    .primary:active {
      background: var(--color-accent-active);
    }
    .primary:disabled {
      background: var(--color-accent-hover);
    }
    .secondary {
      border: var(--border-width) solid var(--color-border-strong);
      background: var(--color-canvas);
      color: var(--color-ink);
    }
    .secondary:hover {
      background: var(--color-surface-hover);
    }
    .quiet {
      border: 0;
      background: none;
      color: var(--color-body-mid);
    }
    .quiet:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
  `;

  #actor = new ActorController(this);

  #send(type, extra = {}) {
    return () => this.#actor.send({ type, ...extra });
  }

  #notConnected() {
    return html`<h2>Your account</h2>
      <p>Everything is kept on this Mac only.</p>
      <p class="more">
        Connect your account on app.unblent.com to see the same notes, journal and books on your phone and on the web. The
        app keeps working offline and catches up when you are back online.
      </p>
      <div class="action">
        <button type="button" class="primary" @click=${this.#send("_connect")}>Connect account</button>
        <span class="small">Opens Safari, where you sign in with your passkey.</span>
      </div>`;
  }

  #waiting() {
    return html`<h2>Your account</h2>
      <div class="status" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <p>Waiting for you to finish in Safari…</p>
      </div>
      <p class="more">
        Sign in with your passkey there and click Connect. Then come back to this window. Nothing on this Mac changes until
        you choose what to do next.
      </p>
      <div class="buttons">
        <button type="button" class="secondary" @click=${this.#send("_again")}>Open Safari again</button>
        <button type="button" class="quiet" @click=${this.#send("_cancel")}>Cancel</button>
      </div>`;
  }

  #choosing(remote, doing) {
    const busy = doing !== null;
    return html`<h2>Connect this Mac to ${remote || "your account"}?</h2>
      <p class="more">
        If your account already has notes, journal days or books, this Mac will show them. If it is empty, this Mac's are
        added to it.
      </p>
      <div class="buttons apart">
        <button type="button" class="quiet" ?disabled=${busy} @click=${this.#send("_cancel")}>Cancel</button>
        <button type="button" class="primary" ?disabled=${busy} @click=${this.#send("_confirm")}>
          ${doing === "connect" ? "Connecting…" : "Connect"}
        </button>
      </div>`;
  }

  #disconnect(doing) {
    return html`<div class="action">
      <button type="button" class="secondary" ?disabled=${doing !== null} @click=${this.#send("_disconnect")}>
        ${doing === "disconnect" ? "Disconnecting…" : "Disconnect"}
      </button>
      <span class="small">Disconnect stops syncing. This Mac keeps what it shows.</span>
    </div>`;
  }

  #connected(remote, waiting, doing) {
    return html`<h2>Your account</h2>
      <div class="status on">
        ${icon("check")}
        <p>Connected to <strong>${remote || "your account"}</strong> on app.unblent.com</p>
      </div>
      <p class="more">
        What you write here also shows on your phone and on the web. Offline, changes wait on this Mac and are sent when you
        are back online.
      </p>
      ${waiting ? html`<p class="waiting-on" role="status">Offline. Changes are waiting on this Mac.</p>` : nothing}
      ${this.#disconnect(doing)}`;
  }

  // Disconnect stays in view, greyed out, with why it cannot be used (a constraint shown,
  // not hidden), since the account's books could not be fetched for the Mac to keep.
  #syncOff(waiting) {
    return html`<h2>Your account</h2>
      <div class="status off">
        ${icon("warning")}
        <p>Sync was turned off for this account</p>
      </div>
      <p class="more">Nothing is sent from this Mac until sync is turned on again.</p>
      ${waiting ? html`<p class="waiting-on" role="status">Changes are waiting on this Mac.</p>` : nothing}
      <div class="action">
        <button type="button" class="secondary unavailable" disabled aria-describedby="why">Disconnect</button>
        <span class="small" id="why">
          To disconnect this Mac, turn sync on again for this account in Administration on app.unblent.com.
        </span>
      </div>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { connect, remote, userId, waiting, doing } = snapshot.context;
    let body;
    if (snapshot.matches("notConnected")) body = this.#notConnected();
    else if (snapshot.matches("waiting")) body = this.#waiting();
    else if (snapshot.matches("choosing")) body = this.#choosing(remote, null);
    else if (snapshot.matches("connected")) body = this.#connected(remote, waiting, null);
    else if (snapshot.matches("syncOff")) body = this.#syncOff(waiting);
    else if (snapshot.matches("switching") && connect === "ready") body = this.#choosing(remote, doing);
    else if (snapshot.matches("switching") && connect === "on" && !userId) body = this.#syncOff(waiting);
    else if (snapshot.matches("switching") && connect === "on") body = this.#connected(remote, waiting, doing);
    else return nothing;
    return html`<div class="card" aria-live="polite">${body}</div>`;
  }
}

customElements.define("mac-account", MacAccount);
