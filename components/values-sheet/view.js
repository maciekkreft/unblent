import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Prec, Annotation, StateField, StateEffect } from "@codemirror/state";
import { EditorView, placeholder, Decoration, WidgetType } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, toRegister } from "editor";
import { machine, writable, placeable, isPlaced, shownValues, earlierDays, changedLine, dayName, dateOf, boxMarks, marksFor, warned, statusOf, sayMarks, rowKey, suggestionFor } from "./machine.js";
import saved from "./events/values.saved.json" with { type: "json" };
import placed from "./events/values.placed.json" with { type: "json" };

// The view sits in journal-entry's slot, under the day's text and above the choice
// points, inside the day's scrolling page, so it scrolls with the day it is about. It is
// drawn like choice-point-cards: the same section, card, sheet and New row.

// Each box is a CodeMirror editor built on the editor kit (10), so it takes Vim's keys when
// the "Vim keys" preference (12) is on. A box holds one line (the machine turns a break
// into a space), so it has no paragraphs and no lists.
const boxTheme = (name) =>
  EditorView.theme({
    "&": { flex: "1" },
    ".cm-content": { padding: "var(--space-xs) var(--space-sm)" },
    ".cm-line": name
      ? { fontSize: "var(--text-body)", fontWeight: "var(--weight-semibold)", color: "var(--color-ink)" }
      : { fontSize: "var(--text-sm)" },
    // A checked line keeps room at its right end for its marks, which stand there.
    ".cm-line.cm-checked": { position: "relative" },
    ...Object.fromEntries(
      [1, 2, 3, 4].map((n) => [`.cm-line.cm-checked-${n}`, { paddingRight: `calc((var(--text-sm) + var(--space-xs) * 2 + var(--space-2xs)) * ${n})` }]),
    ),
  });
const nameTheme = boxTheme(true);
const meaningTheme = boxTheme(false);

const HINTS = { name: "A value, such as Being a present parent", meaning: "An example of living it (optional)" };
const LABELS = { name: "Value", meaning: "Example" };

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

// Jev's marks for a box, by line text, as the machine decided them (boxMarks); a box holds
// one line, so at most one entry matches.
const setMarks = StateEffect.define();
const marksField = StateField.define({
  create: () => new Map(),
  update: (value, tr) => tr.effects.reduce((v, e) => (e.is(setMarks) ? e.value : v), value),
});

// The names are literals so the icon check sees each one (11.2).
const MARK_ICONS = {
  check: () => icon("check"),
  warning: () => icon("warning"),
  gavel: () => icon("gavel"),
  prohibit: () => icon("prohibit"),
  "person-simple-walk": () => icon("person-simple-walk"),
  brain: () => icon("brain"),
  heart: () => icon("heart"),
  trophy: () => icon("trophy"),
  "hand-palm": () => icon("hand-palm"),
  footprints: () => icon("footprints"),
  question: () => icon("question"),
  compass: () => icon("compass"),
};

const markOf = (m) =>
  m.pending
    ? html`<span class="mark pending" title=${sayMarks([m])}><i></i></span>`
    : html`<span class="mark ${m.tone}" title=${sayMarks([m])} style=${`opacity: ${m.sure}`}>${MARK_ICONS[m.icon]?.()}</span>`;

// The marks at a line's end, as choice-point-cards draws them. They are a widget, not
// text: the cursor, Vim and the line's height pass them by, and CodeMirror ignores their
// events. The pointer over them, or a tap, says which line the status line tells about.
class MarksWidget extends WidgetType {
  constructor(marks, text, point) {
    super();
    this.marks = marks;
    this.text = text;
    this.point = point;
    this.key = JSON.stringify(marks);
  }

  eq(other) {
    return other.key === this.key && other.text === this.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "marks";
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", sayMarks(this.marks));
    render(this.marks.map(markOf), span);
    span.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch") return;
      span.dataset.over = "";
      this.point("hover", this.text);
    });
    span.addEventListener("pointerleave", () => {
      delete span.dataset.over;
      this.point("hover", null);
    });
    // Pressing a mark keeps the cursor and the keyboard where they are.
    span.addEventListener("mousedown", (e) => e.preventDefault());
    span.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.point("tap", this.text);
    });
    return span;
  }

  destroy(dom) {
    if ("over" in dom.dataset) this.point("hover", null);
  }

  ignoreEvent() {
    return true;
  }
}

