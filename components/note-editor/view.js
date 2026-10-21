import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, EditorSelection, Transaction, StateField, StateEffect, RangeSetBuilder, Compartment, MapMode, Prec } from "@codemirror/state";
import { EditorView, Decoration, WidgetType } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, parseBody, serialize, aboutTitleOf, sourceLinksIn, isStaged, showing } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import opened from "./events/note.opened.json" with { type: "json" };
import pinToggled from "./events/pin.toggled.json" with { type: "json" };
import passageSelected from "./events/passage.selected.json" with { type: "json" };
import staged from "./events/note.staged.json" with { type: "json" };
import closed from "./events/note.closed.json" with { type: "json" };
import load from "./commands/load.json" with { type: "json" };
import focus from "./commands/focus.json" with { type: "json" };

// The note editor's view: a CodeMirror 6 document. The fact stays one plain markdown
// string; the document the user edits is marker-free, and per-line level lives in a
// StateField, so Vim motions never step over an invisible "#". parseBody/serialize
// (machine.js) are the only bridge between the two forms; this file adds the CM6
// half: the level field, the level ladder and the level bar. The theme, Vim and the
// paragraphs come from the editor kit (architecture.md 10).

// The note this editor pinned under its own key (3.1) before `pins` owned the pin: read
// once at start so a device keeps its pin, handed to `pins` by the machine, then
// cleared. Wrapped like settings/store.js so a browser refusing storage reads null.
const KEY = "note-editor.pinned";
const legacyPin = {
  recall() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  forget() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Nothing stored to clear.
    }
  },
};

// The titles of subjects this browser has seen (12), kept beside the pin under a key
// beginning with its name (3.1). "kind:id" -> title. Wrapped like legacyPin: a browser refusing storage, or a malformed
// value, reads an empty table and drops the write.
const TITLES_KEY = "note-editor.titles";
const titleStore = {
  recall() {
    try {
      return JSON.parse(localStorage.getItem(TITLES_KEY)) ?? {};
    } catch {
      return {};
    }
  },
  remember(titles) {
    try {
      localStorage.setItem(TITLES_KEY, JSON.stringify(titles));
    } catch {
      // No persistence available; the titles live only for this page.
    }
  },
};

// Body carries no decoration, so a new line defaults to Body for free (§2 of the
// note-editor plan). Only Title/Heading/Subheading lines get a line decoration.
const LEVEL_CLASS = { title: "cm-level-title", heading: "cm-level-heading", subheading: "cm-level-subheading" };
const lineDeco = (level) => Decoration.line({ class: LEVEL_CLASS[level], attributes: { "data-level": level } });

