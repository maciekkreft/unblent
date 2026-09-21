import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { monotonicFactory } from "ulid";
import { icon } from "icons";
import { machine, inputState, pendingTurn, canContinue, retryText } from "./machine.js";
import submitted from "./events/turn.submitted.json" with { type: "json" };
import steered from "./events/turn.steered.json" with { type: "json" };

// The draft, kept across reloads (3.1): the view's own UI state under a key named for
// the component, so it follows the browser, not the account, and losing it loses
// nothing. Wrapped like settings/store.js: a browser refusing storage reads "" and
// drops the write.
const KEY = "chat-input.draft";
const draftStore = {
  read() {
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  },
  write(text) {
    try {
      if (text) localStorage.setItem(KEY, text);
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the draft lives only for this page.
    }
  },
};

// A CSS duration token as milliseconds, for the moment the Send/Stop button ignores
// clicks after it changes; the token is the one clock (7.4), the same --duration-slide
// the row animations use.
const toMs = (text, fallback = 300) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        // Monotonic ids, so two turns sent in the same millisecond keep their order
        // (Contracts, "Turn ids and order").
        mint: monotonicFactory(),
      },
      events: { "turn.submitted": submitted, "turn.steered": steered },
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

class ChatInput extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .box {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm);
    }
    /* The one contextual action, when the chat was left hanging: Continue an
       interrupted answer, or Try again a failed one. */
    .actions {
      display: flex;
      gap: var(--space-sm);
    }
    .action {
      appearance: none;
      background: none;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      padding: var(--space-2xs) var(--space-sm);
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      color: var(--color-body);
    }
    .action:hover {
      background: var(--color-surface-hover);
      color: var(--color-ink);
    }
    .action:focus-visible {
      outline: var(--focus-ring);
    }
    .row {
      display: flex;
      align-items: flex-end;
      gap: var(--space-sm);
    }
    textarea {
      flex: 1;
      font: inherit;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      padding: var(--space-xs) var(--space-sm);
      box-sizing: border-box;
      /* One line to a few: grows with the text, then scrolls inside so the box never
         pushes the transcript off screen. */
      field-sizing: content;
      min-height: calc(var(--text-body) * var(--leading-normal));
      max-height: calc(var(--text-body) * var(--leading-normal) * 6);
      overflow-y: auto;
      overflow-wrap: anywhere;
      resize: none;
      line-height: var(--leading-normal);
    }
    textarea:focus-visible {
      outline: var(--focus-ring);
    }
    textarea:disabled {
      color: var(--color-mute);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    /* The send/stop button: a round accent button, so it reads as the one action. */
    .send {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      appearance: none;
      border: 0;
      border-radius: var(--radius-full);
      width: var(--space-xl);
      height: var(--space-xl);
      padding: 0;
      font: inherit;
      font-size: var(--text-subtitle);
      cursor: pointer;
      color: var(--color-accent-text);
      background: var(--color-accent);
    }
    .send svg {
      display: block;
    }
    .send:hover:not(:disabled) {
      background: var(--color-accent-hover);
    }
    .send:focus-visible {
      outline: var(--focus-ring);
    }
    .send:disabled {
      background: var(--color-border);
      color: var(--color-mute);
      cursor: default;
    }
    .notice {
      margin: 0;
      padding: var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);
  #draft = draftStore.read();
  // The Send/Stop button ignores clicks for a moment after it changes role, so a click
  // aimed at Send does not land on the freshly-appeared Stop, and vice versa.
  #pendingWas = false;
  #guardUntil = 0;
  #guardMs = null;

  #guard() {
    if (this.#guardMs == null) this.#guardMs = toMs(getComputedStyle(this).getPropertyValue("--duration-slide"));
    return this.#guardMs;
  }

  updated() {
    const pending = Boolean(pendingTurn(this.#actor.snapshot?.context.conversation));
    if (pending !== this.#pendingWas) {
      this.#pendingWas = pending;
      this.#guardUntil = performance.now() + this.#guard();
    }
  }

  #typed(event) {
    this.#draft = event.currentTarget.value;
    draftStore.write(this.#draft);
    this.requestUpdate(); // enable/disable Send as the draft gains or loses text
  }

  #keydown(event, disabled) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!disabled) this.#send();
    } else if (event.key === "Escape" && pendingTurn(this.#actor.snapshot?.context.conversation)) {
      event.preventDefault();
      this.#actor.send({ type: "_stop" });
    }
  }

  #send() {
    if (!this.#draft.trim()) return;
    this.#actor.send({ type: "_send", text: this.#draft });
    this.#draft = "";
    draftStore.write("");
    const area = this.renderRoot.querySelector("textarea");
    if (area) area.value = "";
    this.requestUpdate();
  }

  #primary(pending) {
    if (performance.now() < this.#guardUntil) return; // ignore a click during the guard
    if (pending) this.#actor.send({ type: "_stop" });
    else this.#send();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const context = snapshot.context;
    const { disabled, notice } = inputState(context.llm);
    if (disabled && notice) return html`<p class="notice">${notice}</p>`;

    const pending = Boolean(pendingTurn(context.conversation));
    const showContinue = !pending && canContinue(context.conversation);
    const showRetry = !pending && retryText(context.conversation) != null;
    const canSend = pending || (!disabled && Boolean(this.#draft.trim()));

    return html`
      <div class="box">
        ${showContinue || showRetry
          ? html`<div class="actions">
              ${showContinue
                ? html`<button class="action" type="button" @click=${() => this.#actor.send({ type: "_continue" })}>
                    Continue
                  </button>`
                : nothing}
              ${showRetry
                ? html`<button class="action" type="button" @click=${() => this.#actor.send({ type: "_retry" })}>
                    Try again
                  </button>`
                : nothing}
            </div>`
          : nothing}
        <div class="row">
          <textarea
            .value=${this.#draft}
            placeholder="Ask about your library…"
            ?disabled=${disabled}
            aria-label="Message"
            @input=${(e) => this.#typed(e)}
            @keydown=${(e) => this.#keydown(e, disabled)}
          ></textarea>
          <button
            class="send"
            type="button"
            aria-label=${pending ? "Stop" : "Send"}
            ?disabled=${!canSend}
            @click=${() => this.#primary(pending)}
          >
            ${pending ? icon("stop") : icon("arrow-up")}
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define("chat-input", ChatInput);
