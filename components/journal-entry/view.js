import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment, MapMode } from "@codemirror/state";
import { EditorView, Decoration, placeholder } from "@codemirror/view";
import { Vim } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, shown, selectedOf, conflictOn, longDate, parseBody, serialize } from "./machine.js";
import saved from "./events/day.saved.json" with { type: "json" };
import dayShown from "./events/day.shown.json" with { type: "json" };

// The entry's view: one CodeMirror 6 document holds the day's text, so it is shown once.
// The theme, Vim and the paragraphs come from the editor kit (architecture.md 10). The
// four line levels are copied from note-editor, because components never import each
// other (11.2): a StateField holds each line's level, the document stays marker-free,
// and parseBody/serialize (machine.js) turn it into the wire text.

// Only Title/Heading/Subheading lines get a line decoration; a Body line carries none.
const LEVEL_CLASS = { title: "cm-level-title", heading: "cm-level-heading", subheading: "cm-level-subheading" };
const lineDeco = (level) => Decoration.line({ class: LEVEL_CLASS[level], attributes: { "data-level": level } });

// setLevel re-levels every line the selection spans; setAllLevels rebuilds the whole set
// from a per-line array (a load).
const setLevel = StateEffect.define();
const setAllLevels = StateEffect.define();

const levelField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    if (tr.docChanged) deco = follow(deco, tr);
    for (const e of tr.effects) {
      if (e.is(setAllLevels)) {
        const b = new RangeSetBuilder();
        e.value.forEach((level, i) => {
          if (level && level !== "body" && i < tr.state.doc.lines) {
            const line = tr.state.doc.line(i + 1);
            b.add(line.from, line.from, lineDeco(level));
          }
        });
        deco = b.finish();
      } else if (e.is(setLevel)) {
        const first = tr.state.doc.lineAt(tr.state.selection.main.from);
        const last = tr.state.doc.lineAt(tr.state.selection.main.to);
        const add = [];
        for (let n = first.number; n <= last.number; n++) {
          if (e.value !== "body") add.push(lineDeco(e.value).range(tr.state.doc.line(n).from));
        }
        deco = deco.update({ filterFrom: first.from, filterTo: last.to, filter: () => false, add });
      }
    }
    return tr.docChanged || tr.selection || tr.effects.length ? bodyGaps(deco, tr.state) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// A level rides with its line's text. Mapped alone, a line decoration stays put when
// text is inserted at its line's start, so Enter before a Title would leave the level
// on the blank line and the Title text bare; a level whose line had text and is now
// blank moves to the line its text went to.
function follow(deco, tr) {
  const moved = [];
  for (const it = deco.iter(); it.value; it.next()) {
    if (tr.startState.doc.lineAt(it.from).length === 0) continue;
    const stays = tr.changes.mapPos(it.from, -1, MapMode.TrackBefore);
    if (stays === null || tr.state.doc.lineAt(stays).length > 0) continue;
    const to = tr.state.doc.lineAt(tr.changes.mapPos(it.from, 1));
    if (to.length > 0) moved.push({ from: stays, to: to.from, value: it.value });
  }
  deco = deco.map(tr.changes);
  if (moved.length === 0) return deco;
  const drop = new Set(moved.flatMap((m) => [m.from, m.to]));
  return deco.update({ filter: (from) => !drop.has(from), add: moved.map((m) => m.value.range(m.to)), sort: true });
}

// A gap is always Body (architecture.md 10): a blank line keeps a level only while the
// cursor is on it, so a level can be chosen before typing, and serialize never writes a
// marker on a blank line.
function bodyGaps(deco, state) {
  const cursor = state.doc.lineAt(state.selection.main.head).number;
  return deco.update({
    filter: (from) => {
      const line = state.doc.lineAt(from);
      return line.length > 0 || line.number === cursor;
    },
  });
}

// The line levels of a state, in document order, for serialize().
function levelsOf(state) {
  const levels = new Array(state.doc.lines).fill("body");
  for (const it = state.field(levelField).iter(); it.value; it.next()) {
    const level = it.value.spec?.attributes?.["data-level"];
    if (level) levels[state.doc.lineAt(it.from).number - 1] = level;
  }
  return levels;
}

// A list item is a Body line (architecture.md 10): a line with another level is never
// one, and giving an item a level drops its bullet, in the same step.
const leveled = (state, line) => {
  let found = false;
  state.field(levelField).between(line.from, line.from, (from) => {
    if (from === line.from) found = true;
  });
  return found;
};
const toLevel = (state, level) => {
  const changes = [];
  if (level !== "body") {
    const first = state.doc.lineAt(state.selection.main.from).number;
    const last = state.doc.lineAt(state.selection.main.to).number;
    for (let n = first; n <= last; n++) {
      const line = state.doc.line(n);
      const bullet = /^ *[-*] /.exec(line.text);
      if (bullet) changes.push({ from: line.from, to: line.from + bullet[0].length });
    }
  }
  return { changes, effects: setLevel.of(level) };
};

