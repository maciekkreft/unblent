import { LitElement, html, css, nothing } from "lit";
import { mount, unmount } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import undone from "./events/removal.undone.json" with { type: "json" };
import settled from "./events/removal.settled.json" with { type: "json" };
import useReset from "./events/use.reset.json" with { type: "json" };
import guestBlocked from "./events/guest.blocked.json" with { type: "json" };

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
// A removal names the thing the way the user sees it: a rubric is a Detector, and
// a question or an option is removed from its evaluator rather than deleted outright.
const REMOVED = {
  project: ["Project", "deleted"],
  rubric: ["Detector", "deleted"],
  case: ["Case", "deleted"],
  evaluator: ["Evaluator", "deleted"],
  "choice-point": ["Choice point", "deleted"],
  question: ["Question", "removed"],
  option: ["Option", "removed"],
};

function describe(source) {
  if (source.type === "removal.started") {
    const [noun, verb] = REMOVED[source.kind] ?? ["Item", "deleted"];
    return source.name ? `${noun} “${source.name}” ${verb}.` : `${noun} ${verb}.`;
  }
  if (source.type === "use.reset") return "Use reset to $0.";
  if (source.type === "guest.blocked") return source.blocked ? "Guest blocked." : "Guest unblocked.";
  if (source.type === "note.conflicted") {
    const title = source.theirs.title || "your note";
    return source.gone
      ? `“${title}” was deleted elsewhere, so your edit could not be kept.`
      : `Your edit to “${title}” clashed with a newer copy. Keep yours, or dismiss to take theirs.`;
  }
  // book.refused and session.refused both carry a `reason`, but from
  // different vocabularies, so each is read first by its event type.
  if (source.type === "book.refused") {
    switch (source.reason) {
      case "signed-out":
        return "Sign in to continue.";
      case "unreadable":
        return "This file is not an epub.";
      default:
        return "The server is unavailable. Try again in a moment.";
    }
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
    case "unsaved":
      return "Not switched: some changes are not saved yet. Try again when you are online.";
    default:
      return "That could not be done.";
  }
}

const ACTION_LABELS = { "keep-mine": "Keep mine", undo: "Undo" };

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
      events: {
        "note.saved": saved,
        "removal.undone": undone,
        "removal.settled": settled,
        "use.reset": useReset,
        "guest.blocked": guestBlocked,
      },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
    // A closed tab completes its deletes (the facts also settle at load).
    this.onPagehide = () => this.actor.send({ type: "_leave" });
    window.addEventListener("pagehide", this.onPagehide);
  }

  hostDisconnected() {
    window.removeEventListener("pagehide", this.onPagehide);
    // A removed stack leaves no removal waiting for an Undo no one can press.
    this.actor.send({ type: "_leave" });
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
    /* A removal is news with a way back, not a warning: dark, with Undo in the
       accent, as the mockup shows. */
    .notice.removal {
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      background: var(--color-ink);
      border-color: var(--color-ink);
      color: var(--color-canvas);
    }
    .removal .undo {
      border: none;
      cursor: pointer;
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: inherit;
      font-weight: var(--weight-semibold);
      color: var(--color-accent);
      background: none;
    }
    .removal .undo:hover {
      color: var(--color-accent-hover);
    }
    .removal .undo:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .removal .dismiss {
      align-self: center;
      color: var(--color-mute);
    }
    .removal .dismiss:hover {
      color: var(--color-canvas);
    }
    .removal .timer {
      background: var(--color-accent);
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
      outline: none;
      box-shadow: var(--focus-ring);
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
      outline: none;
      box-shadow: var(--focus-ring);
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
    // The wrapper stays in the page so a screen reader is already watching it when a
    // notice arrives; a region inserted with its content is often not announced.
    return html`
      <div aria-live="polite" @keydown=${(e) => this.#onKeydown(e)}>
        ${notices.map((n) => {
          const source = { ...n.source, gone: n.gone };
          const hold = {
            enter: () => this.#actor.send({ type: "_hold", key: n.key }),
            leave: () => this.#actor.send({ type: "_release", key: n.key }),
          };
          if (n.undo)
            return html`
              <div
                class="notice removal"
                role="status"
                @mouseenter=${hold.enter}
                @mouseleave=${hold.leave}
                @focusin=${hold.enter}
                @focusout=${hold.leave}
              >
                <p>${describe(source)}</p>
                ${n.actions.map(
                  (a, i) => html`
                    <button class="undo" @click=${() => this.#actor.send({ type: "_act", key: n.key, index: i })}>
                      ${ACTION_LABELS[a.label] ?? a.label}
                    </button>
                  `,
                )}
                <button class="dismiss" aria-label="Dismiss" @click=${() => this.#actor.send({ type: "_dismiss", key: n.key })}>
                  ${icon("x")}
                </button>
                <div class="timer"></div>
              </div>
            `;
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
