import { LitElement, html, css, render } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseExtensions, setVim, paragraphs, sourceLinks, webLinks, hashtags, refreshHashtags, hashtagPicker, lineMarks, setLineMarks } from "editor";
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

const SAMPLE_TAGS = [
  { tag: "in-my-control", description: "Whether each line is in your control, partly, or not" },
  { tag: "inner-critic", description: "Whether a line speaks in the voice of the inner critic" },
  { tag: "thinking-traps", description: "" },
];

class EditorSample extends LitElement {
  // `text` is the editor's text both ways: the page gives the starting text, setting it
  // replaces the document, and typing keeps it current, so a test can seed and read it.
  // `known` (the hashtag names drawn as known) and `marks` (an object from a line's text to
  // the names of its marks) are properties only, a stand-in for an editor's actor, so a
  // test can try the kit's hashtags and line marks.
  static properties = {
    text: { type: String },
    known: { attribute: false },
    marks: { attribute: false },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .mark {
      padding: 0 var(--space-2xs);
      border-radius: var(--radius-sm);
      background: var(--color-accent-subtle);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
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
    this.known = [];
    this.marks = {};
  }

  #extensions() {
    return [
      ...baseExtensions({ vim: this.#actor.snapshot?.context.vimKeys === true }),
      paragraphs({ box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      // A source link needs `notes` to follow it, and this page has none (8).
      sourceLinks({ follow: () => {}, icon: (into) => render(icon("link"), into) }),
      webLinks(),
      hashtags({ known: (name) => this.known.includes(name) }),
      // A fixed list stands in for the account's evaluators, which this page has none of (8).
      hashtagPicker({ tags: () => SAMPLE_TAGS }),
      // The kit's style sheet sits in the shadow root, so a mark drawn here takes .mark.
      lineMarks({ render: (into, marks) => render(marks.map((m) => html`<span class="mark">${m}</span>`), into) }),
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

  updated(changed) {
    // Built here rather than once, so the document comes back if the tag is put back.
    if (!this.#view) this.#build();
    setVim(this.#view, this.#actor.snapshot?.context.vimKeys === true);
    if (changed.has("known")) refreshHashtags(this.#view);
    if (changed.has("marks")) this.#view.dispatch({ effects: setLineMarks.of(new Map(Object.entries(this.marks ?? {}))) });
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
