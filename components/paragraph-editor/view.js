import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { EditorState } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, readout } from "./machine.js";

// The prototype's view: one CodeMirror 6 document holds the stored text exactly, so what
// the readout shows is what the box holds. The setup and the paragraph rule are the
// editor kit's (architecture.md 10).

const DRAFT = "paragraph-editor.draft";

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
        draft: read(),
        save: write,
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

  send(event) {
    this.actor?.send(event);
  }
}

// Storage can be refused (a private window); the box then simply starts empty.
function read() {
  try {
    return localStorage.getItem(DRAFT) ?? "";
  } catch {
    return "";
  }
}

function write(text) {
  try {
    localStorage.setItem(DRAFT, text);
  } catch {}
}

class ParagraphEditor extends LitElement {
  static properties = {
    height: { type: String, reflect: true },
  };

  // A panel's focus lands in what it shows: delegating it puts the keyboard in the box.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    .page {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      container-type: inline-size;
    }
    .sheet {
      box-sizing: border-box;
      max-width: calc(var(--space-2xl) * 11);
      margin: 0 auto;
      padding: var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: var(--space-lg);
    }
    .hint {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* The box is tall enough to be seen as a place to write before anything is in it,
       and a click anywhere in it lands in the text. */
    .box {
      display: flex;
      flex-direction: column;
      min-height: calc(var(--space-2xl) * 3);
      padding: var(--space-sm) var(--space-md);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .box:focus-within {
      border-color: var(--color-border-strong);
    }
    .box .cm-editor {
      flex: 1;
    }
    .saved h2 {
      margin: 0 0 var(--space-xs);
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      color: var(--color-body);
    }
    .lines {
      margin: 0;
      font-family: var(--font-mono);
      font-size: var(--text-caption);
      line-height: var(--leading-normal);
      color: var(--color-ink);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .mark {
      color: var(--color-body-mid);
    }
    .none {
      color: var(--color-body-mid);
    }
    @container (width < 30rem) {
      .sheet {
        padding: var(--space-md);
      }
    }
  `;

  #actor = new ActorController(this);
  #view = null;

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#view?.destroy();
    this.#view = null;
  }

  focus(options) {
    if (this.#view) this.#view.focus();
    else super.focus(options);
  }

  #extensions(vimOn) {
    return [
      ...baseExtensions({ vim: vimOn }),
      paragraphs(),
      placeholder("Write here. Enter starts a new paragraph; Shift+Enter breaks the line."),
      EditorView.contentAttributes.of({ "aria-label": "Paragraphs" }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.#actor.send({ type: "_edit", text: update.state.doc.toString() });
      }),
    ];
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    const box = this.renderRoot.querySelector(".box");
    if (!snapshot || !box) return;
    const { text, vimKeys } = snapshot.context;
    if (!this.#view || this.#view.dom.parentNode !== box) {
      this.#view?.destroy();
      this.#view = new EditorView({
        parent: box,
        // Shadow DOM: CodeMirror reads the selection through the root and mounts its
        // stylesheet there, so it must know the shadow root.
        root: this.renderRoot,
        state: EditorState.create({ doc: text, extensions: this.#extensions(vimKeys) }),
      });
    }
    setVim(this.#view, vimKeys);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { text } = snapshot.context;
    return html`
      <div class="page">
        <div class="sheet">
          <p class="hint">A prototype for paragraph spacing. Enter starts a new paragraph with a gap above it; Shift+Enter breaks the line with no gap.</p>
          <div class="box"></div>
          <section class="saved" aria-label="What is saved">
            <h2>What is saved</h2>
            ${text === ""
              ? html`<p class="lines none">Nothing yet.</p>`
              : html`<p class="lines">${readout(text).map(
                  (line) =>
                    html`${line.blank ? html`<span class="mark">¶</span>` : line.text}${line.broken
                      ? html`<span class="mark">↵</span>\n`
                      : nothing}`,
                )}</p>`}
          </section>
        </div>
      </div>
    `;
  }
}

customElements.define("paragraph-editor", ParagraphEditor);