const marksDecorations = (point) =>
  EditorView.decorations.compute([marksField, "doc"], (state) => {
    const marks = state.field(marksField);
    if (!marks.size) return Decoration.none;
    const ranges = [];
    for (let i = 1; i <= state.doc.lines; i += 1) {
      const line = state.doc.line(i);
      const these = marks.get(line.text);
      if (!these?.length) continue;
      ranges.push(Decoration.line({ class: `cm-checked cm-checked-${Math.min(these.length, 4)}` }).range(line.from));
      ranges.push(Decoration.widget({ widget: new MarksWidget(these, line.text, point), side: 1 }).range(line.to));
    }
    return Decoration.set(ranges);
  });

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo window;
// the token is the one clock, shared with the bar's animation.
const toMs = (text, fallback = 3000) => {
  const t = text.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
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
        now: () => Date.now(),
        // Vim's registers are one per page, so text put there is what any editor's p pastes.
        pushRegister: toRegister,
        // Read off the host so a stylesheet or a test can shorten it.
        undoMs: toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo")),
      },
      events: { "values.saved": saved, "values.placed": placed },
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

class ValuesSheet extends LitElement {
  static styles = css`
    :host {
      display: block;
      color: var(--color-body);
    }
    /* Focusable only by script and by a press, so a press on the section's own text lands
       here rather than being handed to the journal's text by its delegated focus. */
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding-top: var(--space-md);
      border-top: var(--border-width) solid var(--color-border);
    }
    section:focus {
      outline: none;
    }
    section.folded {
      cursor: pointer;
    }
    h3 {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-body-mid);
    }
    button {
      appearance: none;
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      color: var(--color-ink);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border-strong);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: default;
      color: var(--color-mute);
    }
    /* The New value and Write your values rows read like the New choice point row: a
       muted line with a plus, the whole width. */
    .new {
      display: flex;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: var(--space-xs) var(--space-sm);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-body-mid);
    }
    .new:hover {
      background: var(--color-surface-hover);
    }
    .plus {
      display: inline-flex;
      margin-right: var(--space-xs);
    }
    .plus svg,
    .remove svg {
      display: block;
    }
    .card {
      display: block;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: var(--space-sm) var(--space-md);
      border-color: var(--color-border);
      border-radius: var(--radius-md);
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
    }
    .sheet {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
    }
    .caption {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .rows {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .row {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-2xs) var(--space-xs);
      align-items: start;
    }
    .fields {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      min-width: 0;
    }
    /* CodeMirror owns everything inside .box; the frame is drawn here, around it. */
    .box {
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      background: var(--color-canvas);
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
    /* A value read, not written: plain text, no frame or text cursor invites typing. */
    .name,
    .meaning {
      margin: 0;
      padding: 0 var(--space-sm);
      overflow-wrap: anywhere;
    }
    .name {
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .meaning {
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .remove {
      display: inline-grid;
      place-items: center;
      padding: var(--space-xs);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-body-mid);
    }
    .remove:hover {
      background: var(--color-surface-hover);
      color: var(--color-danger);
    }
    /* A value counting down to its removal is struck through, with Undo and the draining
       bar, as a row counting down to its delete is in the lists. */
    .row.removing {
      overflow: hidden;
      align-items: center;
      padding-bottom: var(--space-2xs);
    }
    .row.removing .name,
    .row.removing .meaning {
      color: var(--color-mute);
      text-decoration: line-through;
    }
    .undo {
      appearance: none;
      background: none;
      border: 0;
      padding: var(--space-xs);
      font-size: var(--text-caption);
      color: var(--color-accent);
    }
    /* Could be: a muted line under the example, so the pair stays together, with Use; after Use, Was and the old
       value with Undo, over the draining bar of the undo window. */
    .suggest {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0 var(--space-xs);
      padding: 0 var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      overflow-wrap: anywhere;
    }
    .suggest.was {
      padding-bottom: var(--space-2xs);
    }
    .suggest button {
      appearance: none;
      background: none;
      border: 0;
      padding: 0 var(--space-xs);
      font-size: var(--text-caption);
      color: var(--color-accent);
    }
    /* The visible echo of the machine's timer; both read --duration-undo, so they cannot
       disagree. It stays under reduced motion because it is the only sign of how long is
       left. */
    .drain {
      position: absolute;
      inset-inline: 0;
      inset-block-end: 0;
      height: var(--space-2xs);
      background: var(--color-accent);
      transform-origin: left;
      animation: drain var(--duration-undo) linear forwards;
    }
    @keyframes drain {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0);
      }
    }
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .about {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2xs) var(--space-sm);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .link {
      padding: 0;
      border: 0;
      background: none;
      font-size: var(--text-caption);
      color: var(--color-accent);
      text-decoration: underline;
      text-underline-offset: 0.15em;
    }
    .versions {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .version {
      text-align: left;
      padding: var(--space-xs) var(--space-sm);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
    }
    .version:hover {
      background: var(--color-surface-hover);
    }
    .buttons {
      display: flex;
      gap: var(--space-sm);
      margin-left: auto;
    }
    .buttons button {
      padding: var(--space-xs) var(--space-md);
      border-radius: var(--radius-md);
    }
    .buttons button:hover {
      background: var(--color-surface-hover);
    }
    .buttons .done {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: var(--color-accent-text);
    }
    .buttons .done:hover {
      background: var(--color-accent-hover);
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* Jev's marks at a checked line's right end, as tall as the line, so a box keeps its
       height; on a row only read, after its text. */
    .marks {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;
      gap: var(--space-2xs);
      user-select: none;
      -webkit-user-select: none;
    }
    .marks.after {
      position: static;
      display: inline-flex;
      vertical-align: top;
      margin-left: var(--space-xs);
    }
    .mark {
      display: inline-grid;
      place-items: center;
      width: calc(var(--text-sm) + var(--space-xs) * 2);
      height: calc(var(--text-sm) * var(--leading-normal));
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
      cursor: pointer;
    }
    .mark svg {
      display: block;
    }
    .mark:hover {
      background: var(--color-surface-hover);
    }
    .mark.right {
      color: var(--color-success);
      background: var(--color-success-subtle);
    }
    .mark.wrong {
      color: var(--color-danger);
      background: var(--color-danger-subtle);
    }
    .mark.pending {
      cursor: default;
      background: none;
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
    .status {
      flex-basis: 100%;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    /* An empty status line keeps its height: pressing Done takes the cursor out of a line
       or clears a tapped mark, which empties it, and Done must not move before the release,
       or the press and the release land on different places and make no click. */
    .status.none {
      visibility: hidden;
    }
    .flag {
      display: inline-flex;
      vertical-align: middle;
      margin-left: var(--space-2xs);
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    .flag svg {
      display: block;
    }
    .tools {
      display: flex;
      align-items: start;
    }
    /* The move buttons show while the pointer or the keyboard is on the row, and always
       where there is no pointer to hover with. Hidden, they stay focusable, so the keyboard
       can follow a row as it moves. */
    .order {
      display: flex;
      flex-direction: column;
      opacity: 0;
    }
    .row:hover .order,
    .row:focus-within .order,
    :host([phone]) .order {
      opacity: 1;
    }
    @media (hover: none) {
      .order {
        opacity: 1;
      }
    }
    .order button {
      display: inline-grid;
      place-items: center;
      padding: var(--space-2xs) var(--space-xs);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-body-mid);
    }
    .order button:hover:not(:disabled) {
      background: var(--color-surface-hover);
      color: var(--color-ink);
    }
    .order button:disabled {
      visibility: hidden;
    }
    .order svg {
      display: block;
    }
    /* A row with the keyboard (Vim keys: Escape from a box) is drawn as selected. */
    .row:focus {
      outline: none;
      border-radius: var(--radius-sm);
      background: var(--color-surface-hover);
      box-shadow: var(--focus-ring);
    }
    /* A cut row (Vim's dd) waits greyed in place for p or P, with no countdown. */
    .row.cut .cm-line,
    .row.cut .cut-mark {
      color: var(--color-mute);
    }
    .cut-mark {
      align-self: center;
      padding: 0 var(--space-xs);
      font-size: var(--text-caption);
    }
  `;

