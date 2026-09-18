import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import opened from "./events/note.opened.json" with { type: "json" };
import refused from "./events/note.refused.json" with { type: "json" };

// The pinned note's id, kept across reloads (D10): the view's own UI state under a key
// named for the role, so this editor and note-editor-cm6 share it and a composer swap
// keeps the pin. Read and written through the machine's input so the machine stays
// importable in Node. Wrapped like settings/store.js so a browser refusing storage
// reads null and drops the write.
const KEY = "note-editor.pinned";
const pinStore = {
  recall() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  remember(id) {
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the pin lives only for this page.
    }
  },
};

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's flash window;
// the token is the one clock, the same --duration-undo note-list reads for its undo bar.
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // The flash window comes from --duration-undo, read off the host so a stylesheet or
    // a test can set it; the machine only ever sees the number (importable in Node).
    const flashMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        mint: ulid,
        focus: () => this.host.renderRoot?.querySelector("textarea")?.focus(),
        // The attributes are parsed by the time hostConnected runs, so the actor is
        // born knowing whether it follows the selection (6.4) and the stage (D5).
        follows: this.host.follows,
        subjecting: this.host.subject,
        recall: pinStore.recall,
        remember: pinStore.remember,
        flashMs,
      },
      events: { "note.saved": saved, "note.opened": opened, "note.refused": refused },
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

// The body's least height, in lines: a factor on the type tokens, not a length (7.4).
const MIN_LINES = 8;

class NoteEditor extends LitElement {
  // The one attribute the tag understands: how the editor takes its height.
  // "content" (the default) starts at MIN_LINES and grows with the text; "fill"
  // takes the height its container leaves. In both, the body never grows past the
  // container: it scrolls inside, so the status line stays in view and the page
  // does not scroll. Width is the container's in either mode; a measure is the
  // composing view's decision, not the editor's.
  static properties = {
    height: { type: String, reflect: true },
    // Whether this editor loads whatever the list selects (6.4). Reflected so the
    // page's bare `follows` reads as true and the manifest attribute is visible.
    follows: { type: Boolean, reflect: true },
    // Whether this editor follows the stage and offers the pin (D5). Reflected so the
    // page's bare `subject` reads as true and the manifest attribute is visible. Off is
    // exactly today's behaviour.
    subject: { type: Boolean, reflect: true },
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
    .editor {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      gap: var(--space-sm);
      padding: var(--space-md);
      box-sizing: border-box;
    }
    /* The header (only while following the stage): what the note is about on the left,
       the pin on the right. It keeps its height with an empty About line so the textarea
       below does not jump as the About line comes and goes. */
    .header {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      min-height: var(--space-lg);
    }
    .about {
      flex: 1;
      min-width: 0;
      font-size: var(--text-caption);
      color: var(--color-mute);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The pin: a toggle, muted while following, accent when pinned, its border flashing
       danger when it refused a change (D7). One icon, sized by the caption type. */
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
    .pin:hover:not(:disabled) {
      color: var(--color-ink);
    }
    .pin[aria-pressed="true"] {
      color: var(--color-accent);
    }
    .pin.flashing {
      border-color: var(--color-danger);
    }
    .pin:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .pin:focus-visible {
      outline: var(--focus-ring);
    }
    textarea {
      font: inherit;
      color: var(--color-ink);
      background: none;
      border: none;
      padding: 0;
      width: 100%;
      box-sizing: border-box;
      /* Sized by its text, never under MIN_LINES of it (content mode); a flex item
         that shrinks, so when the container is smaller than the text it stops at
         the container and scrolls inside, and the status below stays in view. */
      field-sizing: content;
      flex: 0 1 auto;
      min-height: calc(var(--text-body) * var(--leading-normal) * ${MIN_LINES});
      /* Text only ever scrolls down: a word too long for the line breaks, and no
         browser gets to show a horizontal bar. */
      overflow: hidden auto;
      overflow-wrap: anywhere;
      resize: none;
      line-height: var(--leading-normal);
    }
    :host([height="fill"]) textarea {
      flex: 1;
      min-height: 0;
    }
    textarea:focus {
      outline: none;
    }
    textarea:focus-visible {
      outline: var(--focus-ring);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    .status {
      flex: none;
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
  `;

  #actor = new ActorController(this);

  #typed() {
    const body = this.renderRoot.querySelector("textarea")?.value ?? "";
    this.#actor.send({ type: "_typed", body });
  }

  #blurred() {
    this.#actor.send({ type: "_blurred" });
  }

  #togglePin() {
    this.#actor.send({ type: "_togglePin" });
  }

  // The About line (D7): the subject the open note's first link names, when that subject
  // was seen this session; nothing otherwise (D9). The list never learns kinds — the
  // title comes from what subject.changed carried.
  #aboutTitle(context) {
    const link = context.about?.[0];
    if (!link) return null;
    return context.titles?.[`${link.kind}:${link.id}`] ?? null;
  }

  // The actor's state, said plainly: the user's wish to see what state the view is
  // in, for this view directly.
  #status(snapshot) {
    if (snapshot.matches("starting")) return "";
    if (snapshot.matches("empty")) return "New note";
    if (snapshot.matches("blank")) return "New note";
    if (snapshot.matches("failed")) return "notes unavailable";
    if (snapshot.matches({ editing: "dirty" })) return "Unsaved";
    if (snapshot.matches({ editing: "clean" })) return "Saved";
    return "";
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { body, subjecting, pinned, flashing, id } = snapshot.context;
    const aboutTitle = this.#aboutTitle(snapshot.context);
    return html`
      <div class="editor">
        ${subjecting ? this.#header(aboutTitle, pinned, flashing, id) : nothing}
        <textarea
          aria-label="Note"
          placeholder="Write…"
          .value=${body}
          @input=${this.#typed}
          @blur=${this.#blurred}
        ></textarea>
        <p class="status">${this.#status(snapshot)}</p>
      </div>
    `;
  }

  // The header shown only while following the stage (D7): the About line, and the pin
  // toggle. The pin is disabled while the editor holds no note; its label names the
  // action for assistive tech, its colour follows the state (accent when pinned), and
  // its border flashes danger after it refuses a change.
  #header(aboutTitle, pinned, flashing, id) {
    return html`
      <div class="header">
        <span class="about">${aboutTitle ? html`About: ${aboutTitle}` : nothing}</span>
        <button
          class="pin ${flashing ? "flashing" : ""}"
          type="button"
          aria-pressed=${pinned}
          aria-label=${pinned ? "Unpin note" : "Pin note"}
          ?disabled=${!id}
          @click=${this.#togglePin}
        >
          ${icon("push-pin")}
        </button>
      </div>
    `;
  }
}

customElements.define("note-editor", NoteEditor);
