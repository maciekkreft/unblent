import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Prec, Annotation } from "@codemirror/state";
import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { history, historyKeymap, insertNewline } from "@codemirror/commands";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { machine, duplicateNames } from "./machine.js";
import saved from "./events/evaluator.saved.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };

// The multi-line fields are CodeMirror boxes, one editor each, so they take Vim's keys
// when the "Vim keys" preference (12) is on: Vim sits in a compartment turned on and off
// in place. The theme and the Vim cursor are copied from chat-input and journal-entry,
// because components never import each other (11.2).

// The box grows with what is written, from two lines; its frame is drawn around it by
// .box, so the theme draws none. Line spacing is padding, never margin.
const boxTheme = (fontSize, minHeight) =>
  EditorView.theme({
    "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "var(--leading-normal)" },
    ".cm-content": {
      caretColor: "var(--color-accent)",
      padding: "var(--space-xs) var(--space-sm)",
      minHeight,
    },
    ".cm-line": { fontSize, padding: "0" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
    ".cm-placeholder": { color: "var(--color-mute)" },
  });
const bodyTheme = boxTheme("var(--text-body)", "calc(var(--text-body) * var(--leading-normal) * 2)");
const smallTheme = boxTheme("var(--text-sm)", "calc(var(--text-sm) * var(--leading-normal) * 2)");

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

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

// Which evaluator was open, and its book, kept per browser under the view's name (3.1);
// losing it loses nothing but the place.
const KEY = "evaluator-editor:open";
const recall = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
};
const remember = (pick) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(pick));
  } catch {}
};

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
        open: recall(),
        remember,
        following: this.host.subject,
      },
      events: { "evaluator.saved": saved, "removal.started": started },
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

