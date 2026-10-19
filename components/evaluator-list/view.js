import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Annotation, StateField, StateEffect } from "@codemirror/state";
import { EditorView, placeholder, Decoration, WidgetType } from "@codemirror/view";
import { baseExtensions, setVim, paragraphs } from "editor";
import {
  machine,
  rows,
  subtitle,
  askable,
  lines,
  UNTITLED,
  freeStop,
  notice,
  STOPS,
  evaluateLabel,
  stopLabel,
  foldLine,
  foldedAtStart,
  marksOf,
  focusOf,
  tally,
  sayExpect,
} from "./machine.js";
import selected from "./events/evaluator.selected.json" with { type: "json" };
import switched from "./events/evaluator.switched.json" with { type: "json" };

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
        following: this.host.subject,
        drafts,
      },
      events: { "evaluator.selected": selected, "evaluator.switched": switched },
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

// The Run box's text, one entry per book, kept across reloads (3.1): the view's own UI
// state under a key named for the component, so it follows the browser, not the account,
// and losing it loses nothing. A browser refusing storage reads nothing and drops the write.
const KEY = "evaluator-list.drafts";
const readAll = () => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
};
const drafts = {
  read(book) {
    const text = readAll()[book];
    return typeof text === "string" ? text : "";
  },
  write(book, text) {
    try {
      const all = readAll();
      if (text) all[book] = text;
      else delete all[book];
      if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all));
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the text lives only for this page.
    }
  },
};

// Whether the user last hid the list of evaluators, kept in this browser (3.1) as "true" or
// "false"; it wins over the page's `folded`. A browser refusing storage reads nothing.
const FOLD_KEY = "evaluator-list.folded";
const readFold = () => {
  try {
    return localStorage.getItem(FOLD_KEY);
  } catch {
    return null;
  }
};
const writeFold = (folded) => {
  try {
    localStorage.setItem(FOLD_KEY, String(folded));
  } catch {
    // No persistence available; the fold lives only for this page.
  }
};

// The glyphs an answer may start with, as literals so the icon check can read them (7.6):
// the icons an evaluator may give an option, and the check and warning of an expected answer.
const GLYPHS = {
  footprints: () => icon("footprints"),
  "person-simple-walk": () => icon("person-simple-walk"),
  brain: () => icon("brain"),
  heart: () => icon("heart"),
  trophy: () => icon("trophy"),
  "hand-palm": () => icon("hand-palm"),
  question: () => icon("question"),
  check: () => icon("check"),
  warning: () => icon("warning"),
};

// The Evaluate box is a CodeMirror editor built on the editor kit (10), so marks can stand
// at a line's end, it takes Vim's keys when the "Vim keys" preference (12) is on, and Enter
// makes a paragraph. It grows with its text; the panel scrolls with the list around it.
const boxTheme = EditorView.theme({
  ".cm-content": {
    padding: "var(--space-xs) 0",
    minHeight: "calc(var(--text-body) * var(--leading-normal) * 3)",
  },
  ".cm-line": { padding: "0 var(--space-sm)" },
  ".cm-placeholder": { color: "var(--color-body-mid)" },
  // An answered line keeps room at its right end for its marks, which stand there.
  ".cm-line.cm-checked": { position: "relative" },
  ...Object.fromEntries(
    [1, 2, 3, 4].map((n) => [
      `.cm-line.cm-checked-${n}`,
      { paddingRight: `calc(var(--space-sm) + (var(--text-body) * var(--leading-normal) + var(--space-2xs)) * ${n})` },
    ]),
  ),
  // The line the panel tells about, tinted as the mockup's picked line.
  ".cm-line.cm-focus": {
    backgroundColor: "var(--color-accent-subtle)",
    boxShadow: "inset calc(var(--border-width) * 3) 0 0 var(--color-accent)",
  },
});

// The text set from the machine (another book) rather than typed, not sent back as an edit.
const fromMachine = Annotation.define();

// What the box draws besides the text: the marks by line text, and the line in focus.
const setDrawn = StateEffect.define();
const drawnField = StateField.define({
  create: () => ({ marks: new Map(), focus: null }),
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setDrawn) ? e.value : v), value),
});

