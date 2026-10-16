import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { EditorState, EditorSelection, RangeSetBuilder, Prec, Compartment } from "@codemirror/state";
import { EditorView, Decoration, keymap, drawSelection, placeholder } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap, isolateHistory } from "@codemirror/commands";
import { vim } from "@replit/codemirror-vim";
import { machine, enterAt, breakAt, backspaceAt, deleteAt, isGap, pastGap, readout } from "./machine.js";

// The prototype's view: one CodeMirror 6 document holds the stored text exactly, so what
// the readout shows is what the box holds. The theme and the Vim compartment are copied
// from journal-entry, because components never import each other (11.2).

const DRAFT = "paragraph-editor.draft";

const theme = EditorView.theme({
  "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "var(--leading-normal)" },
  // The caret at column 0 is drawn 0.6px left of the text, so .cm-content needs a
  // sliver of side padding or the scroller's overflow clip eats it.
  ".cm-content": { caretColor: "var(--color-accent)", padding: "0 var(--space-2xs)" },
  ".cm-line": { fontSize: "var(--text-body)", padding: "0" },
  // A gap reads as the space between two paragraphs, about three quarters of a line,
  // so it is told apart from a line break (no space) and from an empty line (a full one).
  ".cm-line.cm-gap": { height: "calc((var(--space-sm) + var(--space-md)) / 2)", overflow: "hidden" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
  ".cm-placeholder": { color: "var(--color-mute)" },
});

// The Vim plugin ships its own Prec.highest theme for the block cursor in colours that
// are not tokens; this one outranks it. Unfocused, the cursor is hollowed with an inset
// shadow, because Safari clips the outline the plugin draws.
const fatCursorTheme = Prec.highest(
  EditorView.theme({
    ".cm-fat-cursor": {
      background: "var(--color-accent) !important",
      color: "var(--color-accent-text) !important",
    },
    "&:not(.cm-focused) .cm-fat-cursor": {
      background: "none !important",
      outline: "none !important",
      color: "var(--color-ink) !important",
      boxShadow: "inset 0 0 0 var(--border-width) var(--color-accent)",
    },
  }),
);

const vimExtensions = (on) => (on ? [vim(), fatCursorTheme] : []);

const gapLine = Decoration.line({ class: "cm-gap" });
const gaps = EditorView.decorations.compute(["doc", "selection"], (state) => {
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  const builder = new RangeSetBuilder();
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (isGap(line, cursorLine)) builder.add(line.from, line.from, gapLine);
  }
  return builder.finish();
});

// The cursor never rests on a gap: a move from the keyboard (arrows, Vim's j/k/h/l) that
// lands on a blank line carries on in the same direction (machine.js pastGap). A click is
// left where it lands, since there the user chose the place.
const overGaps = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection || tr.isUserEvent("select.pointer")) return tr;
  if (tr.selection.ranges.length !== 1) return tr;
  const doc = tr.state.doc;
  const before = tr.startState.selection.main.head;
  const range = tr.selection.main;
  const from = doc.lineAt(before);
  const to = doc.lineAt(range.head);
  if (from.number === to.number) return tr;
  const dir = to.number > from.number ? 1 : -1;
  const end = pastGap((n) => doc.line(n + 1).length === 0, doc.lines, to.number - 1, dir);
  if (end === null || end === to.number - 1) return tr;
  const line = doc.line(end + 1);
  // A one-character step enters the next line at its near end; a line move keeps the
  // column it came from. A line move from the end of a line onto a blank one is also a
  // step of one, and is told apart by the goal column CodeMirror gives a line move.
  const head =
    Math.abs(range.head - before) === 1 && range.goalColumn == null
      ? dir > 0
        ? line.from
        : line.to
      : line.from + Math.min(before - from.from, line.length);
  const selection = range.empty ? EditorSelection.cursor(head) : EditorSelection.range(range.anchor, head);
  return [tr, { selection, sequential: true }];
});

// Each edit is a pure function of the text (machine.js); one transaction each, so one
// Undo takes it back, and a joined gap is isolated so Undo never also takes the typing
// around it.
const apply = (fn, userEvent, isolate = false) => (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (state.selection.ranges.length !== 1) return false;
  const edit = fn(state.doc.toString(), range.from, range.to);
  if (!edit) return false;
  view.dispatch({
    changes: { from: edit.from, to: edit.to, insert: edit.insert },
    selection: EditorSelection.cursor(edit.cursor),
    scrollIntoView: true,
    userEvent,
    annotations: isolate ? isolateHistory.of("full") : [],
  });
  return true;
};

// Backspace and Delete join only from a bare cursor; with a selection they delete it.
const collapsed = (fn) => (text, from, to) => (from === to ? fn(text, from) : null);

const paragraphKeys = keymap.of([
  { key: "Enter", run: apply(enterAt, "input") },
  { key: "Shift-Enter", run: apply(breakAt, "input") },
  { key: "Backspace", run: apply(collapsed(backspaceAt), "delete.backward", true) },
  { key: "Delete", run: apply(collapsed(deleteAt), "delete.forward", true) },
]);

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
  #vim = new Compartment();
  #vimOn = false;

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
      // First: the Vim plugin must see a key before any other keymap does.
      this.#vim.of(vimExtensions(vimOn)),
      // Vim hides the native selection, so its visual-mode range shows only through
      // CodeMirror's own selection layer.
      drawSelection(),
      theme,
      gaps,
      overGaps,
      placeholder("Write here. Enter starts a new paragraph; Shift+Enter breaks the line."),
      history(),
      paragraphKeys,
      keymap.of(historyKeymap),
      keymap.of(defaultKeymap),
      EditorView.contentAttributes.of({ "aria-label": "Paragraphs" }),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) this.#actor.send({ type: "_edit", text: update.state.doc.toString() });
      }),
      // WebKit keeps the document's selection inside a blurred editor, and a later key
      // nobody cancels is typed there; dropping it on blur leaves nothing to type into.
      EditorView.domEventHandlers({
        blur: () => {
          document.getSelection()?.removeAllRanges();
        },
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
      this.#vimOn = vimKeys;
      this.#view = new EditorView({
        parent: box,
        // Shadow DOM: CodeMirror reads the selection through the root and mounts its
        // stylesheet there, so it must know the shadow root.
        root: this.renderRoot,
        state: EditorState.create({ doc: text, extensions: this.#extensions(vimKeys) }),
      });
    }
    if (vimKeys !== this.#vimOn) {
      this.#vimOn = vimKeys;
      this.#view.dispatch({ effects: this.#vim.reconfigure(vimExtensions(vimKeys)) });
    }
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
