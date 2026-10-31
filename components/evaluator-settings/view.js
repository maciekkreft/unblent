import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Annotation, Prec } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, duplicateNames, OPTION_ICONS, removable, shownOf, TRY_PATH, stopKey, boxEdge } from "./machine.js";
import saved from "./events/evaluator.saved.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };

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
  gavel: ["Gavel", icon("gavel")],
  prohibit: ["No entry", icon("prohibit")],
  lightning: ["Lightning", icon("lightning")],
  "calendar-blank": ["Calendar", icon("calendar-blank")],
  "share-fat": ["Pass on", icon("share-fat")],
  "trash-simple": ["Bin", icon("trash-simple")],
};
const CHOICES = OPTION_ICONS.map((name) => [name, ...GLYPHS[name]]);

// What takes the keyboard on the tab's path (12, "Vim keys"), top to bottom: a text box
// by its editable content, and of two radios the chosen one, as Tab stops there; the icon
// panel keeps its own keys and is not on the path.
const STOPS = "a[href], button, input:not([type=radio]), input[type=radio]:checked, select, .cm-content";

const FOLDED_KEY = "evaluator-settings:folded";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // Which evaluators are folded, kept in this browser (3.1) under the component's name.
    let folded = [];
    try {
      const kept = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
      if (Array.isArray(kept)) folded = kept.filter((id) => typeof id === "string");
    } catch {
      // No storage, or something unreadable in it: every evaluator starts open.
    }
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, folded },
      events: { "evaluator.saved": saved, "removal.started": started },
    });
    let keptFolds = this.actor.getSnapshot().context.folded;
    this.subscription = this.actor.subscribe((snapshot) => {
      if (snapshot.context.folded !== keptFolds) {
        keptFolds = snapshot.context.folded;
        try {
          if (keptFolds.size) localStorage.setItem(FOLDED_KEY, JSON.stringify([...keptFolds]));
          else localStorage.removeItem(FOLDED_KEY);
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

class EvaluatorSettings extends LitElement {
  static styles = css`
    /* The same column as the other tabs of the sheet (generator-settings). */
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
      color: var(--color-body);
    }
    .top {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-sm);
      margin-bottom: var(--space-lg);
    }
    .top .note {
      padding: 0;
    }
    .try {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2xs);
      color: var(--color-ink);
      text-decoration: underline;
      text-underline-offset: var(--space-2xs);
      border-radius: var(--radius-sm);
    }
    .try:hover {
      color: var(--color-accent-hover);
    }
    .try:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button.new {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }
    /* One evaluator, fully open, a rule between it and the next, as Generators draws its
       generators. */
    .evaluator,
    .read {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .evaluator + .evaluator {
      margin-top: var(--space-xl);
      padding-top: var(--space-lg);
      border-top: var(--border-width) solid var(--color-border);
    }
    /* The heading folds its evaluator: a caret that points right while folded and down
       while open, so the state is seen (Don Norman: visible signifiers). */
    .heading {
      margin: 0;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    button.fold {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      width: 100%;
      padding: var(--space-2xs) 0;
      border-color: transparent;
      background: transparent;
      font-weight: inherit;
      text-align: left;
      color: var(--color-ink);
    }
    button.fold:hover {
      background: transparent;
      color: var(--color-accent-hover);
    }
    .caret {
      display: inline-flex;
      color: var(--color-mute);
      transition: transform var(--duration-fast) var(--ease);
    }
    button.fold[aria-expanded="true"] .caret {
      transform: rotate(90deg);
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
      padding: 0;
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
    button.quiet:hover:not([aria-disabled="true"]) {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    /* aria-disabled rather than disabled, so the button still takes the pointer and the
       keyboard and its title says what to do first. */
    button[aria-disabled="true"] {
      cursor: default;
      color: var(--color-mute);
    }
    button.icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-xs);
    }
  `;
  #actor = new ActorController(this);

  // The CodeMirror boxes by key ("<evaluator>:description", "<evaluator>:<question>:text",
  // ...), each with the region it is drawn in; and what the last render asked of each box.
  #boxes = new Map();
  #wanted = new Map();
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

  // Safari does not focus a pressed button or choice, so the press would drop the keyboard
  // on the page. The press focuses what it pressed instead, without scrolling, and the
  // click still lands on it.
  #pressed(event) {
    const control = event.composedPath()[0]?.closest?.("button, input[type=radio], input[type=checkbox]");
    if (!control || !this.renderRoot.contains(control)) return;
    event.preventDefault();
    control.focus({ preventScroll: true });
  }

  // --- The keyboard path (12, "Vim keys") --------------------------------------------

  #stops() {
    return [...this.renderRoot.querySelectorAll(STOPS)].filter((el) => !el.closest(".picker"));
  }

  // A stop takes the keyboard: a text box in Vim's normal mode at the start of its first
  // line, or of its last coming from below.
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
    if (!(target instanceof Element) || target.closest(".picker") || target.closest(".cm-editor")) return;
    const vim = this.#actor.snapshot?.context.vimKeys === true;
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const action = stopKey(event, { tag: target.tagName, type: target.type, vim, afterG });
    this.#gAt = action === "g" ? Date.now() : 0;
    if (!action) return;
    if (action === "g") return event.preventDefault();
    if (action === "prev" || action === "next") {
      event.preventDefault();
      return this.#choose(target, action === "next" ? 1 : -1);
    }
    if (this.#move(target, action)) event.preventDefault();
  }

  // A choice changed by one: the next or previous radio of its group, or the next or
  // previous entry of a select, as a click on it would.
  #choose(target, step) {
    if (target.type === "radio") {
      const group = [...this.renderRoot.querySelectorAll(`input[type=radio][name="${target.name}"]`)];
      const next = group[group.indexOf(target) + step];
      if (!next) return;
      next.focus();
      next.click();
      return;
    }
    if (target.tagName === "SELECT") {
      const at = target.selectedIndex + step;
      if (at < 0 || at >= target.options.length) return;
      target.selectedIndex = at;
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
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

  // --- The icon panel ------------------------------------------------------------------

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

  #choosePicked(evaluator, question, option, chosen) {
    this.#send({ type: "_optionIcon", evaluator, question, id: option, icon: chosen });
    this.#closePicker(true);
  }

  // Arrow keys move between the panel's buttons, as in any row of choices; Escape closes it
  // without a change and is not passed on, so the sheet around stays as it is.
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

  // --- Adding --------------------------------------------------------------------------

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

  // + New evaluator puts the keyboard in the new evaluator's name.
  #newsSeen = 0;
  #payNew() {
    const news = this.#actor.snapshot?.context.news ?? 0;
    if (news === this.#newsSeen) return;
    this.#newsSeen = news;
    this.renderRoot.querySelector(".evaluator input.title")?.focus();
  }

  // --- The boxes -----------------------------------------------------------------------

  // One box as the render wants it: its text, label, placeholder, size and where its edits
  // go. The element is drawn here; the editor inside it is made in updated().
  #box(key, field, { text, label, hint = "", small = false, edit }) {
    this.#wanted.set(key, { text, label, hint, small, edit });
    return html`<div class="box" data-key=${key} data-field=${field}></div>`;
  }

  #extensions(key, spec, vimOn, labelled) {
    return [
      this.#boxKeys(),
      baseExtensions({ vim: vimOn }),
      paragraphs({ box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      spec.small ? smallTheme : bodyTheme,
      spec.hint ? placeholder(spec.hint) : [],
      labelled.of(EditorView.contentAttributes.of({ "aria-label": spec.label })),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#boxes.get(key)?.edit(update.state.doc.toString());
      }),
    ];
  }

  // Lit draws the boxes by position, so a region can come to stand for another key: an
  // editor whose region no longer carries its key is dropped and made again, and every
  // editor follows its text, label and Vim.
  updated() {
    this.#payNew();
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
          // stylesheet there, so it must know the shadow root.
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

  // --- Drawing -------------------------------------------------------------------------

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    if (context.signedIn === null) return nothing;
    if (!context.signedIn) return html`<p class="note">Sign in to use evaluators.</p>`;
    if (snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="note">Evaluators unavailable.</p>`;
    this.#wanted.clear();
    return html`
      <div class="top" @focusin=${(e) => (this.#last = e.composedPath()[0])}>
        <a class="try" href=${TRY_PATH} target="_blank" rel="noopener">Try evaluators ${icon("arrow-square-out")}</a>
        <p class="note">Write a few lines there and see what each evaluator says about them.</p>
        <button type="button" class="new" @mousedown=${(e) => this.#pressed(e)} @click=${() => this.#send({ type: "_new" })}>
          ${icon("plus")}New evaluator
        </button>
      </div>
      ${shownOf(context).map((d) => (d.derivedFrom ? this.#derived(d, context) : this.#evaluator(d, context)))}
    `;
  }

  // The heading of an evaluator, a button that folds it or unfolds it. Enter on it is the
  // button's own press; j and k pass it as any other stop (12, "Vim keys").
  #heading(d, name, open) {
    return html`
      <h2 class="heading">
        <button type="button" class="fold" aria-expanded=${open ? "true" : "false"} @click=${() => this.#send({ type: "_fold", id: d.id })}>
          <span class="caret">${icon("caret-right")}</span>${name}
        </button>
      </h2>
    `;
  }

  #evaluator(d, context) {
    const kept = context.evaluators.some((r) => r.id === d.id);
    const questions = d.questions.filter((q) => !q.removing);
    const name = d.name.trim() || "New evaluator";
    const open = !context.folded.has(d.id);
    return html`
      <section
        class="evaluator"
        data-id=${d.id}
        aria-label=${name}
        @mousedown=${(e) => this.#pressed(e)}
        @focusin=${(e) => (this.#last = e.composedPath()[0])}
        @focusout=${(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) this.#send({ type: "_blur" });
        }}
      >
        ${this.#heading(d, name, open)}
        ${open ? this.#body(d, name, kept, questions) : nothing}
      </section>
    `;
  }

  #body(d, name, kept, questions) {
    return html`
        <label class="field">
          <span class="caption">Name</span>
          <input
            class="title"
            type="text"
            placeholder="Name the evaluator"
            .value=${d.name}
            @input=${(e) => this.#send({ type: "_edit", evaluator: d.id, patch: { name: e.target.value } })}
          />
        </label>
        <div class="field">
          <span class="caption" aria-hidden="true">Description</span>
          ${this.#box(`${d.id}:description`, "description", {
            text: d.description ?? "",
            label: `Description of ${name}`,
            hint: "What this evaluator checks, for the chat",
            small: true,
            edit: (description) => this.#send({ type: "_edit", evaluator: d.id, patch: { description } }),
          })}
        </div>
        <fieldset class="field">
          <legend>Questions</legend>
          <div class="questions">${questions.map((q, i) => this.#question(d, q, i))}</div>
        </fieldset>
        <div class="actions">
          <button type="button" @click=${() => this.#add({ type: "_addQuestion", evaluator: d.id }, `.evaluator[data-id="${d.id}"] .question [data-field="text"]`)}>
            Add a question
          </button>
          ${kept
            ? html`<button type="button" class="quiet" @click=${() => this.#send({ type: "_delete", evaluator: d.id })}>Delete evaluator</button>`
            : nothing}
        </div>
    `;
  }

  // An evaluator built from another fact (Your values): its questions read only, with
  // where they are changed, and no Delete, since it cannot be deleted.
  #derived(d, context) {
    const questions = d.questions.filter((q) => !q.removing);
    const open = !context.folded.has(d.id);
    return html`
      <section
        class="evaluator read"
        data-id=${d.id}
        aria-label=${d.name}
        @mousedown=${(e) => this.#pressed(e)}
        @focusin=${(e) => (this.#last = e.composedPath()[0])}
      >
        ${this.#heading(d, d.name, open)}
        ${open ? this.#readBody(d, questions) : nothing}
      </section>
    `;
  }

  #readBody(d, questions) {
    return html`
        ${d.description ? html`<p class="text description">${d.description}</p>` : nothing}
        <p class="where">It asks one question for each of your values. Change your values in the Values sheet, under the day's text in the Journal.</p>
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
    `;
  }

  #question(d, q, i) {
    const n = i + 1;
    const edit = (patch) => this.#send({ type: "_editQuestion", evaluator: d.id, id: q.id, patch });
    const kind = (k) => this.#send({ type: "_kind", evaluator: d.id, id: q.id, kind: k });
    const on = q.on !== false;
    return html`
      <div class="question ${on ? "" : "off"}" data-id=${q.id}>
        <div class="qhead">
          <label class="ask" title=${on ? "Asked; untick to stop asking it" : "Not asked; tick to ask it again"}>
            <input
              type="checkbox"
              aria-label="Ask question ${n}"
              .checked=${on}
              @change=${(e) => this.#send({ type: "_switchQuestion", evaluator: d.id, id: q.id, on: e.target.checked })}
            />
            <span class="caption">Question ${n}${on ? "" : html` <span class="mute">(off)</span>`}</span>
          </label>
          <button
            type="button"
            class="quiet"
            aria-label="Remove question ${n}"
            @click=${() => this.#send({ type: "_removeQuestion", evaluator: d.id, id: q.id })}
          >
            Remove
          </button>
        </div>
        <div class="kind" role="radiogroup" aria-label="Kind of answer for question ${n}">
          <label><input type="radio" name="kind-${q.id}" value="yesno" .checked=${q.kind === "yesno"} @change=${() => kind("yesno")} />Yes / no</label>
          <label><input type="radio" name="kind-${q.id}" value="pick" .checked=${q.kind === "pick"} @change=${() => kind("pick")} />Pick one</label>
        </div>
        ${this.#box(`${d.id}:${q.id}:text`, "text", { text: q.text, label: `Question ${n}`, hint: "Write the question", edit: (text) => edit({ text }) })}
        ${this.#expected(d, q, n)}
        ${q.kind === "yesno" ? this.#yesno(d, q, edit) : this.#options(d, q)}
      </div>
    `;
  }

  // The answer expected, from the question's own answers; an option waiting out its undo
  // window is not offered, so the choice reads None until Undo brings it back.
  #expected(d, q, n) {
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
          @change=${(e) => this.#send({ type: "_expect", evaluator: d.id, question: q.id, expect: e.target.value || null })}
        >
          <option value="" ?selected=${current === ""}>None</option>
          ${answers.map(([id, name]) => html`<option value=${id} ?selected=${current === id}>${name}</option>`)}
        </select>
      </label>
    `;
  }

  #yesno(d, q, edit) {
    return html`
      <div class="field">
        <span class="caption" aria-hidden="true">Yes means <span class="mute">(optional)</span></span>
        ${this.#box(`${d.id}:${q.id}:yes`, "yes", { text: q.yes, label: "Yes means (optional)", edit: (yes) => edit({ yes }) })}
      </div>
      <div class="field">
        <span class="caption" aria-hidden="true">No means <span class="mute">(optional)</span></span>
        ${this.#box(`${d.id}:${q.id}:no`, "no", { text: q.no, label: "No means (optional)", edit: (no) => edit({ no }) })}
      </div>
    `;
  }

  #picker(d, q, o) {
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
              @click=${() => this.#choosePicked(d.id, q.id, o.id, name)}
            >
              ${glyph}
            </button>
          `,
        )}
        <button type="button" class="quiet none" aria-pressed=${o.icon ? "false" : "true"} @click=${() => this.#choosePicked(d.id, q.id, o.id, null)}>
          No icon
        </button>
      </div>
    `;
  }

  #options(d, q) {
    const options = q.options.filter((o) => !o.removing);
    const edit = (o, patch) => this.#send({ type: "_editOption", evaluator: d.id, question: q.id, id: o.id, patch });
    return html`
      <div class="field">
        <span class="caption">Options</span>
        <div class="options">
          ${options.map(
            (o) => html`
              <div class="option" data-id=${o.id}>
                <input type="text" aria-label="Option name" placeholder="Option" .value=${o.name} @input=${(e) => edit(o, { name: e.target.value })} />
                ${this.#box(`${d.id}:${q.id}:${o.id}:description`, "description", {
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
                  title=${removable(o) ? "Remove option" : "Clear the option's name and description first"}
                  aria-label="Remove option ${o.name.trim()}"
                  aria-disabled=${removable(o) ? "false" : "true"}
                  @click=${() => this.#send({ type: "_removeOption", evaluator: d.id, question: q.id, id: o.id })}
                >
                  ${icon("x")}
                </button>
                ${this.#picking === o.id ? this.#picker(d, q, o) : nothing}
              </div>
            `,
          )}
        </div>
        ${duplicateNames(q) ? html`<p class="warn" role="status">Two options have the same name.</p>` : nothing}
      </div>
      <div>
        <button
          type="button"
          @click=${() =>
            this.#add({ type: "_addOption", evaluator: d.id, question: q.id }, `.evaluator[data-id="${d.id}"] .question[data-id="${q.id}"] .option input`)}
        >
          Add an option
        </button>
      </div>
    `;
  }
}

customElements.define("evaluator-settings", EvaluatorSettings);
