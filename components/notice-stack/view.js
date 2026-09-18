import { LitElement, html, css, nothing } from "lit";
import { mount, unmount } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's fade
// window; the token is the one clock, shared with the timer bar's animation.
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// The words for a notice live here, not in the machine (a view owns its own text).
// One case per source; a future refusal or event adds one line, nothing else.
function describe(source) {
  if (source.type === "note.conflicted") {
    const title = source.theirs.title || "your note";
    return source.gone
      ? `“${title}” was deleted elsewhere, so your edit could not be kept.`
      : `Your edit to “${title}” clashed with a newer copy. Keep yours, or dismiss to take theirs.`;
  }
  // book.refused, note.refused and session.refused all carry a `reason`, but from
  // different vocabularies, so each is read first by its event type.
  if (source.type === "book.refused") {
    switch (source.reason) {
      case "signed-out":
        return "Sign in to add books.";
      case "unreadable":
        return "This file is not an epub.";
      default:
        return "The server is unavailable. Try again in a moment.";
    }
  }
  if (source.type === "note.refused") {
    return "This note is pinned. Unpin it to open another.";
  }
  switch (source.reason) {
    case "cancelled":
      return "Sign-in was cancelled.";
    case "unavailable":
      return "The server is unavailable. Try again in a moment.";
    case "registration-closed":
      return "Registration is closed, so a new passkey cannot be created here.";
    case "unknown-credential":
      return "This passkey is not known here.";
    default:
      return "That could not be done.";
  }
}

const ACTION_LABELS = { "keep-mine": "Keep mine" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // The fade window comes from --duration-undo (the same "you can still act"
    // clock the undo bar uses); the machine only ever sees the number, so it stays
    // importable in Node.
    const fadeMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: { fadeMs },
      events: { "note.saved": saved },
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

class NoticeStack extends LitElement {
  static styles = css`
    /* Fixed above the viewport switch (7.5's document check flags only document.*
       writes; this writes the stack's own host). A bounded column that hugs the
       corner like every fixed control, so in a phone preview it sits beside the
       frame as the switch does, and on a real phone spans the gutters. The gaps
       between toasts pass clicks through; each toast takes them back. */
    :host {
      position: fixed;
      inset: auto var(--space-md) calc(var(--space-md) + var(--space-2xl)) var(--space-md);
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: var(--space-xs);
      pointer-events: none;
      z-index: 3;
    }
    .notice {
      pointer-events: auto;
      box-sizing: border-box;
      max-width: 100%;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: var(--space-sm);
      align-items: start;
      padding: var(--space-sm) var(--space-md);
      background: var(--color-warning-subtle);
      border: var(--border-width) solid var(--color-warning);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
      font-size: var(--text-sm);
      line-height: var(--leading-normal);
      color: var(--color-body);
      overflow: hidden;
    }
    .glyph {
      display: flex;
      color: var(--color-warning);
    }
    .glyph svg {
      display: block;
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      min-width: 0;
    }
    p {
      margin: 0;
    }
    .act {
      align-self: flex-start;
      border: none;
      cursor: pointer;
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: inherit;
      font-weight: var(--weight-semibold);
      color: var(--color-canvas);
      background: var(--color-accent);
    }
    .act:hover {
      background: var(--color-accent-hover);
    }
    .act:focus-visible {
      outline: var(--focus-ring);
    }
    .dismiss {
      display: flex;
      border: none;
      background: none;
      cursor: pointer;
      padding: 0;
      color: var(--color-body-mid);
    }
    .dismiss svg {
      display: block;
    }
    .dismiss:hover {
      color: var(--color-ink);
    }
    .dismiss:focus-visible {
      outline: var(--focus-ring);
    }
    /* The passing notice echoes its window as a hairline that drains, both reading
       --duration-undo so they cannot disagree; hover or focus pauses it in step
       with the machine's hold. */
    .timer {
      grid-column: 1 / -1;
      height: var(--border-width);
      background: var(--color-warning);
      transform-origin: left;
      animation: drain var(--duration-undo) linear forwards;
    }
    .notice:hover .timer,
    .notice:focus-within .timer {
      animation-play-state: paused;
    }
    @keyframes drain {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0);
      }
    }
  `;

  #actor = new ActorController(this);

  #onKeydown(event) {
    if (event.key !== "Escape") return;
    const keys = [...(this.#actor.snapshot?.context.notices.keys() ?? [])];
    if (keys.length) this.#actor.send({ type: "_dismiss", key: keys[keys.length - 1] });
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const notices = [...snapshot.context.notices.values()];
    if (!notices.length) return nothing;
    return html`
      <div @keydown=${(e) => this.#onKeydown(e)}>
        ${notices.map((n) => {
          const source = { ...n.source, gone: n.gone };
          return html`
            <div
              class="notice"
              role=${n.standing ? "alert" : "status"}
              @mouseenter=${() => this.#actor.send({ type: "_hold", key: n.key })}
              @mouseleave=${() => this.#actor.send({ type: "_release", key: n.key })}
              @focusin=${() => this.#actor.send({ type: "_hold", key: n.key })}
              @focusout=${() => this.#actor.send({ type: "_release", key: n.key })}
            >
              <span class="glyph">${icon("warning")}</span>
              <div class="body">
                <p>${describe(source)}</p>
                ${n.actions.map(
                  (a, i) => html`
                    <button class="act" @click=${() => this.#actor.send({ type: "_act", key: n.key, index: i })}>
                      ${ACTION_LABELS[a.label] ?? a.label}
                    </button>
                  `,
                )}
              </div>
              <button
                class="dismiss"
                aria-label="Dismiss"
                @click=${() => this.#actor.send({ type: "_dismiss", key: n.key })}
              >
                ${icon("x")}
              </button>
              ${n.standing ? nothing : html`<div class="timer"></div>`}
            </div>
          `;
        })}
      </div>
    `;
  }
}

customElements.define("notice-stack", NoticeStack);
