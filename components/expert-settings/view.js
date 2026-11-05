import { LitElement, html, css, nothing, render } from "lit";
import { icon } from "icons";
import { mount, unmount, ask } from "bus";
import { EditorState, Annotation, Prec } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, shownOf, stopKey, boxEdge } from "./machine.js";
import edited from "./events/expert.edited.json" with { type: "json" };

// The prompt is a CodeMirror box, so it takes Vim's keys when the "Vim keys" preference
// (12) is on and writes in paragraphs like every editor; the setup, the Vim switch and the
// paragraph rule are the editor kit's (10).

// The box grows with what is written, from four lines; its frame is drawn around it by
// .box, so the theme draws none.
const boxTheme = EditorView.theme({
  ".cm-content": { padding: "var(--space-xs) var(--space-sm)", minHeight: "calc(var(--text-body) * var(--leading-normal) * 4)" },
  ".cm-line": { fontSize: "var(--text-body)" },
});

// A box's text set from the fact rather than typed, which is not sent back as an edit.
const fromFact = Annotation.define();

// What takes the keyboard on the tab's path (12, "Vim keys"), top to bottom.
const STOPS = "button, input, .cm-content";

const FOLDED_KEY = "expert-settings:folded";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // Which books are folded or open, kept in this browser (3.1) under the component's name.
    let folds = {};
    try {
      const kept = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "{}");
      if (kept && typeof kept === "object" && !Array.isArray(kept)) {
        folds = Object.fromEntries(Object.entries(kept).filter(([, v]) => typeof v === "boolean"));
      }
    } catch {
      // No storage, or something unreadable in it: every book starts by its prompt.
    }
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), folds },
      events: { "expert.edited": edited },
    });
    let keptFolds = this.actor.getSnapshot().context.folds;
    this.subscription = this.actor.subscribe((snapshot) => {
      if (snapshot.context.folds !== keptFolds) {
        keptFolds = snapshot.context.folds;
        try {
          localStorage.setItem(FOLDED_KEY, JSON.stringify(keptFolds));
        } catch {
          // No storage: the folds last for this page.
        }
      }
      this.host.requestUpdate();
    });
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

class ExpertSettings extends LitElement {
  static styles = css`
    /* The same column as the other tabs of the sheet (generator-settings). */
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
      color: var(--color-body);
    }
    .note {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .note.hint {
      margin-bottom: var(--space-sm);
    }
    .book {
      padding-block: var(--space-sm);
    }
    /* The heading folds its book: a caret that points right while folded and down while
       open, so the state is seen (Don Norman: visible signifiers). */
    .heading {
      margin: 0;
    }
    button.fold {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      border: 0;
      background: none;
      padding: 0;
      cursor: pointer;
      font: inherit;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
      text-align: left;
      border-radius: var(--radius-sm);
    }
    button.fold:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .caret {
      display: inline-flex;
      font-size: var(--text-body);
      color: var(--color-body-mid);
      transition: transform var(--duration-fast) var(--ease);
    }
    button.fold[aria-expanded="true"] .caret {
      transform: rotate(90deg);
    }
    .by {
      font-size: var(--text-sm);
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
    }
    .body {
      display: grid;
      gap: var(--space-sm);
      padding: var(--space-sm) 0 0 calc(var(--text-body) + var(--space-xs));
    }
    label.on {
      display: flex;
      gap: var(--space-sm);
      align-items: center;
      color: var(--color-body);
      cursor: pointer;
    }
    label.on.off {
      cursor: default;
    }
    input[type="checkbox"] {
      margin: 0;
      accent-color: var(--color-accent);
      width: calc(var(--space-md) - var(--space-2xs));
      height: calc(var(--space-md) - var(--space-2xs));
    }
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .caption {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      cursor: default;
    }
    /* CodeMirror owns everything inside .box; the frame is drawn here, around it. */
    .box {
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      cursor: text;
    }
    .box:focus-within {
      box-shadow: var(--focus-ring);
    }
    .cm-placeholder {
      color: var(--color-mute);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
  `;