// setLevel re-levels every line the selection spans; setAllLevels rebuilds the whole
// set from a per-line array (a load). The value of a line's data-level attribute is
// what serialize reads back, so no class-name parsing.
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
          if (level && level !== "body") {
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

// Vim normal-mode level maps, registered at import. The leader is "\" (Vim's
// default), mapped literally — more reliably honoured than the <leader> token.
// defineAction (not Vim.map, which is key->key only) lets a mapped key reach the live
// EditorView through cm.cm6. The Vim plugin keeps one map for the whole page, so the
// keys have one meaning for every editor on it: the action sends a "level" event to the
// focused editor's own element, and each editor applies it to its own levels.
// journal-entry registers the identical action and maps; registering again replaces
// the action with the same one.
Vim.defineAction("setLineLevel", (cm, args) => {
  cm.cm6?.contentDOM.dispatchEvent(new CustomEvent("level", { detail: args.level }));
});
for (const [key, level] of [["\\1", "title"], ["\\2", "heading"], ["\\3", "subheading"], ["\\0", "body"]]) {
  Vim.mapCommand(key, "action", "setLineLevel", { level }, { context: "normal" });
}

// `:tab split` (or `:tab sp`) shows the note on the stage. Ex commands are one set for the
// page, like the level maps, so it reaches the focused editor's own element as a
// "tabsplit" event, and an editor that does not listen ignores it.
Vim.defineEx("tab", "tab", (cm, params) => {
  if (["split", "sp"].includes(params.args?.[0])) cm.cm6?.contentDOM.dispatchEvent(new CustomEvent("tabsplit"));
});

// --- Source links ------------------------------------------------------------------
// A source link, `[label](note:<id>)`, stays raw in the document, so serialize and the
// stored form are untouched; it is drawn as one tag and kept atomic the way the editor
// kit keeps a list item's marker (overMarkers): the cursor never rests inside it, and a
// deletion that reaches into it takes it whole (architecture.md 10).

// The links whose highlight is gone, from the machine (its UI state), drawn struck through.
const setRemoved = StateEffect.define();

class LinkTag extends WidgetType {
  constructor(label, id, removed) {
    super();
    this.label = label;
    this.id = id;
    this.removed = removed;
  }
  eq(other) {
    return other.label === this.label && other.id === this.id && other.removed === this.removed;
  }
  toDOM(view) {
    const tag = document.createElement("span");
    tag.className = this.removed ? "cm-source-link removed" : "cm-source-link";
    tag.title = this.removed ? "This highlight was removed" : "Open the passage";
    render(html`${icon("link")}<span class="cm-source-label">${this.label}</span>`, tag);
    // The click reaches the editor's element, where the element knows its actor.
    tag.addEventListener("click", () => view.contentDOM.dispatchEvent(new CustomEvent("follow", { detail: this.id })));
    return tag;
  }
}

const linkDecos = (state, removed) =>
  Decoration.set(
    sourceLinksIn(state.doc.toString()).map((l) =>
      Decoration.replace({ widget: new LinkTag(l.label, l.id, removed.includes(l.id)) }).range(l.from, l.to),
    ),
  );

const linkField = StateField.define({
  create: (state) => ({ removed: [], deco: linkDecos(state, []) }),
  update(value, tr) {
    let { removed } = value;
    for (const e of tr.effects) if (e.is(setRemoved)) removed = e.value;
    if (!tr.docChanged && removed === value.removed) return value;
    return { removed, deco: linkDecos(tr.state, removed) };
  },
  provide: (f) => [EditorView.decorations.from(f, (v) => v.deco), EditorView.atomicRanges.of((view) => view.state.field(f).deco)],
});

const linksIn = (state) => sourceLinksIn(state.doc.toString());

// Vim moves the cursor by its own reckoning, past CodeMirror's atomic ranges, so a bare
// cursor that lands inside a tag is put at the edge it was heading for.
const overLinks = EditorState.transactionFilter.of((tr) => {
  if (tr.docChanged || !tr.selection || tr.selection.ranges.length !== 1 || !tr.selection.main.empty) return tr;
  const head = tr.selection.main.head;
  const link = linksIn(tr.startState).find((l) => l.from < head && head < l.to);
  if (!link) return tr;
  const to = head > tr.startState.selection.main.head ? link.to : link.from;
  return [tr, { selection: EditorSelection.cursor(to), sequential: true }];
});

// A deletion that reaches into a tag, Backspace after it or x on it, takes the whole tag,
// and text put inside one goes after it.
const wholeLinks = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged) return tr;
  const found = linksIn(tr.startState);
  if (found.length === 0) return tr;
  const changes = [];
  let grown = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    let from = fromA;
    let to = toA;
    // Text put inside a tag, as Vim's p does on the tag (it pastes after the character
    // under the cursor), goes after the whole tag.
    const inside = to === from && found.find((l) => l.from < from && from < l.to);
    if (inside) {
      from = to = inside.to;
      grown = true;
    }
    if (to > from) {
      for (const l of found) {
        if (l.from < to && l.to > from && (l.from < from || l.to > to)) {
          from = Math.min(from, l.from);
          to = Math.max(to, l.to);
          grown = true;
        }
      }
    }
    changes.push({ from, to, insert: inserted });
  });
  if (!grown) return tr;
  const last = changes[changes.length - 1];
  return {
    changes,
    selection: EditorSelection.cursor(last.from + last.insert.length),
    effects: tr.effects,
    userEvent: tr.annotation(Transaction.userEvent),
    scrollIntoView: tr.scrollIntoView,
  };
});