// The line of the document a run's line stands on now: its own number while its text is
// still there, else the first line with that text, else none (it was edited).
const lineOf = (doc, at, text) => {
  if (at >= 1 && at <= doc.lines && doc.line(at).text.trim() === text) return doc.line(at);
  for (let n = 1; n <= doc.lines; n += 1) if (doc.line(n).text.trim() === text) return doc.line(n);
  return null;
};

// The marks at a line's end. They are a widget, not text: the cursor, Vim and the line's
// height pass them by, and CodeMirror ignores their events. Pressing one puts its line in
// the panel and leaves the cursor where it is.
class MarksWidget extends WidgetType {
  constructor(marks, point) {
    super();
    this.marks = marks;
    this.point = point;
    this.key = JSON.stringify(marks);
  }

  eq(other) {
    return other.key === this.key;
  }

  toDOM(view) {
    const span = document.createElement("span");
    span.className = "marks";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", this.marks.map((m) => m.label).join(" · "));
    render(
      this.marks.map((m) =>
        m.pending
          ? html`<span class="mark pending" title=${m.label}><i></i></span>`
          : html`<span class="mark ${m.tone ?? ""} ${m.sure ? "" : "unsure"}" title=${m.label}>${GLYPHS[m.icon]?.()}</span>`,
      ),
      span,
    );
    span.addEventListener("mousedown", (e) => e.preventDefault());
    span.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(span));
      this.point(line.number, line.text);
    });
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const drawn = (point) =>
  EditorView.decorations.compute([drawnField, "doc"], (state) => {
    const { marks, focus } = state.field(drawnField);
    const ranges = [];
    const focused = focus ? lineOf(state.doc, focus.at, focus.line) : null;
    for (let n = 1; n <= state.doc.lines; n += 1) {
      const line = state.doc.line(n);
      const these = marks.get(line.text.trim());
      const classes = [];
      if (these?.length) classes.push(`cm-checked cm-checked-${Math.min(these.length, 4)}`);
      if (focused?.number === n) classes.push("cm-focus");
      if (classes.length) ranges.push(Decoration.line({ class: classes.join(" ") }).range(line.from));
      if (these?.length) ranges.push(Decoration.widget({ widget: new MarksWidget(these, point), side: 1 }).range(line.to));
    }
    return Decoration.set(ranges);
  });

const ERRORS = {
  "signed-out": "Sign in to run evaluators.",
  key: "Add a Jev key in Settings.",
  "used-up": "You have used all your free use.",
  paused: "Free trials are paused for now.",
  blocked: "This trial has ended.",
  busy: "Jev is busy. Try again in a moment.",
  failed: "Jev could not answer. Try again.",
};

