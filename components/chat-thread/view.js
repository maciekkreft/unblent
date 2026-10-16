import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine, parseMarkdown, userParagraphs } from "./machine.js";
import pinToggled from "./events/pin.toggled.json" with { type: "json" };

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
      },
      events: { "pin.toggled": pinToggled },
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

// A failed answer's `error` in plain words. Known short codes get a sentence; anything
// else — a rate limit, an overload, a provider's own 400 message — is shown as it came,
// so the reader always sees the real cause rather than a generic apology.
const errorText = (error) => {
  switch (error) {
    case "unavailable":
      return "The model could not be reached.";
    case "bad-key":
      return "Your API key was rejected.";
    case "signed-out":
      return "Sign in to chat.";
    case "no-key":
      return "Add your API key in Settings.";
    case "busy":
      return "The model is finishing another answer — try again in a moment.";
    case "truncated":
      return "The answer was cut off — it reached the length limit.";
    case "refused":
      return "The model declined to answer.";
    case "too-many-lookups":
      return "Stopped after too many lookups — try a more specific question.";
    default:
      return error || "Something went wrong.";
  }
};

// How near the bottom counts as "at the bottom", so a small drift does not unstick the
// transcript while an answer streams. A length, but one that sizes nothing on the page,
// so it is a plain constant rather than a token (7.4).
const STICK_SLOP = 24;

