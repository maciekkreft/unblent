import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { machine } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import opened from "./events/note.opened.json" with { type: "json" };

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
        focus: () => this.host.renderRoot?.querySelector("textarea")?.focus(),
        // The attribute is parsed by the time hostConnected runs, so the actor is
        // born knowing whether it follows the selection (6.4).
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

  // The actor's state, said plainly: the user's wish to see what state the view is
  // in, for this view directly.
  #status(snapshot) {
    if (snapshot.matches("starting")) return "";
    if (snapshot.matches("empty")) return "New note";
    if (snapshot.matches("blank")) return "New note";
    if (snapshot.matches("failed")) return "notes unavailable";
    if (snapshot.matches({ editing: "dirty" })) return "Unsaved";
    if (snapshot.matches({ editing: "clean" })) {
      const { baseVersion } = snapshot.context;
      return baseVersion != null ? `Saved · v${baseVersion}` : "Saved";
    }
    return "";
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { body } = snapshot.context;
    return html`
      <div class="editor">
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
}

customElements.define("note-editor", NoteEditor);