class EvaluatorList extends LitElement {
  // Follow the book open on the stage. Reflected so a page's bare `subject` reads as true.
  // `folded`: the list of evaluators starts hidden under the Evaluate box.
  static properties = { subject: { type: Boolean, reflect: true }, folded: { type: Boolean } };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
    }
    /* The book the list shows, so a list kept on a pinned book says which one; the same
       caption as the note editor's About line. */
    .about {
      margin: 0;
      padding: var(--space-xs) var(--space-md) 0;
      font-size: var(--text-caption);
      color: var(--color-mute);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: var(--space-2xs);
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
    }
    .row:hover {
      background: var(--color-surface-hover);
    }
    .row:has(.open:focus-visible) {
      box-shadow: var(--focus-ring);
    }
    .row.current {
      background: var(--color-accent-subtle);
    }
    input[type="checkbox"] {
      flex: none;
      width: calc(var(--space-md) + var(--space-2xs));
      height: calc(var(--space-md) + var(--space-2xs));
      margin: 0;
      accent-color: var(--color-accent);
      cursor: pointer;
    }
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The row's name is its open button: the whole text area opens the evaluator, the
       tick box beside it only switches it. */
    .open {
      flex: 1;
      min-width: 0;
      display: block;
      font: inherit;
      text-align: left;
      color: inherit;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
    }
    .open:focus-visible {
      outline: none;
    }
    .name {
      display: block;
      color: var(--color-body);
      font-weight: var(--weight-semibold);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name.off {
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .name.untitled {
      color: var(--color-mute);
      font-weight: var(--weight-normal);
    }
    .name.draft {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .name.draft svg {
      font-size: var(--text-body);
    }
    .sub {
      display: block;
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-body-mid);
    }
    /* The Evaluate box sits above the list, outside it, so its keys never reach the list's. */
    .run {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md) var(--space-md) var(--space-sm);
    }
    .run label {
      cursor: default;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    /* The box's frame, drawn around the editor, which draws none. */
    .box {
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      cursor: text;
    }
    .box:focus-within {
      box-shadow: var(--focus-ring);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    /* Jev's marks at an answered line's right end, as tall as the line, so the line keeps
       its height. */
    .marks {
      position: absolute;
      top: 0;
      right: var(--space-xs);
      display: flex;
      gap: var(--space-2xs);
      user-select: none;
      -webkit-user-select: none;
    }
    .mark {
      display: inline-grid;
      place-items: center;
      width: calc(var(--text-body) * var(--leading-normal));
      height: calc(var(--text-body) * var(--leading-normal));
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      cursor: pointer;
    }
    .mark svg {
      display: block;
    }
    .mark.right {
      color: var(--color-success);
      background: var(--color-success-subtle);
    }
    .mark.wrong {
      color: var(--color-danger);
      background: var(--color-danger-subtle);
    }
    /* Faded when Jev is not sure: anything but the plain answer. */
    .mark.unsure {
      opacity: 0.5;
    }
    .mark.pending {
      cursor: default;
    }
    .mark.pending i {
      width: calc(var(--space-xs) * 1.5);
      height: calc(var(--space-xs) * 1.5);
      border-radius: var(--radius-full);
      background: var(--color-mute);
      animation: pulse calc(var(--duration-slide) * 4) ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.3;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .mark.pending i {
        animation: none;
      }
    }
    /* The fold line and the buttons; on a narrow panel the buttons wrap under the fold line.
       Every target is at least 44px tall, for a finger. */
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-sm);
    }
    .actions button {
      font: inherit;
      font-size: var(--text-sm);
      min-height: calc(var(--space-xl) + var(--space-xs));
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .actions button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .fold {
      flex: 0 1 auto;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: 0 var(--space-xs);
      margin-left: calc(var(--space-xs) * -1);
      text-align: left;
      color: var(--color-body);
      background: none;
      border: 0;
    }
    .fold:hover {
      background: var(--color-surface-hover);
    }
    .fold svg {
      flex: none;
      transition: transform var(--duration-slide) ease;
    }
    .fold[aria-expanded="true"] svg {
      transform: rotate(90deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .fold svg {
        transition: none;
      }
    }
    .fold b {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .buttons {
      flex: none;
      display: flex;
      gap: var(--space-sm);
      margin-left: auto;
    }
    .buttons button {
      padding: var(--space-sm) var(--space-md);
    }
    .clear,
    .stop {
      color: var(--color-body);
      background: none;
      border: var(--border-width) solid var(--color-border);
    }
    .stop {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      border-color: var(--color-border-strong);
    }
    .clear:hover,
    .stop:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    .stop:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .go {
      font-weight: var(--weight-semibold);
      color: var(--color-accent-text);
      background: var(--color-accent);
      border: 0;
    }
    .go:hover:not(:disabled) {
      background: var(--color-accent-hover);
    }
    .go:disabled {
      color: var(--color-mute);
      background: var(--color-border);
      cursor: default;
    }
    /* The list of evaluators, when shown, between the box and the results. */
    .list {
      border-top: var(--border-width) solid var(--color-border);
      border-bottom: var(--border-width) solid var(--color-border);
    }
    .out {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md) var(--space-md);
    }
    .out:empty {
      display: none;
    }
    /* The free-use message (try-links screen 2): danger when this guest is out, warning
       while trials are paused for everyone. */
    .notice {
      margin: 0;
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      color: var(--color-ink);
      background: var(--color-warning-subtle);
    }
    .notice.used-up,
    .notice.blocked {
      background: var(--color-danger-subtle);
    }
    .error {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    /* The panel under the box: the line in focus, told in detail. */
    .focus {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      margin: 0;
      padding: var(--space-sm) var(--space-md);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .where {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      column-gap: var(--space-sm);
      row-gap: var(--space-2xs);
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .bar {
      flex: 1 1 calc(var(--space-2xl) * 2);
      height: calc(var(--space-2xs) * 1.5);
      border-radius: var(--radius-full);
      background: var(--color-border);
      overflow: hidden;
    }
    .bar span {
      display: block;
      height: 100%;
      border-radius: var(--radius-full);
      background: var(--color-accent);
      transition: width var(--duration-slide) ease;
    }
    @media (prefers-reduced-motion: reduce) {
      .bar span {
        transition: none;
      }
    }
    .quote {
      margin: 0;
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
      overflow-wrap: anywhere;
    }
    .by {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      color: var(--color-mute);
    }
    .answers {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .answer {
      display: flex;
      align-items: flex-start;
      gap: var(--space-sm);
    }
    /* The answer's icon, coloured as its mark: green when it is the answer expected, red
       when not, plain when nothing is expected. */
    .tile {
      flex: none;
      display: inline-grid;
      place-items: center;
      width: calc(var(--space-lg) + var(--space-xs));
      height: calc(var(--space-lg) + var(--space-xs));
      border-radius: var(--radius-sm);
      font-size: var(--text-subtitle);
      color: var(--color-body-mid);
      background: var(--color-canvas-soft);
    }
    .tile svg {
      display: block;
    }
    .tile.right {
      color: var(--color-success);
      background: var(--color-success-subtle);
    }
    .tile.wrong {
      color: var(--color-danger);
      background: var(--color-danger-subtle);
    }
    .said {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      min-width: 0;
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-body-mid);
      overflow-wrap: anywhere;
    }
    .words {
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .expect {
      font-weight: var(--weight-semibold);
    }
    .expect.right {
      color: var(--color-success);
    }
    .expect.wrong {
      color: var(--color-danger);
    }
    .empty {
      margin: 0;
      padding: var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  // Which row holds the roving tab stop: the one the keyboard moved to, else the open
  // one, else New evaluator. Ephemeral UI focus, not a fact.
  #focusId = null;

  // When the editor opens another evaluator, by a pick or by itself, the keyboard starts
  // again from that row rather than from where it last moved.
  #seenOpen = null;

  #focusRow(ids, open) {
    if (open !== this.#seenOpen) {
      this.#seenOpen = open;
      this.#focusId = null;
    }
    if (this.#focusId && ids.includes(this.#focusId)) return this.#focusId;
    if (open && ids.includes(open)) return open;
    return ids[0] ?? null;
  }

  // A panel's focus lands in what it shows (list-then-item, dock-desk): the roving row.
  focus(options) {
    // With the list hidden, the fold line that shows it.
    const target =
      this.renderRoot?.querySelector('.open[tabindex="0"]') ?? this.renderRoot?.querySelector(".open") ?? this.renderRoot?.querySelector(".fold");
    if (target) target.focus(options);
    else super.focus(options);
  }

  // A click anywhere on a row opens it, except on its tick box, which only switches.
  #rowClick(event, id) {
    if (event.target.closest?.('input[type="checkbox"]')) return;
    this.#actor.send({ type: "_pick", id });
  }

  // Vim letters (12, "Vim keys"), as in the other lists: only while the preference is on,
  // never with a modifier held (those belong to the browser and the desk), and never in a
  // field, where a letter is typed text. gg is two presses, so a first g waits a moment.
  #gAt = 0;
  #vim(event) {
    if (this.#actor.snapshot?.context.vimKeys !== true) return null;
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    const target = event.composedPath()[0];
    if (target?.isContentEditable || target?.tagName === "TEXTAREA" || (target?.tagName === "INPUT" && target.type !== "checkbox")) return null;
    const second = event.key === "g" && Date.now() - this.#gAt < 1000;
    this.#gAt = event.key === "g" && !second ? Date.now() : 0;
    if (second) return "first";
    return { j: "down", k: "up", G: "last", g: "prefix" }[event.key] ?? null;
  }

  #keydown(event, ids) {
    const vim = this.#vim(event);
    // Every Vim letter the list owns is spent here, even with nowhere to move: an
    // uncancelled letter is typed wherever WebKit still keeps a selection.
    if (vim) event.preventDefault();
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? { down: 1, up: -1 }[vim];
    if (!step && vim !== "first" && vim !== "last") return;
    const current = this.#focusRow(ids, this.#actor.snapshot.context.open);
    const at = ids.indexOf(current);
    const to = vim === "first" ? 0 : vim === "last" ? ids.length - 1 : at + step;
    const next = ids[Math.min(ids.length - 1, Math.max(0, to))];
    if (!next || next === current) return;
    event.preventDefault();
    this.#focusId = next;
    this.requestUpdate();
    // The row moved to is scrolled into view by whichever box scrolls around the list.
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector(`.row[data-id="${next}"] .open`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  }

  // Rows are drawn by position (lit-core has no keyed repeat), so a row removed above the
  // focused one would leave the focus on whatever now fills its element: the keyboard
  // follows the roving row, which is keyed by id, instead.
  updated() {
    this.#syncBox();
    const active = this.renderRoot.activeElement;
    if (!active?.matches(".open")) return;
    const roving = this.renderRoot.querySelector('.open[tabindex="0"]');
    if (roving && roving !== active) roving.focus({ preventScroll: true });
  }

  // A row reached by a click or Tab becomes the keyboard's row.
  #focusin(event) {
    const id = event.composedPath()[0]?.closest?.(".row")?.dataset.id;
    if (id && id !== this.#focusId) {
      this.#focusId = id;
      this.requestUpdate();
    }
  }

  // Whether the list of evaluators is hidden: read once, from this browser's last fold or
  // else the page's `folded`, then the user's own.
  #folded = null;

  #isFolded() {
    if (this.#folded == null) this.#folded = foldedAtStart(this.folded, readFold());
    return this.#folded;
  }

  #toggleFold() {
    this.#folded = !this.#isFolded();
    writeFold(this.#folded);
    this.requestUpdate();
  }

  // The Evaluate box's editor, made once its region is drawn and kept while the list is
  // reloaded, then put back in the region drawn anew.
  #box = null;
  #boxVim = false;
  // The line asked last scrolled into view, so it is scrolled to once.
  #followed = null;

  #point(at, line) {
    this.#actor.send({ type: "_point", at, line });
  }

  #makeBox(region, context) {
    this.#boxVim = context.vimKeys === true;
    this.#box = new EditorView({
      parent: region,
      // Shadow DOM: CodeMirror reads the selection through the root and mounts its
      // stylesheet there, so it must know the shadow root.
      root: this.renderRoot,
      state: EditorState.create({
        doc: context.text,
        extensions: [
          ...baseExtensions({ vim: this.#boxVim }),
          paragraphs(),
          boxTheme,
          placeholder("Write or paste your text. Each line is evaluated on its own."),
          EditorView.contentAttributes.of({ "aria-label": "Write one sentence per line", id: "text" }),
          drawnField,
          drawn((at, line) => this.#point(at, line)),
          EditorView.updateListener.of((update) => {
            const own = !update.transactions.every((t) => t.annotation(fromMachine));
            if (update.docChanged && own) this.#actor.send({ type: "_type", text: update.state.doc.toString() });
            // The line clicked or moved to, while the box has the keyboard.
            if ((update.selectionSet || update.focusChanged) && update.view.hasFocus && own) {
              const line = update.state.doc.lineAt(update.state.selection.main.head);
              this.#point(line.number, line.text);
            }
          }),
        ],
      }),
    });
  }

  // The box follows the machine: the text when it changed elsewhere (another book), Vim,
  // the marks and the line in focus, and during a run the line asked, scrolled into view.
  #syncBox() {
    const snapshot = this.#actor.snapshot;
    const region = this.renderRoot.querySelector(".box");
    if (!snapshot || !region) return;
    const { context } = snapshot;
    if (!this.#box) this.#makeBox(region, context);
    else if (this.#box.dom.parentNode !== region) region.replaceChildren(this.#box.dom);
    const view = this.#box;
    this.#boxVim = context.vimKeys === true;
    setVim(view, this.#boxVim);
    const marks = new Map();
    for (const r of context.runs) {
      const these = marksOf(r);
      if (these.length && !marks.has(r.line)) marks.set(r.line, these);
    }
    const at = focusOf(context);
    const value = { marks, focus: at < 0 ? null : { at: context.runs[at].at, line: context.runs[at].line } };
    const key = JSON.stringify([[...marks], value.focus]);
    const doc = view.state.doc.toString();
    const changes = doc === context.text ? undefined : { from: 0, to: doc.length, insert: context.text };
    const effects = key === this.#drawnKey ? [] : [setDrawn.of(value)];
    this.#drawnKey = key;
    const asking = context.runs.find((r) => r.status === "asking");
    const follow = asking ? `${asking.at}:${asking.line}` : null;
    if (follow && follow !== this.#followed) {
      const line = lineOf(changes ? view.state.update({ changes }).state.doc : view.state.doc, asking.at, asking.line);
      if (line) effects.push(EditorView.scrollIntoView(line.from, { y: "nearest" }));
    }
    this.#followed = follow;
    if (changes || effects.length) view.dispatch({ changes, effects, annotations: fromMachine.of(true) });
  }

  #drawnKey = null;

  disconnectedCallback() {
    this.#box?.destroy();
    this.#box = null;
    this.#drawnKey = null;
    super.disconnectedCallback();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("idle")) return html`<p class="empty">Open a book to see its evaluators.</p>`;
    if (snapshot.matches("failed")) return html`<p class="empty">Evaluators unavailable.</p>`;
    const { draft, open, evaluators, book, titles } = snapshot.context;
    const shown = rows(evaluators);
    const ids = [draft, ...shown.map((e) => e.id)];
    const focusId = this.#focusRow(ids, open);
    const stop = notice(snapshot.context);
    return html`
      ${this.#header(snapshot)}
      ${this.#runBox(snapshot)}
      ${this.#isFolded()
        ? nothing
        : html`<ul class="list" id="evaluators" aria-label="Evaluators" @keydown=${(e) => this.#keydown(e, ids)} @focusin=${(e) => this.#focusin(e)}>
            <li class="row new" data-id=${draft} @click=${(e) => this.#rowClick(e, draft)}>
              <button class="open" type="button" tabindex=${draft === focusId ? 0 : -1}>
                <span class="name draft">${icon("plus")}New evaluator</span>
              </button>
            </li>
            ${shown.map((e) => this.#row(e, open, focusId, e.book === book ? null : (titles[e.book] ?? "Another book")))}
          </ul>`}
      <div class="out">${stop ? html`<p class="notice ${stop}" role="status">${ERRORS[stop]}</p>` : nothing}</div>
    `;
  }

  // Only while following the stage: the book the list shows (12).
  #header(snapshot) {
    const { following, book, titles } = snapshot.context;
    const title = following ? titles[book] : null;
    return title ? html`<p class="about">About: ${title}</p>` : nothing;
  }

  // The editor is made into .box after render (#syncBox). A press on the caption puts the
  // keyboard in the box, as a label does for a field.
  #runBox(snapshot) {
    const { text, evaluators, runs, running, stopping, freeUse } = snapshot.context;
    const asked = askable(evaluators);
    const names = asked.map((a) => evaluators.find((e) => e.id === a.id)?.name.trim() || UNTITLED);
    const folded = this.#isFolded();
    const parts = foldLine(names, rows(evaluators).some((e) => e.on));
    return html`
      <div class="run">
        <label @click=${() => this.#box?.focus()}>Write one sentence per line</label>
        <div class="box"></div>
        <div class="actions">
          <button class="fold" type="button" aria-expanded=${folded ? "false" : "true"} aria-controls="evaluators" @click=${() => this.#toggleFold()}>
            ${icon("caret-right")}<span>${parts.map(([part, bold]) => (bold ? html`<b>${part}</b>` : part))}</span>
          </button>
          <span class="buttons">
            ${running
              ? html`<button class="stop" type="button" ?disabled=${stopping} @click=${() => this.#actor.send({ type: "_stop" })}>${stopLabel(stopping)}</button>`
              : html`${runs.length > 0 ? html`<button class="clear" type="button" @click=${() => this.#actor.send({ type: "_clear" })}>Clear</button>` : nothing}
                  <button
                    class="go"
                    type="button"
                    ?disabled=${asked.length === 0 || text.trim() === "" || freeStop(freeUse) != null}
                    @click=${() => this.#actor.send({ type: "_run" })}
                  >
                    ${evaluateLabel(lines(text).length)}
                  </button>`}
          </span>
        </div>
        ${this.#panel(snapshot.context)}
      </div>
    `;
  }

  // The line in focus, told in detail: where it stands in the run, the line, and each
  // answer with its mark, what the option means, what else was close, and whether it is
  // the answer expected. Hidden while no line is answered.
  #panel(context) {
    const at = focusOf(context);
    if (at < 0) return nothing;
    const { runs, evaluators } = context;
    const r = runs[at];
    const count = tally(runs);
    const names = new Map(rows(evaluators).map((e) => [e.id, e.name.trim() || UNTITLED]));
    const verdicts = Object.entries(r.results);
    return html`<section class="focus" aria-label="The line in focus">
      <p class="where">
        <span>Line ${at + 1} of ${count.total}</span>
        <span class="bar" role="progressbar" aria-label="Lines evaluated" aria-valuemin="0" aria-valuemax=${count.total} aria-valuenow=${count.done}
          ><span style=${`width: ${count.total ? Math.round((count.done / count.total) * 100) : 0}%`}></span
        ></span>
        <span>${count.words}</span>
      </p>
      <p class="quote">“${r.line}”</p>
      ${r.status === "failed" && !STOPS.includes(r.error) ? html`<p class="error" role="alert">${ERRORS[r.error]}</p>` : nothing}
      ${verdicts.map(
        ([id, result]) => html`${verdicts.length > 1 ? html`<p class="by">${names.get(id) ?? UNTITLED}</p>` : nothing}
          <ul class="answers" aria-label="Answers from ${names.get(id) ?? UNTITLED}">
            ${result.questions.map((q) => this.#answer(q))}
          </ul>`,
      )}
    </section>`;
  }

  #answer(q) {
    const expect = sayExpect(q);
    return html`<li class="answer">
      <span class="tile ${q.tone ?? ""}" aria-hidden="true">${q.glyph ? GLYPHS[q.glyph]?.() : nothing}</span>
      <span class="said">
        ${q.question ? html`<span class="question">${q.question}</span>` : nothing}
        <span class="words">${q.words}</span>
        ${q.meaning ? html`<span class="meaning">${q.meaning}</span>` : nothing}
        ${q.also ? html`<span class="also">Also close: ${q.also}</span>` : nothing}
        ${expect ? html`<span class="expect ${expect.tone}">${expect.text}</span>` : nothing}
      </span>
    </li>`;
  }

  // from: the title of the book a row shown in the journal is kept with, or null.
  #row(e, open, focusId, from) {
    const tab = e.id === focusId ? 0 : -1;
    const name = e.name.trim();
    return html`
      <li class="row ${e.id === open ? "current" : ""}" data-id=${e.id} @click=${(event) => this.#rowClick(event, e.id)}>
          <input
            type="checkbox"
            tabindex=${tab}
            .checked=${e.on}
            aria-label="${name || UNTITLED} is on"
            @change=${(event) => this.#actor.send({ type: "_switch", id: e.id, on: event.target.checked })}
          />
          <button class="open" type="button" tabindex=${tab} aria-current=${e.id === open ? "true" : nothing}>
            <span class="name ${name ? (e.on ? "" : "off") : "untitled"}">${name || UNTITLED}</span>
            <span class="sub">${subtitle(e, from)}</span>
          </button>
      </li>
    `;
  }
}

customElements.define("evaluator-list", EvaluatorList);