class ChatThread extends LitElement {
  // The one attribute the tag understands: height="fill" makes the thread take the
  // height its container leaves, so a docked chat fills its dock and scrolls inside.
  static properties = {
    height: { type: String, reflect: true },
    // When set, an answer's markdown is rendered as formatting (10). Set first on the
    // chat stem page; it reaches the product page only after the owner approves it (9).
    markdown: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    /* The header: the pin at the top right, where the note editor has its pin, so the
       two panels pin the same way. */
    .header {
      flex: none;
      display: flex;
      justify-content: flex-end;
      padding: var(--space-xs) var(--space-md) 0;
    }
    /* The pin: a toggle, muted while following, accent when pinned, as the note
       editor's. */
    .pin {
      flex: none;
      display: inline-flex;
      appearance: none;
      background: none;
      border: var(--border-width) solid transparent;
      border-radius: var(--radius-sm);
      padding: var(--space-2xs);
      margin: 0;
      font: inherit;
      font-size: var(--text-body);
      cursor: pointer;
      color: var(--color-body-mid);
    }
    .pin svg {
      display: block;
    }
    .pin:hover:not(:disabled):not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    .pin[aria-pressed="true"] {
      color: var(--color-accent);
    }
    .pin:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .pin:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The transcript scrolls inside its own box so the question box below stays in
       view and the page never scrolls. */
    .transcript {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      padding: var(--space-md);
    }
    .composer {
      flex: none;
      border-top: var(--border-width) solid var(--color-border);
    }
    /* The reader's own message: a bubble at the trailing edge, so the two voices read
       apart at a glance. */
    .turn.user {
      align-self: flex-end;
      max-width: 85%;
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-md);
      background: var(--color-accent-subtle);
      color: var(--color-ink);
      overflow-wrap: anywhere;
    }
    .turn.user .para {
      margin: 0;
      white-space: pre-wrap;
    }
    /* The editor kit's gap (10), so a message shows here as it did in the box. */
    .turn.user .gap {
      height: calc((var(--space-sm) + var(--space-md)) / 2);
    }
    /* The model's answer, across the width. Without the markdown attribute it is plain
       text with its line breaks kept; with it (10) the same text is rendered as
       formatting by the prose rules below. */
    .turn.assistant {
      align-self: stretch;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      color: var(--color-body);
    }
    .answer {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    /* A rendered answer (10): blocks stacked with breathing room, its own white-space so
       the source line breaks between blocks do not double up. Type and spacing are tokens
       only (7.4); every text run is an escaped Lit text node, never model HTML. */
    .answer.prose {
      white-space: normal;
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      line-height: var(--leading-normal);
    }
    .answer.prose .md-p {
      margin: 0;
    }
    .answer.prose .md-h {
      margin: 0;
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .answer.prose h1.md-h {
      font-size: var(--text-heading);
    }
    .answer.prose h2.md-h {
      font-size: var(--text-subtitle);
    }
    .answer.prose h3.md-h,
    .answer.prose h4.md-h,
    .answer.prose h5.md-h,
    .answer.prose h6.md-h {
      font-size: var(--text-body);
    }
    .answer.prose .md-list {
      margin: 0;
      padding-left: var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .answer.prose .md-quote {
      margin: 0;
      padding-left: var(--space-sm);
      border-left: var(--border-width) solid var(--color-border-strong);
      color: var(--color-body-mid);
    }
    .answer.prose .md-code {
      margin: 0;
      padding: var(--space-sm);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: var(--text-sm);
    }
    .answer.prose .md-code code {
      font-family: inherit;
    }
    .answer.prose .md-code-inline {
      padding: 0 var(--space-2xs);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
    }
    .answer.prose strong {
      font-weight: var(--weight-semibold);
    }
    /* The waiting line before any text: a neutral pulse while the model works, and the
       word "Thinking" only when the model is actually thinking (not while it merely
       processes the request). */
    .working {
      margin: 0;
      color: var(--color-mute);
      font-size: var(--text-sm);
    }
    .dots {
      display: inline-block;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.3;
      }
      50% {
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dots {
        animation: none;
      }
    }
    /* The thinking record: a dim disclosure, closed by default, that opens to read what
       the model thought (12: a live line while the model works, then a dim record). */
    .thinking {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .thinking summary {
      cursor: pointer;
      color: var(--color-mute);
      list-style: none;
      /* A click toggles the record; it must not select the word as a side effect. */
      user-select: none;
      -webkit-user-select: none;
    }
    .thinking summary::-webkit-details-marker {
      display: none;
    }
    .thinking .text {
      margin-top: var(--space-2xs);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--color-body-mid);
    }
    /* What the model is reading, or read, during a round of lookups (7.7): a dim line per
       recognised tool call, naming the lookup by its owner's label. It reads as a live
       line while the round runs (the pending answer follows it) and stays as a quiet
       record after. A call the system did not recognise is not shown as a lookup. */
    .lookups {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      font-size: var(--text-sm);
      color: var(--color-mute);
    }
    /* A finished answer's footer: a status word when the answer was stopped or failed. */
    .foot {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .status.failed {
      color: var(--color-danger);
    }
    /* The whole chat has finished turns not yet on the server (5): a quiet caption so
       the reader knows not to close the page yet. */
    .unsaved {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .offline {
      margin: auto;
      padding: var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      text-align: center;
    }
  `;

  #actor = new ActorController(this);
  // Which thinking records are open (ephemeral view state, closed by default).
  #openThinking = new Set();
  // Whether the transcript is pinned to the bottom, so it follows a streaming answer
  // but leaves the reader where they scrolled if they scrolled up.
  #stick = true;

  #onScroll(event) {
    const el = event.currentTarget;
    this.#stick = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLOP;
  }

  updated() {
    if (!this.#stick) return;
    const el = this.renderRoot.querySelector(".transcript");
    if (el) el.scrollTop = el.scrollHeight;
  }

  #toggleThinking(id) {
    if (this.#openThinking.has(id)) this.#openThinking.delete(id);
    else this.#openThinking.add(id);
    this.requestUpdate();
  }

  // dock-desk's Ctrl+h/j/k/l (12) and list-then-item focus a panel by its host: land
  // in the box the page slotted below the transcript, where the next question is typed.
  focus(options) {
    const box = this.renderRoot?.querySelector("slot")?.assignedElements()[0];
    if (box) box.focus(options);
    else super.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    return html`
      ${this.#header(snapshot)}
      <div class="transcript" @scroll=${(e) => this.#onScroll(e)}>${this.#body(snapshot)}</div>
      <div class="composer"><slot></slot></div>
    `;
  }

  // The pin keeps the open chat when the subject changes (12). Disabled while no chat is
  // open; its label names the action for assistive tech.
  #header(snapshot) {
    if (!snapshot) return nothing;
    const { openId, pin } = snapshot.context;
    const pinned = openId != null && pin === openId;
    return html`
      <div class="header">
        <button
          class="pin"
          type="button"
          aria-pressed=${pinned}
          aria-label=${pinned ? "Unpin chat" : "Pin chat"}
          ?disabled=${openId == null}
          @click=${() => this.#actor.send({ type: "_togglePin" })}
        >
          ${icon("push-pin")}
        </button>
      </div>
    `;
  }

  #body(snapshot) {
    if (!snapshot) return nothing;
    if (snapshot.matches("unavailable")) return html`<p class="offline">Chats need a connection.</p>`;
    const chat = snapshot.context.conversation;
    const turns = chat?.turns ?? [];
    return html`
      ${turns.map((turn) => (turn.role === "user" ? this.#user(turn) : this.#assistant(turn)))}
      ${chat?.pending ? html`<p class="unsaved">Not saved yet</p>` : nothing}
    `;
  }

  // The reader's own message. A turn that only carries tool results has no text (7.7): it
  // is for the model, not the reader, so it shows nothing rather than an empty bubble.
  #user(turn) {
    if (!turn.text) return nothing;
    return html`<div class="turn user">
      ${userParagraphs(turn.text).map((block) => (block ? html`<p class="para">${block}</p>` : html`<div class="gap"></div>`))}
    </div>`;
  }

  #assistant(turn) {
    const pending = turn.status === "pending";
    const hasText = Boolean(turn.text);
    // Before any text: a neutral pulse, or "Thinking…" only when the model is really
    // thinking (12: a live line says what the model is doing).
    const waiting =
      pending && !hasText
        ? turn.thinking
          ? html`<p class="working">Thinking…</p>`
          : html`<p class="working"><span class="dots">● ● ●</span></p>`
        : nothing;
    return html`
      <div class="turn assistant">
        ${turn.thinking && !(pending && !hasText) ? this.#thinking(turn) : nothing}
        ${waiting}
        ${hasText
          ? this.markdown
            ? html`<div class="answer prose">${parseMarkdown(turn.text).map((block) => this.#block(block))}</div>`
            : html`<div class="answer">${turn.text}</div>`
          : nothing}
        ${this.#lookups(turn)}
        ${this.#foot(turn)}
      </div>
    `;
  }

  // The lookups this answer asked for (7.7): a dim line per recognised tool call. A call
  // the system did not recognise (`invalid`) is not named as a lookup — it was rejected,
  // not run.
  #lookups(turn) {
    const named = (turn.calls ?? []).filter((call) => !call.invalid);
    if (!named.length) return nothing;
    return html`<div class="lookups">${named.map((call) => html`<span>${call.label}</span>`)}</div>`;
  }

  // One markdown block (10). Every text run interpolates through Lit as an escaped text
  // node, so nothing the model wrote reaches the page as HTML; only these known tags are
  // real elements. A heading uses its own level's tag for meaning; the level is bounded to
  // 1–6 by the parser.
  #block(block) {
    switch (block.type) {
      case "heading":
        return this.#heading(block);
      case "list": {
        const items = block.items.map((item) => html`<li>${item.blocks.map((b) => this.#block(b))}</li>`);
        return block.ordered ? html`<ol class="md-list" start=${block.start}>${items}</ol>` : html`<ul class="md-list">${items}</ul>`;
      }
      case "quote":
        return html`<blockquote class="md-quote">${block.blocks.map((b) => this.#block(b))}</blockquote>`;
      case "code":
        return html`<pre class="md-code"><code>${block.text}</code></pre>`;
      default:
        return html`<p class="md-p">${this.#inline(block.inline)}</p>`;
    }
  }

  #heading(block) {
    const inner = this.#inline(block.inline);
    switch (block.level) {
      case 1:
        return html`<h1 class="md-h">${inner}</h1>`;
      case 2:
        return html`<h2 class="md-h">${inner}</h2>`;
      case 3:
        return html`<h3 class="md-h">${inner}</h3>`;
      case 4:
        return html`<h4 class="md-h">${inner}</h4>`;
      case 5:
        return html`<h5 class="md-h">${inner}</h5>`;
      default:
        return html`<h6 class="md-h">${inner}</h6>`;
    }
  }

  #inline(nodes) {
    return nodes.map((node) => {
      switch (node.type) {
        case "break":
          return html`<br />`;
        case "code":
          return html`<code class="md-code-inline">${node.value}</code>`;
        case "strong":
          return html`<strong>${this.#inline(node.inline)}</strong>`;
        case "em":
          return html`<em>${this.#inline(node.inline)}</em>`;
        default:
          return node.value;
      }
    });
  }

  #thinking(turn) {
    const open = this.#openThinking.has(turn.id);
    return html`
      <details
        class="thinking"
        ?open=${open}
        @toggle=${(e) => {
          if (e.currentTarget.open !== open) this.#toggleThinking(turn.id);
        }}
      >
        <summary>Thinking</summary>
        <div class="text">${turn.thinking}</div>
      </details>
    `;
  }

  // A stopped or failed answer names what happened; a done answer needs no footer.
  #foot(turn) {
    if (turn.status === "stopped") return html`<div class="foot"><span class="status">Stopped.</span></div>`;
    if (turn.status === "failed") return html`<div class="foot"><span class="status failed">${errorText(turn.error)}</span></div>`;
    return nothing;
  }
}

customElements.define("chat-thread", ChatThread);
