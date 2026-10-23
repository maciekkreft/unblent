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
    /* The two ways to connect, side by side where they fit and stacked where they do
       not: the chosen one carries the accent border, as a picked tab its accent line. */
    .choices {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, calc(var(--space-2xl) * 3)), 1fr));
      gap: var(--space-sm);
    }
    .choice {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-md);
      text-align: left;
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
      color: var(--color-ink);
    }
    .choice:hover {
      background: var(--color-surface-hover);
    }
    .choice[aria-checked="true"] {
      border-color: var(--color-accent);
      box-shadow: inset 0 0 0 var(--border-width) var(--color-accent);
      background: var(--color-accent-subtle);
    }
    .choice .name {
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
    }
    .choice .what {
      font-size: var(--text-caption);
      line-height: var(--leading-normal);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  #send(type, extra = {}) {
    return () => this.#actor.send({ type, ...extra });
  }

  // The arrow keys move the choice, as in any group of radio buttons.
  #choiceKey(e) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const keep = !this.#actor.snapshot.context.keep;
    this.#actor.send({ type: "_pick", keep });
    this.updateComplete.then(() => this.renderRoot.querySelector('[role="radio"][aria-checked="true"]')?.focus());
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

  #choosing(remote, keep, doing) {
    const busy = doing !== null;
    const choice = (value, name, what) => html`<button
      type="button"
      class="choice"
      role="radio"
      aria-checked=${keep === value ? "true" : "false"}
      tabindex=${keep === value ? "0" : "-1"}
      ?disabled=${busy}
      @click=${this.#send("_pick", { keep: value })}
      @keydown=${(e) => this.#choiceKey(e)}
    >
      <span class="name">${name}</span>
      <span class="what">${what}</span>
    </button>`;
    return html`<h2>Ready to connect to ${remote || "your account"}</h2>
      <p class="more" id="question">What should happen to the notes, journal and books already on this Mac?</p>
      <div class="choices" role="radiogroup" aria-labelledby="question">
        ${choice(false, "Use my account", "Shows what is in your account. This Mac's own copy is kept aside and comes back if you disconnect.")}
        ${choice(true, "Add this Mac's things", "Uploads this Mac's notes, journal and books into your account, next to what is already there.")}
      </div>
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
      <span class="small">Goes back to this Mac's own copy. Your account keeps everything.</span>
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

  #syncOff(waiting, doing) {
    return html`<h2>Your account</h2>
      <div class="status off">
        ${icon("warning")}
        <p>Sync was turned off for this account</p>
      </div>
      <p class="more">Nothing is sent from this Mac until sync is turned on again.</p>
      ${waiting ? html`<p class="waiting-on" role="status">Changes are waiting on this Mac.</p>` : nothing}
      ${this.#disconnect(doing)}`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { connect, remote, userId, keep, waiting, doing } = snapshot.context;
    let body;
    if (snapshot.matches("notConnected")) body = this.#notConnected();
    else if (snapshot.matches("waiting")) body = this.#waiting();
    else if (snapshot.matches("choosing")) body = this.#choosing(remote, keep, null);
    else if (snapshot.matches("connected")) body = this.#connected(remote, waiting, null);
    else if (snapshot.matches("syncOff")) body = this.#syncOff(waiting, null);
    else if (snapshot.matches("switching") && connect === "ready") body = this.#choosing(remote, keep, doing);
    else if (snapshot.matches("switching") && connect === "on" && !userId) body = this.#syncOff(waiting, doing);
    else if (snapshot.matches("switching") && connect === "on") body = this.#connected(remote, waiting, doing);
    else return nothing;
    return html`<div class="card" aria-live="polite">${body}</div>`;
  }
}

customElements.define("mac-account", MacAccount);