  #actor = new ActorController(this);

  // Where the keyboard goes once the next render lands, as a selector. Kept here because
  // the elements exist only after render.
  #focusNext = null;

  // The editors of the open sheet by key ("<id>:<field>"), each with the region it is
  // drawn in; and what the last render asked of each box.
  #boxes = new Map();
  #wanted = new Map();

  // Set while a row moves, so the blur of the box or row the move takes away from under
  // the keyboard is not taken as the user leaving it; the key of the box to give the
  // keyboard back to, with its cursor where it was.
  #moving = false;
  #refocus = null;
  #keep = null;

  // The first cursor the browser sets in a box just moved is not the user's: it is put
  // back to where the cursor was before the move.
  #keepCursor(key, update) {
    const keep = this.#keep;
    if (!keep || keep.key !== key || !update.selectionSet) return;
    if (update.docChanged || Date.now() > keep.until) {
      this.#keep = null;
      return;
    }
    if (!update.transactions.some((t) => t.isUserEvent("select") && !t.isUserEvent("select.pointer"))) return;
    this.#keep = null;
    if (!update.state.selection.eq(keep.selection)) queueMicrotask(() => update.view.dispatch({ selection: keep.selection }));
  }

  // Views only read the document (7.5): the move buttons always show in the phone preview.
  #viewport = new MutationObserver(() => this.#frame());

  #frame() {
    this.toggleAttribute("phone", document.documentElement.getAttribute("data-viewport") === "phone");
  }

  connectedCallback() {
    super.connectedCallback();
    this.#frame();
    this.#viewport.observe(document.documentElement, { attributes: true, attributeFilter: ["data-viewport"] });
  }

  updated() {
    this.#syncBoxes();
    if (this.#refocus) {
      // Reattached and focused, the editor reads the cursor from where the browser put it
      // a moment later; the cursor it had is put back then (#keepCursor).
      const { key, selection } = this.#refocus;
      const view = this.#boxes.get(key)?.view;
      view?.focus();
      view?.dispatch({ selection });
      this.#keep = { key, selection, until: Date.now() + 150 };
      this.#refocus = null;
    }
    this.#moving = false;
    if (!this.#focusNext) return;
    const target = this.renderRoot.querySelector(this.#focusNext) ?? this.renderRoot.querySelector(".card, .new");
    this.#focusNext = null;
    const box = [...this.#boxes.values()].find((b) => b.region === target);
    if (box) this.#focusBox(box);
    else target?.focus();
  }

  // A box given the keyboard takes it in Vim's insert mode when Vim keys is on, so the
  // first key typed is text.
  #focusBox(box) {
    box.view.focus();
    const cm = box.vimOn ? getCM(box.view) : null;
    if (cm && cm.state?.vim?.insertMode !== true) Vim.handleKey(cm, "i", "user");
  }

  // Escape (12): with Vim on, an Escape in insert or visual mode is Vim's, back to normal
  // mode; any other folds the sheet like Done. Enter moves on to the next box, or to the
  // New value row after the last, since a box holds one line. A keydown handler at
  // Prec.highest, not a keymap, because the Vim plugin's handler runs before every keymap.
  //
  // Alt+Up and Alt+Down move the row and keep the cursor where it is. With Vim keys on, an
  // Escape in normal mode puts the keyboard on the row (rowKeydown).
  #keys(key, id) {
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (event.isComposing) return false;
          if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            this.#moveBy(id, event.key === "ArrowUp" ? -1 : 1, key);
            return true;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            this.#next(key);
            return true;
          }
          if (event.key !== "Escape") return false;
          event.stopPropagation();
          const vimOn = this.#boxes.get(key)?.vimOn;
          const mode = vimOn ? getCM(view)?.state?.vim : null;
          if (mode?.insertMode || mode?.visualMode) return false;
          event.preventDefault();
          if (vimOn) this.#toRow(id);
          else this.#done();
          return true;
        },
      }),
    );
  }

  #next(key) {
    const regions = [...this.renderRoot.querySelectorAll(".box[data-key]")];
    const at = regions.findIndex((r) => r.dataset.key === key);
    const next = regions[at + 1];
    const box = next && this.#boxes.get(next.dataset.key);
    if (box) this.#focusBox(box);
    else this.renderRoot.querySelector(".sheet .new")?.focus();
  }

  #extensions(key, spec, vimOn) {
    return [
      this.#keys(key, spec.id),
      ...baseExtensions({ vim: vimOn }),
      spec.field === "name" ? nameTheme : meaningTheme,
      placeholder(HINTS[spec.field]),
      EditorView.contentAttributes.of({ "aria-label": LABELS[spec.field] }),
      marksField.init(() => spec.marks),
      marksDecorations((source, text) => this.#actor.send({ type: "_point", source, id: spec.id, field: text == null ? null : spec.field, text })),
      EditorView.updateListener.of((update) => {
        this.#keepCursor(key, update);
        if (update.selectionSet || update.docChanged || update.focusChanged) this.#cursorOn(spec.id, spec.field, update.view);
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#actor.send({ type: "_edit", id: spec.id, field: spec.field, value: update.state.doc.toString() });
      }),
      // Which row the keyboard went to tells the machine whether this row was left.
      EditorView.domEventHandlers({
        blur: (event) => {
          if (this.#moving) return;
          this.#actor.send({ type: "_blur", id: spec.id, to: event.relatedTarget?.closest?.(".row")?.dataset.id ?? null });
        },
      }),
    ];
  }

  // The line the text cursor is in, told to the machine when it changes, so the status line
  // can say Jev's answers about it; nothing while no box has the keyboard.
  #cursorAt = null;
  #cursorOn(id, field, view) {
    const here = (at) => at?.id === id && at.field === field;
    if (!view.hasFocus && !here(this.#cursorAt)) return;
    const text = view.hasFocus ? view.state.doc.toString() : null;
    if (here(this.#cursorAt) && this.#cursorAt.text === text) return;
    this.#cursorAt = text == null ? null : { id, field, text };
    this.#actor.send({ type: "_point", source: "cursor", id, field: text == null ? null : field, text });
  }

  // Editors are made when a row is drawn and dropped when it goes; one kept follows its
  // draft text (a change from the fact while nothing waits to save), its marks and Vim.
  // Lit draws the rows by position, so after a move an editor moves to the region now
  // drawn for its row rather than being made again.
  #syncBoxes() {
    const vimOn = this.#actor.snapshot?.context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll(".box[data-key]")].map((r) => [r.dataset.key, r]));
    for (const [key, box] of this.#boxes) {
      const region = regions.get(key);
      if (!region) {
        box.view.destroy();
        this.#boxes.delete(key);
      } else if (region !== box.region || box.view.dom.parentNode !== region) {
        region.replaceChildren(box.view.dom);
        box.region = region;
      }
    }
    for (const [key, region] of regions) {
      const spec = this.#wanted.get(key);
      if (!spec) continue;
      let box = this.#boxes.get(key);
      if (!box) {
        region.replaceChildren();
        box = { region, vimOn, marksKey: spec.marksKey };
        this.#boxes.set(key, box);
        box.view = new EditorView({
          parent: region,
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there, so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: spec.text, extensions: this.#extensions(key, spec, vimOn) }),
        });
        continue;
      }
      box.vimOn = vimOn;
      setVim(box.view, vimOn);
      const effects = [];
      if (box.marksKey !== spec.marksKey) {
        box.marksKey = spec.marksKey;
        effects.push(setMarks.of(spec.marks));
      }
      const doc = box.view.state.doc.toString();
      const changes = doc === spec.text ? undefined : { from: 0, to: doc.length, insert: spec.text };
      if (changes || effects.length) box.view.dispatch({ changes, effects, annotations: changes ? fromDraft.of(true) : undefined });
    }
  }

  disconnectedCallback() {
    for (const box of this.#boxes.values()) box.view.destroy();
    this.#boxes.clear();
    this.#viewport.disconnect();
    super.disconnectedCallback();
  }

  #send(event, focus) {
    this.#focusNext = focus;
    this.#actor.send(event);
    this.requestUpdate();
  }

  // Today's sheet opens with the keyboard in the first name; an earlier day's, which
  // takes no typing, on Close.
  #open() {
    const context = this.#actor.snapshot.context;
    this.#send({ type: "_open" }, writable(context) ? ".box[data-key]" : ".sheet .close");
  }

  // + Your values: the panel joins today's page, open with the keyboard in the first name.
  #place() {
    this.#send({ type: "_place" }, ".box[data-key]");
  }

  #done() {
    this.#send({ type: "_done" }, ".card, .new");
  }

  // A page that nests the sheet hands it the keyboard by its host (journal-entry, with
  // Vim keys): folded, on the card, the + Your values row or the Write your values row;
  // open, on the first box, in Vim's normal mode, or on a button of a sheet only read.
  focus(options) {
    const first = this.renderRoot?.querySelector(".box[data-key]");
    const box = first && this.#boxes.get(first.dataset.key);
    if (box) return box.view.focus();
    const button = this.renderRoot?.querySelector("section > .card, section > .new, .sheet button");
    if (button) button.focus(options);
    else super.focus(options);
  }

  // A new value at the end, or at index `at` (Vim's o and O on a row).
  #add(at) {
    this.#actor.send({ type: "_add", ...(Number.isInteger(at) ? { at } : {}) });
    const drafts = this.#actor.snapshot?.context.drafts ?? [];
    this.#focusNext = `.box[data-key="${(Number.isInteger(at) ? drafts[at] : drafts.at(-1))?.id}:name"]`;
    this.requestUpdate();
  }

  // A row moved one place up or down; `refocus` names the box whose keyboard and cursor
  // it keeps, and `focus` where the keyboard goes otherwise.
  #moveBy(id, by, refocus = null, focus = null) {
    const drafts = this.#actor.snapshot?.context.drafts ?? [];
    const to = drafts.findIndex((d) => d.id === id) + by;
    if (to < 0 || to >= drafts.length) return;
    this.#moving = true;
    const box = refocus && this.#boxes.get(refocus);
    this.#refocus = box ? { key: refocus, selection: box.view.state.selection } : null;
    this.#send({ type: "_move", id, to }, focus);
  }

  #toRow(id) {
    this.renderRoot.querySelector(`.row[data-id="${id}"]`)?.focus();
  }

  // The keys of a row that has the keyboard, with Vim keys on (12, "Vim keys"): moving
  // between rows, back into the value, adding, and cut and paste to put it in another
  // place. `#afterG` and `#afterD` hold a first g or d, waiting for its second.
  #afterG = false;
  #afterD = false;
  #rowKeydown(e, id) {
    if (e.target !== e.currentTarget) return;
    const action = rowKey(e, { afterG: this.#afterG, afterD: this.#afterD });
    this.#afterG = action === "g";
    this.#afterD = action === "d";
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    const context = this.#actor.snapshot.context;
    const rows = [...this.renderRoot.querySelectorAll(".rows > .row[data-id]")];
    const at = rows.findIndex((r) => r.dataset.id === id);
    const index = context.drafts.findIndex((d) => d.id === id);
    const go = { down: at + 1, up: at - 1, first: 0, last: rows.length - 1 }[action];
    if (go !== undefined) return rows[Math.max(0, Math.min(rows.length - 1, go))]?.focus();
    if (action === "edit") {
      const box = this.#boxes.get(`${id}:name`);
      if (box) this.#focusBox(box);
      return;
    }
    if (action === "cut") return this.#send({ type: "_cut", id }, `.row[data-id="${id}"]`);
    if ((action === "below" || action === "above") && context.cut) {
      this.#moving = true;
      return this.#send({ type: "_paste", at: id, below: action === "below" }, `.row[data-id="${context.cut}"]`);
    }
    if (action === "undo") {
      if (context.cut === id) return this.#send({ type: "_uncut" }, `.row[data-id="${id}"]`);
      if (context.removing.includes(id)) return this.#send({ type: "_undo", id }, `.row[data-id="${id}"]`);
      if (context.pasted) {
        this.#moving = true;
        return this.#send({ type: "_unpaste" }, `.row[data-id="${context.pasted.id}"]`);
      }
      return;
    }
    if (action === "add-below" || action === "add-above") return this.#add(index < 0 ? undefined : index + (action === "add-below" ? 1 : 0));
    if (action === "escape") {
      // A cut row is removed, with its Undo and draining bar (12).
      if (context.cut) return this.#send({ type: "_remove", id: context.cut }, `.row[data-id="${context.cut}"]`);
      this.#done();
    }
  }

  // The row itself losing the keyboard leaves it, as its boxes do.
  #rowBlur(e, id) {
    if (this.#moving || e.target !== e.currentTarget) return;
    this.#actor.send({ type: "_blur", id, to: e.relatedTarget?.closest?.(".row")?.dataset.id ?? null });
  }

  #remove(id) {
    this.#send({ type: "_remove", id }, `.row[data-id="${id}"] .undo`);
  }

  #undo(id) {
    this.#send({ type: "_undo", id }, `.box[data-key="${id}:name"]`);
  }

  // Could be under the example of a value with a red mark, or, after Use, Was with Undo.
  #suggest(context, draft) {
    const used = context.used?.id === draft.id ? context.used : null;
    if (used) {
      return html`<p class="suggest was">
        <span>Was ${used.was}</span>
        <button class="revert" type="button" aria-label="Undo: put back ${used.was}" @click=${() => this.#send({ type: "_unuse" }, `.box[data-key="${draft.id}:name"]`)}>
          Undo
        </button>
        <span class="drain"></span>
      </p>`;
    }
    const text = suggestionFor(context, draft);
    if (!text) return nothing;
    return html`<p class="suggest">
      <span>Could be ${text}</span>
      <button class="use" type="button" aria-label="Use ${text}" @click=${() => this.#send({ type: "_use", id: draft.id }, `.row[data-id="${draft.id}"] .revert`)}>
        Use
      </button>
    </p>`;
  }

  #box(context, draft, field) {
    const key = `${draft.id}:${field}`;
    const lines = boxMarks(context, draft.id, field);
    this.#wanted.set(key, {
      id: draft.id,
      field,
      text: draft[field],
      marks: new Map(lines.map((l) => [l.text, l.marks])),
      marksKey: JSON.stringify(lines),
    });
    return html`<div class="box" data-key=${key} data-field=${field}></div>`;
  }

  // The marks of a line only read, after its text; pointing at them or tapping them says
  // their answer in the status line, as in a box.
  #after(context, v, field) {
    const marks = marksFor(context, v, field);
    if (!marks.length) return nothing;
    const point = (source, text) => this.#actor.send({ type: "_point", source, id: v.id, field: text == null ? null : field, text });
    return html`<span
      class="marks after"
      role="img"
      aria-label=${sayMarks(marks)}
      @pointerenter=${(e) => e.pointerType !== "touch" && point("hover", v[field])}
      @pointerleave=${() => point("hover", null)}
      @pointerdown=${() => point("tap", v[field])}
      >${marks.map(markOf)}</span
    >`;
  }

  // A value to read: its name and sentence as text. A row waiting out its undo window
  // keeps the keyboard when it has it (Vim keys: u on it takes the removal back).
  #readRow(context, v, extra = nothing, state = "") {
    const keyed = state === "removing";
    return html`<div
      class="row ${state}"
      data-id=${v.id}
      tabindex=${keyed ? "-1" : nothing}
      @keydown=${keyed ? (e) => this.#rowKeydown(e, v.id) : nothing}
    >
      <div class="fields">
        <p class="name">${v.name || "—"}${this.#after(context, v, "name")}</p>
        ${v.meaning ? html`<p class="meaning">${v.meaning}${this.#after(context, v, "meaning")}</p>` : nothing}
      </div>
      ${extra}
    </div>`;
  }

  #row(context, draft, i) {
    if (context.removing.includes(draft.id)) {
      return this.#readRow(
        context,
        draft,
        html`<button class="undo" type="button" @click=${() => this.#undo(draft.id)}>Undo</button><span class="drain"></span>`,
        "removing",
      );
    }
    const name = draft.name.trim() || "this value";
    const last = context.drafts.length - 1;
    const move = (by, dir) => {
      const sel = `.row[data-id="${draft.id}"]`;
      this.#moveBy(draft.id, by, null, `${sel} .${dir}:not(:disabled), ${sel} .order button:not(:disabled)`);
    };
    const cut = context.cut === draft.id;
    return html`<div
      class="row ${cut ? "cut" : ""}"
      data-id=${draft.id}
      tabindex=${context.vimKeys ? "-1" : nothing}
      @keydown=${(e) => this.#rowKeydown(e, draft.id)}
      @blur=${(e) => this.#rowBlur(e, draft.id)}
    >
      <div class="fields">${this.#box(context, draft, "name")} ${this.#box(context, draft, "meaning")} ${this.#suggest(context, draft)}</div>
      <div class="tools">
        ${cut ? html`<span class="cut-mark">Cut</span>` : nothing}
        <!-- A press does not take the keyboard first, so it goes with the row moved. -->
        <span class="order" @mousedown=${(e) => e.preventDefault()}>
          <button class="up" type="button" ?disabled=${i === 0} aria-label="Move ${name} up" title="Move up" @click=${() => move(-1, "up")}>
            ${icon("arrow-up")}
          </button>
          <button class="down" type="button" ?disabled=${i === last} aria-label="Move ${name} down" title="Move down" @click=${() => move(1, "down")}>
            ${icon("arrow-down")}
          </button>
        </span>
        <button class="remove" type="button" aria-label="Remove ${name}" title="Remove" @click=${() => this.#remove(draft.id)}>${icon("x")}</button>
      </div>
    </div>`;
  }

  #foot(context, { about = nothing, back = false, remove = false } = {}) {
    const read = !writable(context);
    const status = statusOf(context);
    return html`<div class="foot">
      <span class="status ${status ? "" : "none"}" role="status">${status || "\u200b"}</span>
      <div class="about">${about}</div>
      <div class="buttons">
        ${back ? html`<button type="button" class="back" @click=${() => this.#send({ type: "_back" }, ".sheet .close, .sheet .done")}>Back</button>` : nothing}
        ${remove ? html`<button type="button" class="unplace" @click=${() => this.#send({ type: "_unplace" }, ".new")}>Remove from this day</button>` : nothing}
        <button type="button" class=${read ? "close" : "done"} @click=${() => this.#done()}>${read ? "Close" : "Done"}</button>
      </div>
    </div>`;
  }

  #sheet(context) {
    const today = dateOf(context.now());
    // Escape on a button or a read value folds the sheet like Done; the boxes decide
    // their own Escape, for Vim (#keys). The key is taken so nothing around acts too.
    const keydown = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      this.#done();
    };
    // A tapped mark keeps its answer in the status line until something else is pressed.
    const pointerdown = (e) => {
      if (!context.pointed.tap || e.composedPath().some((n) => n.classList?.contains("marks"))) return;
      this.#actor.send({ type: "_point", source: "tap", field: null });
    };
    let body;
    if (context.viewing) {
      const { kind, day, values } = context.viewing;
      body = html`<p class="caption">${kind === "current" ? "Today's values" : `Your values on ${dayName(day, today)}`}</p>
        <div class="rows">${values.length ? values.map((v) => this.#readRow(context, v)) : html`<p class="empty">No values.</p>`}</div>
        ${this.#foot(context, { back: true })}`;
    } else if (context.browsing) {
      body = html`<p class="caption">Earlier versions</p>
        <div class="versions">
          ${earlierDays(context).map(
            (d) => html`<button type="button" class="version" @click=${() => this.#send({ type: "_see", day: d }, ".sheet .back")}>${dayName(d, today)}</button>`,
          )}
        </div>
        ${this.#foot(context, { back: true })}`;
    } else {
      const write = writable(context);
      const earlier = earlierDays(context).length;
      const about = html`${changedLine(context) ? html`<span class="when">${changedLine(context)}</span>` : nothing}
      ${earlier ? html`<button type="button" class="link earlier" @click=${() => this.#send({ type: "_browse" }, ".sheet .version")}>Earlier versions (${earlier})</button>` : nothing}
      ${!write && context.version?.changedSince
        ? html`<button type="button" class="link since" @click=${() => this.#send({ type: "_see" }, ".sheet .back")}>Changed since · see today's</button>`
        : nothing}`;
      body = html`<div class="rows">
          ${write ? context.drafts.map((d, i) => this.#row(context, d, i)) : context.drafts.map((v) => this.#readRow(context, v))}
        </div>
        ${write
          ? html`<button type="button" class="new" @click=${() => this.#add()}><span class="plus">${icon("plus")}</span>New value</button>`
          : nothing}
        ${this.#foot(context, { about, remove: placeable(context) })}`;
    }
    return html`<div class="sheet ${writable(context) ? "" : "read"}" role="group" aria-label="Your values" @keydown=${keydown} @pointerdown=${pointerdown}>${body}</div>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    this.#wanted.clear();
    if (snapshot.matches("loading")) return nothing;
    const failed = snapshot.matches("failed");
    // A day the panel was not added to shows nothing, and today's page the row that adds it.
    if (!failed && !isPlaced(context)) {
      if (!placeable(context)) return nothing;
      return html`<section tabindex="-1" class="unplaced">
        <button type="button" class="new" @click=${() => this.#place()}><span class="plus">${icon("plus")}</span>Your values</button>
      </section>`;
    }
    const shown = shownValues(context);
    const names = shown.map((v) => v.name.trim() || "A value");
    // An earlier day without values has nothing to show.
    if (!failed && !context.open && !names.length && !writable(context)) return nothing;
    let body;
    if (failed) body = html`<p class="empty">Your values are unavailable.</p>`;
    else if (context.open) body = this.#sheet(context);
    else if (names.length) {
      // A value whose value or example line has a red mark has a red warning beside it.
      const flag = (v) =>
        warned(context, v) ? html`<span class="flag" role="img" aria-label="Not the answer you expect">${icon("warning")}</span>` : nothing;
      body = html`<button type="button" class="card" @click=${() => this.#open()}>
        ${shown.map((v, i) => html`${i ? " · " : ""}<span class="value">${names[i]}</span>${flag(v)}`)}
      </button>`;
    }
    else body = html`<button type="button" class="new" @click=${() => this.#open()}><span class="plus">${icon("plus")}</span>Write your values</button>`;
    // Folded, a press anywhere on the section opens the sheet, as a press on its card does.
    const folded = !failed && !context.open;
    const open = (e) => {
      if (folded && !e.composedPath().some((n) => n.localName === "button")) this.#open();
    };
    return html`<section tabindex="-1" class=${folded ? "folded" : ""} aria-labelledby="heading" @click=${open}>
      <h3 id="heading">Your values</h3>
      ${body}
    </section>`;
  }
}

customElements.define("values-sheet", ValuesSheet);