// Vim's maps are one per page, so the level keys have one meaning for every editor on
// it: the action sends a "level" event to the focused editor's own element, and each
// editor applies it to its own levels. note-editor registers the identical action and
// maps; registering again replaces the action with the same one.
Vim.defineAction("setLineLevel", (cm, args) => {
  cm.cm6?.contentDOM.dispatchEvent(new CustomEvent("level", { detail: args.level }));
});
for (const [key, level] of [["\\1", "title"], ["\\2", "heading"], ["\\3", "subheading"], ["\\0", "body"]]) {
  Vim.mapCommand(key, "action", "setLineLevel", { level }, { context: "normal" });
}

// The level ladder of note-editor's levelTheme: padding, never margin, because CodeMirror
// measures a line's box for its height map and Vim's j/k move by pixels through it.
const levelTheme = EditorView.theme({
  ".cm-line.cm-level-title": {
    fontSize: "var(--text-heading)",
    fontWeight: "var(--weight-semibold)",
    lineHeight: "var(--leading-tight)",
    paddingBottom: "var(--space-xs)",
  },
  ".cm-line.cm-level-heading": {
    fontSize: "var(--text-subtitle)",
    fontWeight: "var(--weight-semibold)",
    lineHeight: "var(--leading-tight)",
    paddingTop: "var(--space-sm)",
  },
  ".cm-line.cm-level-subheading": {
    fontSize: "var(--text-body)",
    fontWeight: "var(--weight-semibold)",
    lineHeight: "var(--leading-tight)",
    paddingTop: "var(--space-xs)",
  },
});

// What the editable compartment holds: the open day takes typing, an earlier day (or a
// day in conflict) is read only and offers no placeholder.
const editability = (on) => [
  EditorState.readOnly.of(!on),
  EditorView.editable.of(on),
  EditorView.contentAttributes.of({ "aria-label": on ? "Today's entry" : "The entry" }),
  on ? placeholder("What is on your mind? Enter starts a new paragraph; Shift+Enter breaks the line.") : [],
];

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, now: () => Date.now() },
      events: { "day.saved": saved, "day.shown": dayShown },
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