// Enter on a tag in Vim's normal mode follows it, before Vim moves the cursor down.
const enterFollows = Prec.highest(
  EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
      const vim = getCM(view)?.state.vim;
      if (!vim || vim.insertMode || vim.visualMode) return false;
      const head = view.state.selection.main.head;
      const link = linksIn(view.state).find((l) => l.from <= head && head < l.to);
      if (!link) return false;
      event.preventDefault();
      view.contentDOM.dispatchEvent(new CustomEvent("follow", { detail: link.id }));
      return true;
    },
  }),
);

const linkTheme = EditorView.theme({
  ".cm-source-link": {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2xs)",
    padding: "0 var(--space-2xs)",
    borderRadius: "var(--radius-sm)",
    background: "var(--color-accent-subtle)",
    color: "var(--color-accent)",
    cursor: "pointer",
  },
  ".cm-source-link.removed": {
    background: "none",
    color: "var(--color-mute)",
    textDecoration: "line-through",
  },
});

// The kit's theme is the base; the note fills its region and scrolls inside it.
const levelTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { overflow: "auto" },
  // A modest Notes.app-style ladder: Title/Heading step down through the shared
  // heading tokens, and Subheading is body-sized, set apart by weight alone (7.4:
  // the type scale has no size between body and subtitle, so weight carries it).
  // The spacing is padding, never margin: CM6 measures a line's box for its height
  // map and Vim's j/k move by pixels through it, so a margin desyncs the map and
  // makes a motion overshoot a level line.
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

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // 4.1: a page may hold this editor twice (the Notes panel and the stage), so each
    // mounts and asks under its own id.
    const instance = this.host.id || undefined;
    this.actor = mount(machine, {
      instance,
      commands: { load, focus },
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload, instance),
        mint: ulid,
        focus: () => this.host.focusEditor?.(),
        // The attributes are parsed by the time hostConnected runs, so the actor is
        // born knowing whether it follows the selection (6.4) and the stage (D5).
        follows: this.host.follows,
        subjecting: this.host.subject,
        staged: this.host.stage,
        recall: legacyPin.recall,
        forget: legacyPin.forget,
        recallTitles: titleStore.recall,
        rememberTitles: titleStore.remember,
        // Vim's registers are one per page, so the link lands where any editor's p reads.
        pushRegister: (text) => Vim.getRegisterController().pushText(null, "yank", text, false, false),
        // A try page (8) shows the editor signed out.
        tryPage: location.pathname.startsWith("/try/"),
      },
      events: { "note.saved": saved, "note.opened": opened, "pin.toggled": pinToggled, "passage.selected": passageSelected, "note.staged": staged, "note.closed": closed },
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

// The body's least height, in lines: a factor on the type tokens, not a length (7.4).
const MIN_LINES = 8;