class EvaluatorEditor extends LitElement {
  // Follow the book open on the stage. Reflected so a page's bare `subject` reads as true.
  static properties = { height: { type: String, reflect: true }, subject: { type: Boolean, reflect: true } };


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
    }
    form {
      box-sizing: border-box;
      max-width: var(--width-form);
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    .note {
      margin: 0;
      padding: var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .caption,
    legend {
      padding: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .mute {
      color: var(--color-mute);
    }
    /* The tick box as evaluator-list draws its on / off box. */
    .shown {
      display: inline-flex;
      align-self: flex-start;
      align-items: center;
      gap: var(--space-xs);
      font-size: var(--text-sm);
      color: var(--color-body);
      cursor: pointer;
    }
    .shown input {
      flex: none;
      width: calc(var(--space-md) + var(--space-2xs));
      height: calc(var(--space-md) + var(--space-2xs));
      margin: 0;
      accent-color: var(--color-accent);
      cursor: pointer;
    }
    .shown input:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    input[type="text"],
    .box {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      font: inherit;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    input[type="text"] {
      padding: var(--space-xs) var(--space-sm);
    }
    /* CodeMirror owns everything inside .box; the frame is drawn here, around it. */
    .box {
      overflow: hidden;
      cursor: text;
    }
    input::placeholder {
      color: var(--color-mute);
    }
    input:focus-visible,
    .box:focus-within {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    input.title {
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    .questions {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .question {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .qhead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
    }
    /* The two kinds as one two-part switch: radio buttons, so arrow keys move between
       them and the chosen part looks pressed. */
    .kind {
      display: inline-flex;
      align-self: flex-start;
      gap: var(--space-2xs);
      padding: var(--space-2xs);
      margin: 0;
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .kind label {
      position: relative;
      font-size: var(--text-sm);
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--color-body);
    }
    .kind input {
      position: absolute;
      inset: 0;
      margin: 0;
      opacity: 0;
      cursor: pointer;
    }
    .kind label:has(input:checked) {
      background: var(--color-canvas);
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      box-shadow: var(--shadow-card);
      outline: var(--border-width) solid var(--color-border-strong);
    }
    .kind label:has(input:focus-visible) {
      box-shadow: var(--focus-ring);
    }
    .options {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "name rm" "desc desc";
      gap: var(--space-xs);
      align-items: center;
      padding-bottom: var(--space-xs);
    }
    .option input {
      grid-area: name;
      font-weight: var(--weight-semibold);
    }
    .option .box {
      grid-area: desc;
    }
    .option button {
      grid-area: rm;
    }
    .warn {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
      justify-content: space-between;
    }
    button {
      appearance: none;
      font: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-sm);
      border: var(--border-width) solid var(--color-border-strong);
      background: var(--color-canvas);
      color: var(--color-ink);
    }
    button:hover {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button.quiet {
      border-color: transparent;
      background: transparent;
      color: var(--color-body);
    }
    button.quiet:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    button.icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-xs);
    }
  `;

  #actor = new ActorController(this);

  // The field that last held the keyboard in this editor.
  #last = null;
  // The CodeMirror boxes by key ("<question>:text", "<question>:<option>:description"),
  // each with the region it is drawn in; and what the last render asked of each box.
  #boxes = new Map();
  #wanted = new Map();

  // A panel's focus lands in what it shows (list-then-item, dock-desk): back in the field
  // last used, else the evaluator's name. The shadow root does not delegate focus,
  // because Safari does not focus a pressed button, so a delegating root would hand a
  // press on any button to the name, scroll it into view and lose the click.
  focus(options) {
    const target = this.#last?.isConnected && this.renderRoot.contains(this.#last) ? this.#last : this.renderRoot.querySelector("input.title");
    if (target) target.focus(options);
    else super.focus(options);
  }

  // Safari does not focus a pressed button or choice, so the press would drop the
  // keyboard on the page, and with Vim keys on the desk would hand it back to this
  // panel far from where the user pressed. The press focuses what it pressed instead,
  // without scrolling, and the click still lands on it.
  #pressed(event) {
    const control = event.composedPath()[0]?.closest?.("button, input[type=radio], input[type=checkbox]");
    if (!control || !this.renderRoot.contains(control)) return;
    event.preventDefault();
    control.focus({ preventScroll: true });
  }

  #send(event) {
    this.#actor.send(event);
  }

  // Adding a question or an option puts the keyboard in its first field, in Vim's insert
  // mode when Vim keys is on, so the first key typed is text.
  async #add(event, selector) {
    this.#send(event);
    await this.updateComplete;
    const fields = this.renderRoot.querySelectorAll(selector);
    const field = fields[fields.length - 1];
    if (!field) return;
    const box = [...this.#boxes.values()].find((b) => b.region === field);
    if (!box) return field.focus();
    box.view.focus();
    const cm = box.vimOn ? getCM(box.view) : null;
    if (cm && cm.state?.vim?.insertMode !== true) Vim.handleKey(cm, "i", "user");
  }

  // One box as the render wants it: its text, label, placeholder, size and where its
  // edits go. The element is drawn here; the editor inside it is made in updated().
  #box(key, field, { text, label, hint = "", small = false, edit }) {
    this.#wanted.set(key, { text, label, hint, small, edit });
    return html`<div class="box" data-key=${key} data-field=${field}></div>`;
  }

  #extensions(key, spec, vimOn, labelled) {
    return [
      // First: the Vim plugin must see a key before any other keymap does.
      this.#boxes.get(key).vim.of(vimExtensions(vimOn)),
      // Vim hides the native selection, so its visual-mode range shows only through
      // CodeMirror's own selection layer.
      drawSelection(),
      history(),
      keymap.of(historyKeymap),
      // Left to the browser, WebKit's own Enter drops repeated empty lines at the end.
      keymap.of([{ key: "Enter", run: insertNewline }]),
      EditorView.lineWrapping,
      spec.small ? smallTheme : bodyTheme,
      spec.hint ? placeholder(spec.hint) : [],
      labelled.of(EditorView.contentAttributes.of({ "aria-label": spec.label })),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#boxes.get(key)?.edit(update.state.doc.toString());
      }),
      // WebKit keeps the document's selection inside a blurred editor, and a later key
      // nobody cancels is typed there; dropping it on blur leaves nothing to type into.
      EditorView.domEventHandlers({ blur: () => void document.getSelection()?.removeAllRanges() }),
    ];
  }

  // Lit draws the boxes by position, so a region can come to stand for another key (a
  // question removed above it): an editor whose region no longer carries its key is
  // dropped and made again, and every editor follows its draft text, label and Vim.
  updated() {
    const vimOn = this.#actor.snapshot?.context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll(".box[data-key]")].map((r) => [r.dataset.key, r]));
    for (const [key, box] of this.#boxes) {
      if (regions.get(key) === box.region && box.view.dom.parentNode === box.region) continue;
      box.view.destroy();
      this.#boxes.delete(key);
    }
    for (const [key, region] of regions) {
      const spec = this.#wanted.get(key);
      if (!spec) continue;
      let box = this.#boxes.get(key);
      if (!box) {
        region.replaceChildren();
        box = { region, vim: new Compartment(), labelled: new Compartment(), vimOn, label: spec.label, edit: spec.edit };
        this.#boxes.set(key, box);
        box.view = new EditorView({
          parent: region,
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there (7.5), so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: spec.text, extensions: this.#extensions(key, spec, vimOn, box.labelled) }),
        });
        continue;
      }
      box.edit = spec.edit;
      const effects = [];
      if (box.vimOn !== vimOn) {
        box.vimOn = vimOn;
        effects.push(box.vim.reconfigure(vimExtensions(vimOn)));
      }
      if (box.label !== spec.label) {
        box.label = spec.label;
        effects.push(box.labelled.reconfigure(EditorView.contentAttributes.of({ "aria-label": spec.label })));
      }
      const doc = box.view.state.doc.toString();
      const changes = doc === spec.text ? undefined : { from: 0, to: doc.length, insert: spec.text };
      if (changes || effects.length) box.view.dispatch({ changes, effects, annotations: changes ? fromDraft.of(true) : undefined });
    }
  }

  disconnectedCallback() {
    for (const box of this.#boxes.values()) box.view.destroy();
    this.#boxes.clear();
    super.disconnectedCallback();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("starting") || snapshot.matches("fetching")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="note">Evaluators unavailable.</p>`;
    if (snapshot.matches({ ready: "choosing" })) return html`<p class="note">Pick an evaluator, or New evaluator.</p>`;
    const { draft, evaluators, journal } = snapshot.context;
    if (draft.removing) return html`<p class="note">This evaluator was deleted.</p>`;
    const stored = evaluators.some((r) => r.id === draft.id);
    const questions = draft.questions.filter((q) => !q.removing);
    this.#wanted.clear();
    return html`
      <div class="page">
        <form
          @submit=${(e) => e.preventDefault()}
          @mousedown=${(e) => this.#pressed(e)}
          @focusin=${(e) => (this.#last = e.composedPath()[0])}
          @focusout=${() => this.#send({ type: "_blur" })}
        >
          <label class="field">
            <span class="caption">Name</span>
            <input
              class="title"
              type="text"
              placeholder="Name the evaluator"
              .value=${draft.name}
              @input=${(e) => this.#send({ type: "_edit", patch: { name: e.target.value } })}
            />
          </label>
          ${draft.book === journal
            ? nothing
            : html`<label class="shown">
                <input type="checkbox" .checked=${draft.journal} @change=${(e) => this.#send({ type: "_journal", on: e.target.checked })} />
                Show in journal
              </label>`}
          <fieldset class="field">
            <legend>Questions</legend>
            <div class="questions">${questions.map((q, i) => this.#question(q, i))}</div>
          </fieldset>
          <div class="actions">
            <button type="button" @click=${() => this.#add({ type: "_addQuestion" }, '.question [data-field="text"]')}>Add a question</button>
          </div>
          ${stored
            ? html`<div class="actions">
                <button type="button" class="quiet" @click=${() => this.#send({ type: "_delete" })}>Delete evaluator</button>
              </div>`
            : nothing}
        </form>
      </div>
    `;
  }

  #question(q, i) {
    const n = i + 1;
    const edit = (patch) => this.#send({ type: "_editQuestion", id: q.id, patch });
    const kind = (k) => this.#send({ type: "_kind", id: q.id, kind: k });
    return html`
      <div class="question" data-id=${q.id}>
        <div class="qhead">
          <span class="caption">Question ${n}</span>
          <button type="button" class="quiet" aria-label="Remove question ${n}" @click=${() => this.#send({ type: "_removeQuestion", id: q.id })}>
            Remove
          </button>
        </div>
        <div class="kind" role="radiogroup" aria-label="Kind of answer for question ${n}">
          <label><input type="radio" name="kind-${q.id}" value="yesno" .checked=${q.kind === "yesno"} @change=${() => kind("yesno")} />Yes / no</label>
          <label><input type="radio" name="kind-${q.id}" value="pick" .checked=${q.kind === "pick"} @change=${() => kind("pick")} />Pick one</label>
        </div>
        ${this.#box(`${q.id}:text`, "text", { text: q.text, label: `Question ${n}`, hint: "Write the question", edit: (text) => edit({ text }) })}
        ${q.kind === "yesno" ? this.#yesno(q, edit) : this.#options(q)}
      </div>
    `;
  }

  #yesno(q, edit) {
    return html`
      <div class="field">
        <span class="caption" aria-hidden="true">Yes means <span class="mute">(optional)</span></span>
        ${this.#box(`${q.id}:yes`, "yes", { text: q.yes, label: "Yes means (optional)", edit: (yes) => edit({ yes }) })}
      </div>
      <div class="field">
        <span class="caption" aria-hidden="true">No means <span class="mute">(optional)</span></span>
        ${this.#box(`${q.id}:no`, "no", { text: q.no, label: "No means (optional)", edit: (no) => edit({ no }) })}
      </div>
    `;
  }

  #options(q) {
    const options = q.options.filter((o) => !o.removing);
    const edit = (o, patch) => this.#send({ type: "_editOption", question: q.id, id: o.id, patch });
    return html`
      <div class="field">
        <span class="caption">Options</span>
        <div class="options">
          ${options.map(
            (o) => html`
              <div class="option" data-id=${o.id}>
                <input
                  type="text"
                  aria-label="Option name"
                  placeholder="Option"
                  .value=${o.name}
                  @input=${(e) => edit(o, { name: e.target.value })}
                />
                ${this.#box(`${q.id}:${o.id}:description`, "description", {
                  text: o.description,
                  label: `What ${o.name.trim() || "this option"} means`,
                  hint: "What it means (optional)",
                  small: true,
                  edit: (description) => edit(o, { description }),
                })}
                <button
                  type="button"
                  class="quiet icon"
                  title="Remove option"
                  aria-label="Remove option ${o.name.trim()}"
                  @click=${() => this.#send({ type: "_removeOption", question: q.id, id: o.id })}
                >
                  ${icon("x")}
                </button>
              </div>
            `,
          )}
        </div>
        ${duplicateNames(q) ? html`<p class="warn" role="status">Two options have the same name.</p>` : nothing}
      </div>
      <div>
        <button type="button" @click=${() => this.#add({ type: "_addOption", question: q.id }, `.question[data-id="${q.id}"] .option input`)}>
          Add an option
        </button>
      </div>
    `;
  }
}

customElements.define("evaluator-editor", EvaluatorEditor);
