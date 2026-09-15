import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { machine } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import opened from "./events/note.opened.json" with { type: "json" };

// The rich member of the note-editor role (7.3): the same one-text model as the
// plain editor, drawn so the first line reads as a title. The text stays plain —
// styling is token-driven (::first-line), never markup — so what the fact holds is
// still one string, and this view is interchangeable with note-editor.

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
        mint: ulid,
        focus: () => this.host.renderRoot?.querySelector(".region")?.focus(),
        follows: this.host.follows,
      },
      events: { "note.saved": saved, "note.opened": opened },
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

class NoteEditorRich extends LitElement {
  static properties = {
    height: { type: String, reflect: true },
    follows: { type: Boolean, reflect: true },
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
    /* One plain-text region; the first line is drawn as a title through
       ::first-line, so the text the fact holds stays one string (no markup). A
       block that grows with its content, capped at the container so the status
       stays in view and the page does not scroll — the div equivalent of the
       textarea's field-sizing. */
    .region {
      font: inherit;
      color: var(--color-ink);
      width: 100%;
      box-sizing: border-box;
      flex: 0 1 auto;
      min-height: calc(var(--text-body) * var(--leading-normal) * ${MIN_LINES});
      overflow: hidden auto;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      line-height: var(--leading-normal);
    }
    :host([height="fill"]) .region {
      flex: 1;
      min-height: 0;
    }
    .region::first-line {
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    .region:empty::before {
      content: "Write…";
      color: var(--color-mute);
    }
    .region:focus {
      outline: none;
    }
    .region:focus-visible {
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
  // The text last written into the region, so an echoed note.changed carrying the
  // same body does not rewrite the DOM and lose the caret (4.3, fourth rule).
  #shown = "";

  #typed() {
    const body = this.renderRoot.querySelector(".region")?.innerText ?? "";
    this.#shown = body;
    this.#actor.send({ type: "_typed", body });
  }

  #blurred() {
    this.#actor.send({ type: "_blurred" });
  }

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
    // The region's text is set imperatively in updated(), never bound here, so a
    // re-render never disturbs the caret; only a body from elsewhere rewrites it.
    return html`
      <div class="editor">
        <div
          class="region"
          contenteditable="plaintext-only"
          role="textbox"
          aria-multiline="true"
          aria-label="Note"
          @input=${this.#typed}
          @blur=${this.#blurred}
        ></div>
        <p class="status">${this.#status(snapshot)}</p>
      </div>
    `;
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return;
    const region = this.renderRoot.querySelector(".region");
    const { body } = snapshot.context;
    // Only when the body differs from what is shown: a note loaded or adopted from
    // elsewhere, never the user's own keystroke (which set #shown before sending).
    if (region && body !== this.#shown) {
      region.textContent = body;
      this.#shown = body;
    }
  }
}

customElements.define("note-editor-rich", NoteEditorRich);
