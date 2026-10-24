import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Annotation } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs, toRegister } from "editor";
import { machine, duplicateNames, OPTION_ICONS, showing } from "./machine.js";
import saved from "./events/evaluator.saved.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };
import pinToggled from "./events/pin.toggled.json" with { type: "json" };
import opened from "./events/evaluator.opened.json" with { type: "json" };

// The multi-line fields are CodeMirror boxes, one editor each, so they take Vim's keys
// when the "Vim keys" preference (12) is on, and write in paragraphs like every editor.
// The setup, the Vim switch and the paragraph rule are the editor kit's (10).

// The box grows with what is written, from two lines; its frame is drawn around it by
// .box, so the theme draws none.
const boxTheme = (fontSize, minHeight) =>
  EditorView.theme({
    ".cm-content": { padding: "var(--space-xs) var(--space-sm)", minHeight },
    ".cm-line": { fontSize },
  });
const bodyTheme = boxTheme("var(--text-body)", "calc(var(--text-body) * var(--leading-normal) * 2)");
const smallTheme = boxTheme("var(--text-sm)", "calc(var(--text-sm) * var(--leading-normal) * 2)");

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

// The icons an option may be given, in the machine's order, each with its name for a
// screen reader. The names are literals so the icon check sees each one (11.2).
const GLYPHS = {
  footprints: ["Footprints", icon("footprints")],
  "person-simple-walk": ["Walking person", icon("person-simple-walk")],
  brain: ["Brain", icon("brain")],
  heart: ["Heart", icon("heart")],
  trophy: ["Trophy", icon("trophy")],
  "hand-palm": ["Raised hand", icon("hand-palm")],
  question: ["Question mark", icon("question")],
  check: ["Check", icon("check")],
  warning: ["Warning", icon("warning")],
};
const CHOICES = OPTION_ICONS.map((name) => [name, ...GLYPHS[name]]);

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
        // Vim's registers are one per page, so text put there is what any editor's p pastes.
        pushRegister: toRegister,
        mint: ulid,
        open: recall(),
        remember,
        following: this.host.subject,
        // A try page (8) shows the starters signed out.
        tryPage: location.pathname.startsWith("/try/"),
      },
      events: { "evaluator.saved": saved, "removal.started": started, "pin.toggled": pinToggled, "evaluator.opened": opened },
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
    /* The header, as the note editor's: the book on the left, the pin on the right. */
    .header {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      min-height: var(--space-lg);
      padding: var(--space-xs) var(--space-md) 0;
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
    /* The pin: a toggle, muted while following, accent when pinned, as the note
       editor's and the chat's. */
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
    .pin:hover:not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    .pin[aria-pressed="true"] {
      color: var(--color-accent);
    }
    .pin:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
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
    /* Your values, read only: the same column as the form, words in place of fields. */
    .read {
      box-sizing: border-box;
      max-width: var(--width-form);
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    .read .name {
      margin: 0;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .read .where,
    .read .text,
    .read .empty {
      margin: 0;
    }
    .read .where {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .read .text {
      color: var(--color-ink);
    }
    .answers {
      margin: 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .answers li {
      display: flex;
      flex-direction: column;
    }
    .answer {
      font-weight: var(--weight-semibold);
    }
    .means {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
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
    .ask input {
      flex: none;
      width: calc(var(--space-md) + var(--space-2xs));
      height: calc(var(--space-md) + var(--space-2xs));
      margin: 0;
      accent-color: var(--color-accent);
      cursor: pointer;
    }
    .ask input:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .ask {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      cursor: pointer;
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
    /* A question switched off is greyed, its words still editable: the tick beside its
       caption brings it back. */
    .question.off {
      border-style: dashed;
    }
    .question.off .caption,
    .question.off .kind label {
      color: var(--color-mute);
    }
    .question.off input[type="text"],
    .question.off .cm-editor {
      color: var(--color-body-mid);
    }
    .question.off .box,
    .question.off input[type="text"] {
      background: transparent;
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
    .expect {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-xs);
    }
    .expect select {
      min-width: 0;
      max-width: 100%;
      font: inherit;
      font-size: var(--text-sm);
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-xs);
    }
    .expect select:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .question.off .expect select {
      color: var(--color-body-mid);
      background: transparent;
    }
    .options {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      grid-template-areas: "name glyph rm" "panel panel panel" "desc desc desc";
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
    .option > .remove {
      grid-area: rm;
    }
    .option > .glyph {
      grid-area: glyph;
      font-size: var(--text-body);
      color: var(--color-body);
    }
    .glyph svg {
      display: block;
    }
    /* No icon yet: an empty dashed square the size of a glyph, so the button reads as a
       place for one. */
    .glyph .blank {
      display: block;
      box-sizing: border-box;
      width: var(--text-body);
      height: var(--text-body);
      border: var(--border-width) dashed var(--color-border-strong);
      border-radius: var(--radius-sm);
    }
    .option > .glyph[aria-expanded="true"] {
      background: var(--color-surface-hover);
    }
    /* The icons in equal cells, as many to a row as fit, and No icon on a row of its own,
       so the panel keeps one shape at any width. */
    .picker {
      grid-area: panel;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(calc(var(--text-body) + var(--space-xs) * 2 + var(--border-width) * 2), 1fr));
      align-items: center;
      gap: var(--space-2xs);
      padding: var(--space-2xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card);
    }
    .picker button {
      border: var(--border-width) solid transparent;
      font-size: var(--text-sm);
    }
    .picker button.icon {
      font-size: var(--text-body);
    }
    .picker .none {
      grid-column: 1 / -1;
      justify-self: start;
      white-space: nowrap;
    }
    .picker button svg {
      display: block;
    }
    .picker button[aria-pressed="true"] {
      color: var(--color-ink);
      background: var(--color-accent-subtle);
      border-color: var(--color-accent);
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
  // An evaluator just picked in the list (Enter, a click, or cc with Vim keys) starts in
  // its name, so it can be renamed at once.
  #picksSeen = 0;
  focus(options) {
    const picks = this.#actor.snapshot?.context.picks ?? 0;
    if (picks !== this.#picksSeen) {
      this.#picksSeen = picks;
      this.#last = null;
    }
    const target = this.#last?.isConnected && this.renderRoot.contains(this.#last) ? this.#last : this.renderRoot.querySelector("input.title");
    this.#owed = target ? null : { options, at: Date.now() };
    if (target) target.focus(options);
    else super.focus(options);
  }

  // The focus asked for before the evaluator was drawn (a pick lands before the editor
  // has drawn it), given to its name once it is, if that is within a moment, so a focus
  // asked for long ago never takes the keyboard from where the user is now.
  #owed = null;
  #payFocus() {
    if (!this.#owed) return;
    const title = this.renderRoot.querySelector("input.title");
    if (!title) return;
    const { options, at } = this.#owed;
    this.#owed = null;
    if (Date.now() - at < 1000) title.focus(options);
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

  // The option whose icon panel is open, or null. Only one is open at a time.
  #picking = null;

  #glyphButton(id) {
    return this.renderRoot.querySelector(`.glyph[data-option="${id}"]`);
  }

  // A press anywhere but the panel or an icon button closes it unchanged.
  #outside = (event) => {
    const path = event.composedPath();
    if (path.some((n) => n?.classList?.contains("picker") || n?.classList?.contains("glyph"))) return;
    this.#closePicker(false);
  };

  async #openPicker(id) {
    if (this.#picking === id) return this.#closePicker(true);
    this.#picking = id;
    document.addEventListener("pointerdown", this.#outside, true);
    this.requestUpdate();
    await this.updateComplete;
    const panel = this.renderRoot.querySelector(".picker");
    (panel?.querySelector('[aria-pressed="true"]') ?? panel?.querySelector("button"))?.focus({ preventScroll: true });
  }

  // Closing by a choice or by Escape hands the keyboard back to the icon button it came from.
  async #closePicker(refocus) {
    const id = this.#picking;
    if (id == null) return;
    this.#picking = null;
    document.removeEventListener("pointerdown", this.#outside, true);
    this.requestUpdate();
    if (!refocus) return;
    await this.updateComplete;
    this.#glyphButton(id)?.focus({ preventScroll: true });
  }

  #choose(question, option, chosen) {
    this.#send({ type: "_optionIcon", question, id: option, icon: chosen });
    this.#closePicker(true);
  }

  // Arrow keys move between the panel's buttons, as in any row of choices; Escape closes it
  // without a change and is not passed on, so the panel around the editor stays as it is.
  #pickerKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.#closePicker(true);
      return;
    }
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll("button")];
    const at = buttons.indexOf(event.composedPath()[0]);
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  }

  // Tabbing out of the panel to anything but its icon button closes it, as a press outside does.
  #pickerLeft(event) {
    const to = event.relatedTarget;
    if (!to || event.currentTarget.contains(to) || to.classList?.contains("glyph")) return;
    this.#closePicker(false);
  }

  // Only while following the stage, where the pin means something: the book the tab
  // shows, and the pin that keeps the list and this editor on it when the stage moves (12).
  #header(snapshot) {
    const { following, book, pin, titles, draft } = snapshot.context;
    if (!following) return nothing;
    const pinned = pin != null && pin === book;
    // The book the evaluator is kept with, which a pin may hold on another book's stage.
    const title = titles[draft?.book ?? book];
    return html`
      <div class="header">
        <span class="about">${title ? html`About: ${title}` : nothing}</span>
        <button
          class="pin"
          type="button"
          aria-pressed=${pinned}
          aria-label=${pinned ? "Unpin evaluators" : "Pin evaluators"}
          @click=${() => this.#send({ type: "_togglePin" })}
        >
          ${icon("push-pin")}
        </button>
      </div>
    `;
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
      baseExtensions({ vim: vimOn }),
      paragraphs(),
      spec.small ? smallTheme : bodyTheme,
      spec.hint ? placeholder(spec.hint) : [],
      labelled.of(EditorView.contentAttributes.of({ "aria-label": spec.label })),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#boxes.get(key)?.edit(update.state.doc.toString());
      }),
    ];
  }

  // Lit draws the boxes by position, so a region can come to stand for another key (a
  // question removed above it): an editor whose region no longer carries its key is
  // dropped and made again, and every editor follows its draft text, label and Vim.
  updated() {
    this.#payFocus();
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
        box = { region, labelled: new Compartment(), vimOn, label: spec.label, edit: spec.edit };
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
      box.vimOn = vimOn;
      setVim(box.view, vimOn);
      const effects = [];
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
    document.removeEventListener("pointerdown", this.#outside, true);
    this.#picking = null;
    for (const box of this.#boxes.values()) box.view.destroy();
    this.#boxes.clear();
    super.disconnectedCallback();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    // Signed out nothing of the account shows (machine.js: showing).
    const account = showing(snapshot.context);
    if (account === "wait") return nothing;
    if (account === "sign-in") return html`<p class="note">Sign in to run evaluators.</p>`;
    if (snapshot.matches("starting") || snapshot.matches("fetching")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="note">Evaluators unavailable.</p>`;
    if (snapshot.matches({ ready: "choosing" })) return html`<p class="note">Pick an evaluator, or New evaluator.</p>`;
    const { draft, evaluators } = snapshot.context;
    if (draft.removing) return html`<p class="note">This evaluator was deleted.</p>`;
    if (draft.derivedFrom) return this.#derived(snapshot, draft);
    const stored = evaluators.some((r) => r.id === draft.id);
    const questions = draft.questions.filter((q) => !q.removing);
    this.#wanted.clear();
    return html`
      ${this.#header(snapshot)}
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

  // An evaluator built from another fact (Your values): its name and questions read only,
  // with where they are changed, and no Delete, since it cannot be deleted.
  #derived(snapshot, draft) {
    const questions = draft.questions.filter((q) => !q.removing);
    return html`
      ${this.#header(snapshot)}
      <div class="page">
        <div class="read">
          <div class="field">
            <span class="caption">Name</span>
            <h2 class="name">${draft.name}</h2>
          </div>
          <p class="where">
            It asks one question for each of your values. Change your values in the Values sheet, under the day's text in the
            Journal.
          </p>
          <section class="field" aria-label="Questions">
            <span class="caption">Questions</span>
            ${questions.length
              ? html`<div class="questions">
                  ${questions.map(
                    (q, i) => html`
                      <div class="question" data-id=${q.id}>
                        <span class="caption">Question ${i + 1}</span>
                        <p class="text">${q.text}</p>
                        <ul class="answers">
                          ${q.options.map(
                            (o) => html`
                              <li>
                                <span class="answer">${o.name}${o.id === q.expect ? html` <span class="mute">(expected)</span>` : nothing}</span>
                                ${o.description ? html`<span class="means">${o.description}</span>` : nothing}
                              </li>
                            `,
                          )}
                        </ul>
                      </div>
                    `,
                  )}
                </div>`
              : html`<p class="mute empty">No values are written yet, so there is nothing to ask.</p>`}
          </section>
        </div>
      </div>
    `;
  }

  #question(q, i) {
    const n = i + 1;
    const edit = (patch) => this.#send({ type: "_editQuestion", id: q.id, patch });
    const kind = (k) => this.#send({ type: "_kind", id: q.id, kind: k });
    const on = q.on !== false;
    return html`
      <div class="question ${on ? "" : "off"}" data-id=${q.id}>
        <div class="qhead">
          <label class="ask" title=${on ? "Asked; untick to stop asking it" : "Not asked; tick to ask it again"}>
            <input
              type="checkbox"
              aria-label="Ask question ${n}"
              .checked=${on}
              @change=${(e) => this.#send({ type: "_switchQuestion", id: q.id, on: e.target.checked })}
            />
            <span class="caption">Question ${n}${on ? "" : html` <span class="mute">(off)</span>`}</span>
          </label>
          <button type="button" class="quiet" aria-label="Remove question ${n}" @click=${() => this.#send({ type: "_removeQuestion", id: q.id })}>
            Remove
          </button>
        </div>
        <div class="kind" role="radiogroup" aria-label="Kind of answer for question ${n}">
          <label><input type="radio" name="kind-${q.id}" value="yesno" .checked=${q.kind === "yesno"} @change=${() => kind("yesno")} />Yes / no</label>
          <label><input type="radio" name="kind-${q.id}" value="pick" .checked=${q.kind === "pick"} @change=${() => kind("pick")} />Pick one</label>
        </div>
        ${this.#box(`${q.id}:text`, "text", { text: q.text, label: `Question ${n}`, hint: "Write the question", edit: (text) => edit({ text }) })}
        ${this.#expected(q, n)}
        ${q.kind === "yesno" ? this.#yesno(q, edit) : this.#options(q)}
      </div>
    `;
  }

  // The answer expected, from the question's own answers; an option waiting out its undo
  // window is not offered, so the choice reads None until Undo brings it back.
  #expected(q, n) {
    const answers =
      q.kind === "pick"
        ? q.options.filter((o) => !o.removing).map((o, i) => [o.id, o.name.trim() || `Option ${i + 1}`])
        : [
            ["yes", "Yes"],
            ["no", "No"],
          ];
    const current = answers.some(([id]) => id === q.expect) ? q.expect : "";
    return html`
      <label class="expect">
        <span class="caption">Expected answer</span>
        <select
          aria-label="Expected answer for question ${n}"
          @change=${(e) => this.#send({ type: "_expect", question: q.id, expect: e.target.value || null })}
        >
          <option value="" ?selected=${current === ""}>None</option>
          ${answers.map(([id, name]) => html`<option value=${id} ?selected=${current === id}>${name}</option>`)}
        </select>
      </label>
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

  #picker(q, o) {
    return html`
      <div
        class="picker"
        role="group"
        aria-label="Icon for ${o.name.trim() || "this option"}"
        @keydown=${(e) => this.#pickerKey(e)}
        @focusout=${(e) => this.#pickerLeft(e)}
      >
        ${CHOICES.map(
          ([name, label, glyph]) => html`
            <button
              type="button"
              class="quiet icon"
              title=${label}
              aria-label=${label}
              aria-pressed=${o.icon === name ? "true" : "false"}
              @click=${() => this.#choose(q.id, o.id, name)}
            >
              ${glyph}
            </button>
          `,
        )}
        <button type="button" class="quiet none" aria-pressed=${o.icon ? "false" : "true"} @click=${() => this.#choose(q.id, o.id, null)}>No icon</button>
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
                  class="quiet icon glyph"
                  data-option=${o.id}
                  title=${o.icon ? `Icon: ${GLYPHS[o.icon]?.[0] ?? o.icon}` : "Choose an icon"}
                  aria-label="Icon for ${o.name.trim() || "this option"}: ${o.icon ? (GLYPHS[o.icon]?.[0] ?? o.icon) : "none"}"
                  aria-haspopup="true"
                  aria-expanded=${this.#picking === o.id ? "true" : "false"}
                  @click=${() => this.#openPicker(o.id)}
                >
                  ${GLYPHS[o.icon]?.[1] ?? html`<span class="blank"></span>`}
                </button>
                <button
                  type="button"
                  class="quiet icon remove"
                  title="Remove option"
                  aria-label="Remove option ${o.name.trim()}"
                  @click=${() => this.#send({ type: "_removeOption", question: q.id, id: o.id })}
                >
                  ${icon("x")}
                </button>
                ${this.#picking === o.id ? this.#picker(q, o) : nothing}
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