class NoteEditor extends LitElement {
  static properties = {
    height: { type: String, reflect: true },
    follows: { type: Boolean, reflect: true },
    // Whether this editor follows the stage and offers the pin (D5). Reflected so the
    // page's bare `subject` reads as true and the manifest attribute is visible. Off is
    // exactly today's behaviour.
    subject: { type: Boolean, reflect: true },
    // The editor the stage shows for a note tab: it opens only what `load` names.
    stage: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    .empty {
      margin: 0;
      padding: var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .editor {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      gap: var(--space-sm);
      padding: var(--space-md);
      box-sizing: border-box;
    }
    /* The header (only while following the stage): what the note is about on the left,
       the pin on the right. It keeps its height with an empty About line so the editor
       below does not jump as the About line comes and goes. */
    .header {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      min-height: var(--space-lg);
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
    /* The pin: a toggle, muted while following, accent when pinned (D7). One icon,
       sized by the caption type. */
    .pin,
    .open {
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
    .pin svg,
    .open svg {
      display: block;
    }
    /* The arrow points towards the stage: up-left from a dock right of the middle. */
    .open.mirrored svg {
      transform: scaleX(-1);
    }
    .pin:hover:not(:disabled):not([aria-pressed="true"]),
    .open:hover:not(:disabled):not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    .pin[aria-pressed="true"],
    .open[aria-pressed="true"] {
      color: var(--color-accent);
    }
    .pin:disabled,
    .open:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .pin:focus-visible,
    .open:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* CM6 owns everything inside .region; it grows with content, capped at the
       container so the status stays in view and the page does not scroll. */
    .region {
      color: var(--color-ink);
      width: 100%;
      box-sizing: border-box;
      flex: 0 1 auto;
      min-height: calc(var(--text-body) * var(--leading-normal) * ${MIN_LINES});
      overflow: hidden;
      line-height: var(--leading-normal);
    }
    :host([height="fill"]) .region {
      flex: 1;
      min-height: 0;
    }
    .footer {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-sm) var(--space-md);
      /* Match the sliver .cm-content adds so the status aligns with the text. */
      padding-inline: var(--space-2xs);
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    /* The status keeps the width of its widest usual word, so "Saved" turning into
       "Unsaved" never changes where the footer wraps and the row never jumps. The
       words stack in one grid cell; the hidden ones only give it their width. */
    .status {
      margin: 0;
      display: inline-grid;
    }
    .status > span {
      grid-area: 1 / 1;
    }
    .status > .sizer {
      visibility: hidden;
    }
    .levels {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .level {
      white-space: nowrap;
    }
    button.level[aria-pressed="true"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    button.level {
      appearance: none;
      font: inherit;
      margin: 0;
      padding: 0 var(--space-2xs);
      /* A faint outline marks each name as a control where no hover can (a phone). */
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--color-mute);
      cursor: pointer;
    }
    button.level:hover:not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    button.level:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
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
  `;

  #actor = new ActorController(this);
  // The markdown last written into / read out of CM6, so an echoed note.changed
  // carrying the same body does not rewrite the document and lose the caret (4.3).
  #shown = "";
  #view = null;
  // The level of the line the caret is on, shown in the status so the levels and
  // their keys are discoverable (Don Norman: a visible signifier for a hidden map).
  #level = "body";
  // The level a transaction just set, so its button flashes until animationend.
  #flashed = null;
  // Undo reaches only what was typed since this text arrived: a note loaded from
  // outside empties the history, or "u" would walk back into the notes shown before
  // it and save each of them over this one.
  #history = new Compartment();

  #extensions() {
    return [
      ...baseExtensions({
        vim: this.#actor.snapshot?.context.vimKeys === true,
        history: false,
        quit: this.stage ? () => this.#actor.send({ type: "_quit" }) : null,
      }),
      paragraphs({ notList: leveled }),
      levelField,
      levelTheme,
      linkField,
      wholeLinks,
      overLinks,
      enterFollows,
      linkTheme,
      this.#history.of(history()),
      EditorView.updateListener.of(this.#onUpdate),
      EditorView.domEventHandlers({
        blur: () => {
          this.#actor.send({ type: "_blurred" });
        },
        // The page-wide Vim level keys arrive here as a "level" event (setLineLevel).
        level: (e, view) => {
          view.dispatch(toLevel(view.state, e.detail));
          return true;
        },
        // `:tab split` typed in this editor (the "tab" Ex command above).
        tabsplit: () => {
          this.#actor.send({ type: "_stage" });
          return true;
        },
        // A click on a source link's tag, or Enter on it (enterFollows).
        follow: (e) => {
          this.#actor.send({ type: "_follow", id: e.detail });
          return true;
        },
      }),
    ];
  }

  #onUpdate = (update) => {
    const leveled = update.transactions.some((t) => t.effects.some((e) => e.is(setLevel) || e.is(setAllLevels)));
    for (const t of update.transactions) {
      for (const e of t.effects) {
        if (!e.is(setLevel)) continue;
        this.#flashed = e.value;
        this.requestUpdate();
      }
    }
    if (update.selectionSet || update.docChanged || leveled) this.#syncLevel(update.state);
    if (!update.docChanged && !leveled) return;
    const body = serialize(update.state.doc.toString(), levelsOf(update.state));
    if (body === this.#shown) return; // our own load echoing back, or an unchanged serialization
    this.#shown = body;
    this.#actor.send({ type: "_typed", body });
  };

  // The caret line's level, mirrored to a private field so the status reflects it.
  #syncLevel(state) {
    const line = state.doc.lineAt(state.selection.main.head).number;
    const level = levelsOf(state)[line - 1] ?? "body";
    if (level === this.#level) return;
    this.#level = level;
    this.requestUpdate();
  }

  // Whether the arrow is mirrored: layout reading only. The left edge, not the centre,
  // decides, because a phone's drawer is nearly as wide as the screen and sits just right
  // of its middle, where the stage is not beside it but behind it.
  #mirrored = false;
  #resized = new ResizeObserver(() => this.#place());
  #place = () => {
    const mirrored = this.getBoundingClientRect().left >= globalThis.innerWidth / 2;
    if (mirrored === this.#mirrored) return;
    this.#mirrored = mirrored;
    this.requestUpdate();
  };

  connectedCallback() {
    super.connectedCallback();
    this.#resized.observe(this);
    globalThis.addEventListener("resize", this.#place);
  }

  // The CodeMirror document lives only while the region is drawn: signed out the region
  // is not drawn (render), so nothing of the note stays in the page, and signing in
  // builds it again from the note the actor still holds.
  #build(parent) {
    const body = this.#actor.snapshot?.context.body ?? "";
    const { doc, levels } = parseBody(body);
    this.#view = new EditorView({
      parent,
      // Shadow-DOM: CM6 reads the selection through the root and style-mod mounts its
      // sheet there, not on document (7.5), so it must know the shadow root.
      root: this.renderRoot,
      state: EditorState.create({ doc, extensions: this.#extensions() }),
    });
    this.#shown = body; // before the leveling dispatch, so #onUpdate sees no change
    this.#view.dispatch({ effects: setAllLevels.of(levels) });
    this.#syncLevel(this.#view.state);
  }

  updated() {
    // A dock can move without changing size (it slides in, or the desk is rearranged):
    // measured again once the desk has laid out the move.
    this.#place();
    requestAnimationFrame(this.#place);
    const region = this.renderRoot.querySelector(".region");
    if (!region) {
      this.#view?.destroy();
      this.#view = null;
      return;
    }
    if (!this.#view) this.#build(region);
    const snapshot = this.#actor.snapshot;
    if (!snapshot || !this.#view) return;
    const { body, vimKeys, removed } = snapshot.context;
    setVim(this.#view, vimKeys);
    if (this.#view.state.field(linkField).removed !== removed) this.#view.dispatch({ effects: setRemoved.of(removed) });
    if (body === this.#shown) return; // never the user's own keystroke (set #shown first)
    const { doc, levels } = parseBody(body);
    this.#shown = body;
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: doc },
      effects: [setAllLevels.of(levels), this.#history.reconfigure([])],
    });
    this.#view.dispatch({ effects: this.#history.reconfigure(history()) });
  }

  focusEditor() {
    this.#view?.focus();
  }

  disconnectedCallback() {
    this.#resized.disconnect();
    globalThis.removeEventListener("resize", this.#place);
    this.#view?.destroy();
    this.#view = null;
    super.disconnectedCallback();
  }

  #status(snapshot) {
    if (snapshot.matches("starting")) return "";
    if (snapshot.matches("empty")) return "New note";
    if (snapshot.matches("blank")) return "New note";
    if (snapshot.matches("failed")) return "notes unavailable";
    if (snapshot.matches({ editing: "dirty" })) return "Unsaved";
    if (snapshot.matches({ editing: "clean" })) return "Saved";
    return "";
  }

  // The level names are buttons, so a level can be set without Vim and on a phone; the
  // caret's own level is marked so the row doubles as feedback about where you are.
  // The Vim key stays beside the name while Vim is on, so a hidden map is visible.
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

  // The same effect the Vim key dispatches, so a click re-levels every line the
  // selection spans; focus goes back to the text so typing continues.
  #setLevel(level) {
    if (!this.#view) return;
    this.#view.dispatch(toLevel(this.#view.state, level));
    this.#view.focus();
  }

  #unflash = () => {
    this.#flashed = null;
    this.requestUpdate();
  };

  // The keyboard stays where it was (the mousedown above keeps it): the stage shows the
  // note, and the user goes on in the panel.
  #stageNote() {
    this.#actor.send({ type: "_stage" });
  }

  #togglePin() {
    this.#actor.send({ type: "_togglePin" });
  }

  // The About line (12): computed by the machine's pure aboutTitleOf, so the rule — a
  // saved note's link, or the stage's subject on a new note — is
  // tested in Node and the view only renders the result.
  #aboutTitle(snapshot) {
    return aboutTitleOf(snapshot);
  }

  // The header shown only while following the stage (D7): the About line, and the pin
  // toggle. The pin is disabled while the editor holds no note; its label names the
  // action for assistive tech, and its colour follows the state (accent when pinned).
  #header(aboutTitle, pinned, id, onStage, vimKeys) {
    const label = `${onStage ? "Show on stage" : "Open on stage"}${vimKeys ? " (:tab split)" : ""}`;
    return html`
      <div class="header">
        <span class="about">${aboutTitle ? html`About: ${aboutTitle}` : nothing}</span>
        <button
          class=${this.#mirrored ? "open mirrored" : "open"}
          type="button"
          aria-pressed=${onStage}
          aria-label=${label}
          title=${label}
          ?disabled=${!id}
          @mousedown=${(e) => e.preventDefault()}
          @click=${this.#stageNote}
        >
          ${icon("arrow-square-out")}
        </button>
        <button
          class="pin"
          type="button"
          aria-pressed=${pinned}
          aria-label=${pinned ? "Unpin note" : "Pin note"}
          ?disabled=${!id}
          @click=${this.#togglePin}
        >
          ${icon("push-pin")}
        </button>
      </div>
    `;
  }

  // dock-desk's Ctrl+h/j/k/l (12) and list-then-item focus a panel by its host: land
  // in the editor, where the typing goes.
  focus(options) {
    if (this.#view) this.focusEditor();
    else super.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    // Signed out nothing of the account shows (machine.js: showing).
    const account = showing(snapshot.context);
    if (account === "wait") return nothing;
    if (account === "sign-in") return html`<p class="empty">Sign in to see your notes.</p>`;
    const { subjecting, pinned, id, vimKeys } = snapshot.context;
    const aboutTitle = this.#aboutTitle(snapshot);
    // .region has no bindings, so Lit never touches CM6's subtree on re-render.
    return html`
      <div class="editor">
        ${subjecting ? this.#header(aboutTitle, pinned, id, isStaged(snapshot.context), vimKeys) : nothing}
        <div class="region" role="textbox" aria-label="Note"></div>
        <div class="footer">
          <p class="status">
            <span>${this.#status(snapshot)}</span><span class="sizer" aria-hidden="true">New note</span
            ><span class="sizer" aria-hidden="true">Unsaved</span>
          </p>
          ${this.#levelBar(vimKeys)}
        </div>
      </div>
    `;
  }
}

customElements.define("note-editor", NoteEditor);
