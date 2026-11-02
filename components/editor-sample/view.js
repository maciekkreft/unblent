import { LitElement, html, css, render } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseExtensions, setVim, paragraphs, sourceLinks, webLinks } from "editor";
import { machine } from "./machine.js";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
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

// The kit's theme is the base; the editor fills its region and scrolls inside it.
const fill = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
});

class EditorSample extends LitElement {
  // `text` is the editor's text both ways: the page gives the starting text, setting it
  // replaces the document, and typing keeps it current, so a test can seed and read it.
  static properties = {
    text: { type: String },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .region {
      flex: 1;
      min-height: 0;
      padding: var(--space-md);
      box-sizing: border-box;
      color: var(--color-ink);
      line-height: var(--leading-normal);
      overflow: hidden;
    }
  `;

  #actor = new ActorController(this);
  #view = null;
  // The text last written into or read out of the document, so setting `text` to what
  // was just typed does not rewrite the document and lose the cursor.
  #shown = "";

  constructor() {
    super();
    this.text = "";
  }

  #extensions() {
    return [
      ...baseExtensions({ vim: this.#actor.snapshot?.context.vimKeys === true }),
      paragraphs({ box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      // A source link needs `notes` to follow it, and this page has none (8).
      sourceLinks({ follow: () => {}, icon: (into) => render(icon("link"), into) }),
      webLinks(),
      fill,
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        this.#shown = update.state.doc.toString();
        this.text = this.#shown;
      }),
    ];
  }

  #build() {
    this.#shown = this.text;
    this.#view = new EditorView({
      parent: this.renderRoot.querySelector(".region"),
      // Shadow DOM: CM6 reads the selection through the root and style-mod mounts its
      // sheet there, not on document (7.5).
      root: this.renderRoot,
      state: EditorState.create({ doc: this.text, extensions: this.#extensions() }),
    });
  }

  updated() {
    // Built here rather than once, so the document comes back if the tag is put back.
    if (!this.#view) this.#build();
    setVim(this.#view, this.#actor.snapshot?.context.vimKeys === true);
    if (this.text === this.#shown) return;
    this.#shown = this.text;
    this.#view.dispatch({ changes: { from: 0, to: this.#view.state.doc.length, insert: this.text } });
  }

  disconnectedCallback() {
    this.#view?.destroy();
    this.#view = null;
    super.disconnectedCallback();
  }

  // .region has no bindings, so Lit never touches CM6's subtree on re-render.
  render() {
    return html`<div class="region" role="textbox" aria-label="Sample text"></div>`;
  }
}

customElements.define("editor-sample", EditorSample);