  #actor = new ActorController(this);
  // The prompt editors by book id: { region, view, vimOn }.
  #boxes = new Map();
  // The stop that last held the keyboard in this tab.
  #last = null;

  constructor() {
    super();
    this.addEventListener("keydown", (e) => this.#key(e));
  }

  #send(event) {
    this.#actor.send(event);
  }

  // The sheet hands the keyboard to the tab by its host (dock-desk): back to the stop last
  // used, else the first one.
  focus(options) {
    const target = this.#last?.isConnected && this.renderRoot.contains(this.#last) ? this.#last : this.#stops()[0];
    if (target) this.#land(target, "first", options);
    else super.focus(options);
  }

  // Safari does not focus a pressed button or check box, so the press would drop the
  // keyboard on the page. The press focuses what it pressed instead, without scrolling,
  // and the click still lands on it.
  #pressed(event) {
    const control = event.composedPath()[0]?.closest?.("button, input[type=checkbox]");
    if (!control || !this.renderRoot.contains(control) || control.disabled) return;
    event.preventDefault();
    control.focus({ preventScroll: true });
  }

  // --- The keyboard path (12, "Vim keys") --------------------------------------------

  #stops() {
    return [...this.renderRoot.querySelectorAll(STOPS)].filter((el) => !el.disabled);
  }

  // A stop takes the keyboard: a box in Vim's normal mode at the start of its first line,
  // or of its last coming from below.
  #land(stop, edge = "first", options) {
    if (!stop.classList.contains("cm-content")) return stop.focus(options);
    const box = [...this.#boxes.values()].find((b) => b.view.contentDOM === stop);
    if (!box) return stop.focus(options);
    const { doc } = box.view.state;
    box.view.focus();
    const n = edge === "first" ? 1 : doc.lines;
    box.view.dispatch({ selection: { anchor: doc.line(n).from }, scrollIntoView: true });
  }

  // From one stop to the one `step` gives: down, up, first or last. Past either end the
  // keyboard stays, so the move is not lost to the page around.
  #move(from, step) {
    const stops = this.#stops();
    const at = stops.findIndex((s) => s === from || s.contains(from));
    const to = { down: at + 1, up: at - 1, first: 0, last: stops.length - 1 }[step];
    if (to == null || to < 0 || to >= stops.length || to === at) return false;
    this.#land(stops[to], step === "up" || step === "last" ? "last" : "first");
    return true;
  }

  // gg is two presses, so a first g waits a moment for the second, as in the lists.
  #gAt = 0;
  #key(event) {
    if (event.defaultPrevented) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element) || target.closest(".cm-editor")) return;
    const vim = this.#actor.snapshot?.context.vimKeys === true;
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const action = stopKey(event, { vim, afterG });
    this.#gAt = action === "g" ? Date.now() : 0;
    if (!action) return;
    if (action === "g") return event.preventDefault();
    if (this.#move(target, action)) event.preventDefault();
  }

  // In a box, j on its last line or k on its first in Vim's normal mode, and the down
  // arrow on its last line or the up arrow on its first, move on along the path. A
  // keydown handler at Prec.highest, because the Vim plugin's runs before every keymap.
  #boxKeys() {
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          const box = [...this.#boxes.values()].find((b) => b.view === view);
          const line = view.state.doc.lineAt(view.state.selection.main.head).number;
          const vim = box?.vimOn ? getCM(view)?.state?.vim : null;
          const step = boxEdge(event, vim, line, view.state.doc.lines, box?.vimOn === true);
          if (!step || !this.#move(view.contentDOM, step)) return false;
          event.preventDefault();
          return true;
        },
      }),
    );
  }

  // --- Drawing -------------------------------------------------------------------------

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    if (context.signedIn === null) return nothing;
    if (!context.signedIn) return html`<p class="note">Sign in to use book experts.</p>`;
    if (context.failed) return html`<p class="note">Book experts unavailable.</p>`;
    if (!context.books || !context.experts) return nothing;
    return html`
      <p class="note hint">
        Write how the expert on a book talks and what it knows. When it is on, it shows on the shelf above a new chat. Teach the
        book's ideas in your own words; don't paste its text.
      </p>
      ${shownOf(context).map((b) => this.#book(b))}
    `;
  }

  #book(b) {
    const title = b.title.trim() || "Untitled";
    const empty = b.prompt.trim() === "";
    return html`
      <section
        class="book"
        data-id=${b.id}
        aria-label=${title}
        @mousedown=${(e) => this.#pressed(e)}
        @focusin=${(e) => (this.#last = e.composedPath()[0])}
      >
        <h2 class="heading">
          <button type="button" class="fold" aria-expanded=${b.folded ? "false" : "true"} @click=${() => this.#send({ type: "_fold", id: b.id })}>
            <span class="caret">${icon("caret-right")}</span><span>${title}</span>${b.author ? html`<span class="by">${b.author}</span>` : nothing}
          </button>
        </h2>
        ${b.folded
          ? nothing
          : html`<div class="body">
              <label class="on ${empty ? "off" : ""}" title=${empty ? "Write a prompt first" : ""}>
                <input
                  type="checkbox"
                  .checked=${b.on}
                  ?disabled=${empty}
                  title=${empty ? "Write a prompt first" : ""}
                  @change=${(e) => this.#send({ type: "_switch", id: b.id, on: e.target.checked })}
                />
                On
              </label>
              <span class="caption" @click=${() => this.#boxes.get(b.id)?.view.focus()}>Prompt</span>
              <div class="box" data-key=${b.id} @focusout=${() => this.#send({ type: "_blur" })}></div>
            </div>`}
      </section>
    `;
  }

  // Each prompt box is made once its region is drawn, made again when the region is a new
  // element (after a fold), and follows the prompt shown and the Vim preference.
  updated() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return;
    const { context } = snapshot;
    const vimOn = context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll(".box[data-key]")].map((r) => [r.dataset.key, r]));
    for (const [key, box] of this.#boxes) {
      if (regions.get(key) === box.region && box.view.dom.parentNode === box.region) continue;
      box.view.destroy();
      this.#boxes.delete(key);
    }
    const shown = new Map(shownOf(context).map((b) => [b.id, b]));
    for (const [key, region] of regions) {
      const b = shown.get(key);
      if (!b) continue;
      const box = this.#boxes.get(key);
      if (!box) {
        region.replaceChildren();
        const view = new EditorView({
          parent: region,
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there, so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: b.prompt, extensions: this.#extensions(key, b.title, vimOn) }),
        });
        this.#boxes.set(key, { region, view, vimOn });
        continue;
      }
      box.vimOn = vimOn;
      setVim(box.view, vimOn);
      const doc = box.view.state.doc.toString();
      if (doc !== b.prompt) {
        box.view.dispatch({ changes: { from: 0, to: doc.length, insert: b.prompt }, annotations: fromFact.of(true) });
      }
    }
  }

  #extensions(key, title, vimOn) {
    return [
      this.#boxKeys(),
      baseExtensions({ vim: vimOn }),
      paragraphs({ box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      boxTheme,
      placeholder(`How the expert on ${title} talks and what it knows…`),
      EditorView.contentAttributes.of({ "aria-label": `Prompt for ${title}` }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromFact))) return;
        this.#send({ type: "_type", id: key, value: update.state.doc.toString() });
      }),
    ];
  }

  disconnectedCallback() {
    for (const box of this.#boxes.values()) box.view.destroy();
    this.#boxes.clear();
    super.disconnectedCallback();
  }
}

customElements.define("expert-settings", ExpertSettings);
