import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine } from "./machine.js";

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
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    /* The model's answer: plain text across the width, its line breaks kept. The
       architecture has no markdown renderer (10, the Rich editor row: no markdown
       grammar). */
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

  render() {
    const snapshot = this.#actor.snapshot;
    return html`
      <div class="transcript" @scroll=${(e) => this.#onScroll(e)}>${this.#body(snapshot)}</div>
      <div class="composer"><slot></slot></div>
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
    return html`<div class="turn user">${turn.text}</div>`;
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
        ${hasText ? html`<div class="answer">${turn.text}</div>` : nothing}
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