class JournalEntry extends LitElement {
  static properties = {
    height: { type: String, reflect: true },
  };

  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // in the writing box.
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
    /* The stage's width, which the text and the level bar below it both answer to. */
    .frame {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      container-type: inline-size;
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .page {
      flex: 1 0 auto;
      box-sizing: border-box;
      padding: var(--space-md) var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    header {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    h2 {
      margin: 0;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .region {
      min-width: 0;
      line-height: var(--leading-normal);
    }
    /* The open day reads like note-editor: no box and no ring; the desk's frame shows
       where the keyboard is. */
    .region.open {
      box-sizing: border-box;
      border: var(--border-width) solid transparent;
    }
    /* Room for a few lines before anything is written, so the box reads as a place to type. */
    .region.open .cm-content {
      min-height: calc(var(--text-body) * var(--leading-normal) * 5);
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
    button:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: default;
      color: var(--color-mute);
    }
    /* Both copies of a day saved on two devices, side by side, each with the button that
       keeps it. */
    .conflict {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-warning);
      border-radius: var(--radius-md);
      background: var(--color-warning-subtle);
    }
    .conflict p {
      margin: 0;
      color: var(--color-ink);
      font-size: var(--text-sm);
    }
    .copies {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-sm);
    }
    .copy {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      min-width: 0;
    }
    .copy h3 {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
    }
    .copy pre {
      margin: 0;
      flex: 1;
      padding: var(--space-sm);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      color: var(--color-ink);
      font: inherit;
      font-size: var(--text-sm);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .copy button {
      align-self: flex-start;
    }
    /* On a stage that fills, the open day reaches the bottom, like a page, and a
       click anywhere in it lands in the text. A page that nests a view under the text
       keeps the text its own height instead, so the nested view sits right under it. */
    :host([height="fill"]) .page:not(.holds) .region.open {
      flex: 1 0 auto;
      display: flex;
      flex-direction: column;
    }
    :host([height="fill"]) .page:not(.holds) .region.open .cm-editor {
      flex: 1;
    }
    /* The level bar under the text, as in note-editor. */
    .footer {
      flex: none;
      padding: var(--space-sm) var(--space-lg);
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .levels {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    button.level {
      white-space: nowrap;
      margin: 0;
      padding: 0 var(--space-2xs);
      /* A faint outline marks each name as a control where no hover can (a phone). */
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-mute);
    }
    button.level:hover:not([aria-pressed="true"]):not(:disabled) {
      background: transparent;
      color: var(--color-ink);
    }
    button.level[aria-pressed="true"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    /* Feedback that a level change landed, however it was made (a click or a Vim key). */
    button.level.flash {
      animation: level-flash var(--duration-slide) var(--ease);
    }
    @keyframes level-flash {
      from {
        background: var(--color-accent-subtle);
      }
      to {
        background: transparent;
      }
    }
    /* Without motion the tint holds still for the same time, then goes; the animation
       still runs so animationend clears the flash. */
    @media (prefers-reduced-motion: reduce) {
      button.level.flash {
        animation-timing-function: step-end;
      }
    }
    kbd {
      font: inherit;
      color: var(--color-body);
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* A narrow stage: a phone, or a desk with both docks open on a small window. */
    @container (width < 30rem) {
      .page {
        padding: var(--space-md);
      }
      .footer {
        padding-inline: var(--space-md);
      }
      .copies {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `;

  #actor = new ActorController(this);
  #view = null;
  // Whether a view is nested under the text (the slot holds an element).
  #holds = false;
  #slotted = (e) => {
    const holds = e.target.assignedElements().length > 0;
    if (holds === this.#holds) return;
    this.#holds = holds;
    this.requestUpdate();
  };
  // The text last written into or read out of the editor, so an echo of the user's own
  // typing never rewrites the document and moves the caret.
  #shown = "";
  #editable = new Compartment();
  #editableOn = false;
  // The level of the line the cursor is on, marked in the level bar, and the level a
  // transaction just set, whose button flashes until animationend.
  #level = "body";
  #flashed = null;

  #send(event) {
    this.#actor.send(event);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#view?.destroy();
    this.#view = null;
  }

  // dock-desk's Ctrl+h/j/k/l and list-then-item focus a panel by its host: land in the
  // text when it can be typed in.
  focus(options) {
    if (this.#view && this.#editableOn) this.#view.focus();
    else super.focus(options);
  }

  #extensions(editable, vimOn) {
    return [
      ...baseExtensions({ vim: vimOn }),
      paragraphs({ notList: leveled }),
      this.#editable.of(editability(editable)),
      levelField,
      levelTheme,
      EditorView.updateListener.of((update) => {
        const leveled = update.transactions.some((t) => t.effects.some((e) => e.is(setLevel) || e.is(setAllLevels)));
        for (const t of update.transactions) {
          for (const e of t.effects) {
            if (!e.is(setLevel)) continue;
            this.#flashed = e.value;
            this.requestUpdate();
          }
        }
        if (update.selectionSet || update.docChanged || leveled) this.#syncLevel(update.state);
        if (update.docChanged || leveled) {
          const text = serialize(update.state.doc.toString(), levelsOf(update.state));
          if (text !== this.#shown) {
            this.#shown = text;
            this.#send({ type: "_edit", text });
          }
        }
      }),
      EditorView.domEventHandlers({
        blur: () => {
          this.#send({ type: "_blur" });
        },
        // The page-wide Vim level keys arrive here as a "level" event (setLineLevel); an
        // earlier day takes no level, as it takes no typing.
        level: (e, view) => {
          if (this.#editableOn) view.dispatch(toLevel(view.state, e.detail));
          return true;
        },
      }),
    ];
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    const region = this.renderRoot.querySelector(".region");
    if (!snapshot || !region) return;
    const { text, editable } = this.#content;
    const { vimKeys } = snapshot.context;
    if (!this.#view || this.#view.dom.parentNode !== region) {
      this.#view?.destroy();
      this.#shown = text;
      this.#editableOn = editable;
      const { doc, levels } = parseBody(text);
      this.#view = new EditorView({
        parent: region,
        // Shadow DOM: CodeMirror reads the selection through the root and mounts its
        // stylesheet there (7.5), so it must know the shadow root.
        root: this.renderRoot,
        state: EditorState.create({ doc, extensions: this.#extensions(editable, vimKeys) }),
      });
      this.#view.dispatch({ effects: setAllLevels.of(levels) });
      this.#syncLevel(this.#view.state);
    }
    setVim(this.#view, vimKeys);
    const effects = [];
    if (editable !== this.#editableOn) {
      this.#editableOn = editable;
      effects.push(this.#editable.reconfigure(editability(editable)));
    }
    let changes;
    if (text !== serialize(this.#view.state.doc.toString(), levelsOf(this.#view.state))) {
      const { doc, levels } = parseBody(text);
      changes = { from: 0, to: this.#view.state.doc.length, insert: doc };
      effects.push(setAllLevels.of(levels));
    }
    this.#shown = text;
    if (changes || effects.length) this.#view.dispatch({ changes, effects });
  }

  // What the editor shows: the text being typed on the open day, else the day's text;
  // typing only on the open day and not while two copies wait to be settled.
  get #content() {
    const { context } = this.#actor.snapshot;
    const { day, editable } = shown(context.picture, selectedOf(context), context.fresh, Date.now());
    const conflict = conflictOn(context.conflict, day, editable);
    return { text: editable && context.draft ? context.draft.text : day.text, editable: editable && !conflict };
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty page">The journal is unavailable.</p>`;
    const { context } = snapshot;
    const { picture, fresh, vimKeys } = context;
    // The actor's midnight announcement (shownDay) is what redraws a new page then.
    const { day, editable } = shown(picture, selectedOf(context), fresh, Date.now());
    const conflict = conflictOn(context.conflict, day, editable);
    // The slot under the text takes the view a page nests in the entry, as chat-thread
    // holds chat-input; it sits in the page so it scrolls with the day it is about.
    return html`
      <div class="frame">
        <div class="scroll">
          <div class="page ${this.#holds ? "holds" : ""}">
            <header>
              <h2>${longDate(day.day)}</h2>
            </header>
            ${conflict ? this.#conflict(conflict) : nothing}
            <div class="region ${editable && !conflict ? "open" : ""}"></div>
            <slot @slotchange=${this.#slotted}></slot>
          </div>
        </div>
        ${editable && !conflict ? html`<div class="footer">${this.#levelBar(vimKeys)}</div>` : nothing}
      </div>
    `;
  }

  // The cursor line's level, so the level bar marks where the cursor is.
  #syncLevel(state) {
    const line = state.doc.lineAt(state.selection.main.head).number;
    const level = levelsOf(state)[line - 1] ?? "body";
    if (level === this.#level) return;
    this.#level = level;
    this.requestUpdate();
  }

  // note-editor's level bar: the level names are buttons, so a level can be set without
  // Vim and on a phone; the cursor's own level is marked, and the Vim key stays beside
  // each name while Vim is on, so a hidden map is visible.
  #levelBar(vimKeys) {
    const keys = [
      ["\\1", "title", "Title"],
      ["\\2", "heading", "Heading"],
      ["\\3", "subheading", "Subheading"],
      ["\\0", "body", "Body"],
    ];
    return html`<span class="levels" role="group" aria-label="Line level">
      ${keys.map(
        ([key, level, label]) =>
          html`<button
            type="button"
            class=${level === this.#flashed ? "level flash" : "level"}
            data-level=${level}
            aria-pressed=${level === this.#level}
            @mousedown=${(e) => e.preventDefault()}
            @click=${() => this.#setLevel(level)}
            @animationend=${this.#unflash}
          >
            ${vimKeys ? html`<kbd>${key}</kbd> ` : nothing}${label}
          </button>`,
      )}
    </span>`;
  }

  // The same effect the Vim key sends, so a click re-levels every line the selection
  // spans; the keyboard goes back to the text so typing continues.
  #setLevel(level) {
    if (!this.#view || !this.#editableOn) return;
    this.#view.dispatch(toLevel(this.#view.state, level));
    this.#view.focus();
  }

  #unflash = () => {
    this.#flashed = null;
    this.requestUpdate();
  };

  // Both copies, each kept in one step. A closed day can no longer be saved, so only the
  // other copy can stay, and the user's own is shown to copy from.
  #conflict(c) {
    return html`
      <section class="conflict" aria-label="Two copies of this entry">
        <p>
          ${c.keepable
            ? "This entry was also changed on another device. Keep one copy."
            : "This entry was also changed on another device, and it has closed, so the other copy is kept. Yours is here to copy from."}
        </p>
        <div class="copies">
          <div class="copy mine">
            <h3>Yours</h3>
            <pre>${c.mine}</pre>
            ${c.keepable ? html`<button type="button" class="keep-mine" @click=${() => this.#send({ type: "_keepMine" })}>Keep this copy</button>` : nothing}
          </div>
          <div class="copy theirs">
            <h3>The other device's</h3>
            <pre>${c.theirs}</pre>
            <button type="button" class="keep-theirs" @click=${() => this.#send({ type: "_keepTheirs" })}>
              ${c.keepable ? "Keep this copy" : "Done"}
            </button>
          </div>
        </div>
      </section>
    `;
  }
}

customElements.define("journal-entry", JournalEntry);
