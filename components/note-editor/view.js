import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment, MapMode } from "@codemirror/state";
import { EditorView, Decoration, placeholder } from "@codemirror/view";
import { history } from "@codemirror/commands";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs, sourceLinks, missingLinks, refreshLinks, webLinks, toRegister, hashtags, refreshHashtags, hashtagPicker, notePicker, refreshPicker, pickerKey, shortName, lineMarks, setLineMarks, finishedLines, hashtagScopes } from "editor";
import { machine, parseBody, serialize, aboutTitleOf, chapterLabelOf, isStaged, hintOf, showing, startsTyping, prewritten, linkMissing, linkTitleOf, linkHintOf, linkableNotes, notSynced, knownTags, lineMarksOf, homeOf, footerOf, slipBoxTargets } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import opened from "./events/note.opened.json" with { type: "json" };
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

// The note this editor last showed, kept under a key beginning with its name (3.1), so
// with keepOpen on a reload reopens it. Wrapped like settings/store.js so a browser
// refusing storage reads null and drops the write.
const OPEN_KEY = "note-editor.open";
const openStore = {
  recall() {
    try {
      return localStorage.getItem(OPEN_KEY);
    } catch {
      return null;
    }
  },
  remember(id) {
    try {
      if (id == null) localStorage.removeItem(OPEN_KEY);
      else localStorage.setItem(OPEN_KEY, id);
    } catch {
      // No persistence available; the open note is not kept across a reload.
    }
  },
};

// The titles of subjects this browser has seen (12), kept beside the open note under a key
// beginning with its name (3.1). "kind:id" -> title. Wrapped like openStore: a browser refusing storage, or a malformed
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

// Which footer sections the user folded (passages, under, linked), kept in this browser
// (3.1) for every note under a key beginning with its name. Wrapped like openStore: a
// browser refusing storage, or a malformed value, reads nothing folded and drops the write.
const FOLD_KEY = "note-editor.folded";
const foldStore = {
  recall() {
    try {
      const folded = JSON.parse(localStorage.getItem(FOLD_KEY));
      return Array.isArray(folded) ? folded.filter((k) => typeof k === "string") : [];
    } catch {
      return [];
    }
  },
  remember(folded) {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(folded));
    } catch {
      // No persistence available; the folds live only for this page.
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
// blank moves to the line its text went to. Mapped alone, a level is also dropped when
// the line break before its line goes, as when the blank line above a Heading is
// deleted; it stays while its text is kept and still starts a line, and goes only when
// its line is joined onto the one above.
function follow(deco, tr) {
  const moved = [];
  for (const it = deco.iter(); it.value; it.next()) {
    if (tr.startState.doc.lineAt(it.from).length === 0) continue;
    const stays = tr.changes.mapPos(it.from, -1, MapMode.TrackBefore);
    if (stays === null) {
      const kept = tr.changes.mapPos(it.from, 1, MapMode.TrackAfter);
      if (kept !== null && tr.state.doc.lineAt(kept).from === kept) moved.push({ from: null, to: kept, value: it.value });
      continue;
    }
    if (tr.state.doc.lineAt(stays).length > 0) continue;
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

// The type menu's key, one page-wide map like the level keys: only this editor listens for
// "typemenu", so every other editor on the page ignores it.
Vim.defineAction("openTypeMenu", (cm) => {
  cm.cm6?.contentDOM.dispatchEvent(new CustomEvent("typemenu"));
});
Vim.mapCommand("\\t", "action", "openTypeMenu", {}, { context: "normal" });
// Where the keyboard returns after a menu opened by that key: the text, not a control.
const TO_EDITOR = "editor";

// `:tab split` (or `:tab sp`) shows the note on the stage. Ex commands are one set for the
// page, like the level maps, so it reaches the focused editor's own element as a
// "tabsplit" event, and an editor that does not listen ignores it.
Vim.defineEx("tab", "tab", (cm, params) => {
  if (["split", "sp"].includes(params.args?.[0])) cm.cm6?.contentDOM.dispatchEvent(new CustomEvent("tabsplit"));
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

// The icons an evaluator's option may carry (7.6), drawn at a checked line's end. The
// names are literals so the icon check sees each one (11.2).
const MARK_ICONS = {
  check: () => icon("check"),
  warning: () => icon("warning"),
  gavel: () => icon("gavel"),
  prohibit: () => icon("prohibit"),
  lightning: () => icon("lightning"),
  "calendar-blank": () => icon("calendar-blank"),
  "share-fat": () => icon("share-fat"),
  "trash-simple": () => icon("trash-simple"),
  "person-simple-walk": () => icon("person-simple-walk"),
  brain: () => icon("brain"),
  heart: () => icon("heart"),
  trophy: () => icon("trophy"),
  "hand-palm": () => icon("hand-palm"),
  footprints: () => icon("footprints"),
  question: () => icon("question"),
  compass: () => icon("compass"),
};

// One line's marks (machine.js: lineMarksOf), drawn into the element the editor kit gives.
const drawMarks = (into, marks) => {
  const [first] = marks;
  if (first?.pending) render(html`<span class="marks pending" role="img" aria-label="Checking"><i></i></span>`, into);
  else if (first?.failed) render(html`<span class="marks failed" role="img" aria-label=${first.error} title=${first.error}>${icon("warning")}</span>`, into);
  else
    render(
      html`<span class="marks">${marks.map(
        (m, i) => html`${i ? html`<span class="sep" aria-hidden="true">·</span>` : nothing}<span class=${m.tone ? `mark ${m.tone}` : "mark"} role="img" aria-label=${m.name}>${(MARK_ICONS[m.icon] ?? MARK_ICONS.check)()}<span class="name" aria-hidden="true">${m.name}</span></span>`,
      )}</span>`,
      into,
    );
};

// The "#" picker's rows: each evaluator by the short name line-checks matches a tag to.
const pickerTags = (evaluators) =>
  (evaluators ?? []).map((e) => ({ tag: shortName(e.name), description: e.description ?? "" }));

// The lines of `doc` a hashtag line names (the editor kit's hashtagScopes), of those given.
const named = (doc, lines) => {
  if (!lines.length) return lines;
  const scoped = new Set(hashtagScopes(doc).flatMap((s) => s.lines));
  return lines.filter((l) => scoped.has(l));
};

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
        recallOpen: openStore.recall,
        rememberOpen: openStore.remember,
        recallTitles: titleStore.recall,
        rememberTitles: titleStore.remember,
        // Vim's registers are one per page, so the link lands where any editor's p reads.
        pushRegister: toRegister,
        // A try page (8) shows the editor signed out.
        tryPage: location.pathname.startsWith("/try/"),
      },
      events: { "note.saved": saved, "note.opened": opened, "passage.selected": passageSelected, "note.staged": staged, "note.closed": closed },
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
    // Whether this editor follows the stage (D5). Reflected so the
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
       Open on stage on the right. It keeps its height with an empty About line so the editor
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
    /* The chapter label, on its own line under the About line so the book's name keeps
       its room: plain muted text naming the chapter the note is linked to. Its Link or
       Unlink button shows only while the pointer or the keyboard is on the label, so the
       line reads as a fact and not as a control; hidden, the button keeps its room, so
       nothing moves as it comes and goes, and the line keeps its height whether or not the
       label shows. A phone has no pointer that rests: a tap puts the keyboard on the label,
       which shows the button. On a narrow panel the chapter's name gives way first. */
    .place {
      flex: none;
      display: flex;
      min-height: calc(var(--text-caption) * var(--leading-tight) + 2 * var(--border-width));
    }
    .chapter {
      flex: 0 1 auto;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      color: var(--color-mute);
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      white-space: nowrap;
      outline: none;
    }
    .chapter > span {
      flex: 0 10 auto;
    }
    .chapter > span,
    .relink {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .relink {
      flex: 0 1 auto;
      appearance: none;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 0 var(--space-2xs);
      margin: 0;
      background: transparent;
      color: var(--color-body-mid);
      font: inherit;
      white-space: nowrap;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
    }
    /* The whole line is the label's hover area, so a button that turns narrower under
       the pointer (Link to … into Unlink) stays shown and pressing again reverses it. */
    .place:hover .relink,
    .place:focus-within .relink {
      opacity: 1;
      pointer-events: auto;
    }
    .relink:hover {
      color: var(--color-ink);
    }
    .relink:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* Open on stage: muted, accent while the note has a tab on the stage. One icon,
       sized by the caption type. */
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
    .open svg {
      display: block;
    }
    /* The arrow points towards the stage: up-left from a dock right of the middle. */
    .open.mirrored svg {
      transform: scaleX(-1);
    }
    .open:hover:not(:disabled):not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    .open[aria-pressed="true"] {
      color: var(--color-accent);
    }
    .open:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .open:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The home line (while Slip-Box shows): where the note belongs, one muted line that
       wraps: its book and chapter, each place in the Slip-Box with its ×, and Add to
       Slip-Box…, whose list opens under it. */
    .header.homed {
      align-items: flex-start;
    }
    .home {
      flex: 1;
      min-width: 0;
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2xs) var(--space-xs);
      font-size: var(--text-caption);
      line-height: var(--leading-normal);
      color: var(--color-body-mid);
    }
    .home .sep {
      color: var(--color-mute);
    }
    .home-book,
    .home-place {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      min-width: 0;
      outline: none;
    }
    /* The book is a line of its own, as the About line was, so its hidden button's room
       never leaves a gap among the places. */
    .home-book {
      flex: 1 0 100%;
    }
    .home-book > span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The chapter label's button, shown only while the pointer or the keyboard is on the
       book (a tap on a phone), as under the About line. */
    .home-book .relink {
      flex: none;
    }
    .home-book:hover .relink,
    .home-book:focus-within .relink {
      opacity: 1;
      pointer-events: auto;
    }
    .home-open,
    .home-add,
    .home .x {
      appearance: none;
      border: 0;
      background: none;
      margin: 0;
      font: inherit;
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .home button:focus-visible,
    .sections button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .home-open {
      padding: 0 var(--space-2xs);
      color: var(--color-body);
      text-align: left;
    }
    .home-open:hover {
      color: var(--color-ink);
    }
    .home .x,
    .sections .x {
      display: inline-flex;
      padding: var(--space-2xs);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .home .x:hover,
    .sections .x:hover {
      color: var(--color-ink);
    }
    .home-add {
      padding: 0 var(--space-xs);
      color: var(--color-body-mid);
      white-space: nowrap;
    }
    .home-add:hover:not(:disabled),
    .home-add[aria-expanded="true"] {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    .home-add:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    /* The note's type, first on the line: a small outlined button, so it reads as one
       that opens a choice. */
    .home-type {
      appearance: none;
      margin: 0;
      font: inherit;
      cursor: pointer;
      padding: 0 var(--space-xs);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: none;
      color: var(--color-body);
      white-space: nowrap;
    }
    .home-type:hover,
    .home-type[aria-expanded="true"] {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    /* The first line: the type, then the book, which fills the rest of it. */
    .home-first {
      flex: 1 0 100%;
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      min-width: 0;
    }
    .home-first .home-book {
      flex: 1 1 auto;
    }
    .home .x:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .type-row .tag {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }
    /* A type's line is read whole, so it wraps rather than being cut. */
    .slip-row.type-row .under {
      white-space: normal;
    }
    .type-row[aria-disabled="true"] .tag {
      color: var(--color-mute);
    }
    /* Add to Slip-Box's list: the look of the editor kit's # and [[ lists, never wider than
       the editor. */
    .slip-list {
      position: absolute;
      left: 0;
      top: calc(100% + var(--space-xs));
      z-index: 2;
      width: calc(var(--space-xl) * 7.5);
      max-width: 100%;
      max-height: calc(var(--space-xl) * 7);
      overflow-y: auto;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding: var(--space-xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card);
      line-height: var(--leading-tight);
      outline: none;
    }
    .slip-row {
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: var(--space-2xs);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      min-width: 0;
    }
    :host([narrow]) .slip-row {
      min-height: calc(var(--space-xl) + var(--space-sm));
      box-sizing: border-box;
    }
    .slip-row[aria-selected="true"] {
      background: var(--color-surface-hover);
    }
    .slip-row .tag {
      font-size: var(--text-sm);
      color: var(--color-accent);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .slip-row .under {
      font-size: var(--text-caption);
      color: var(--color-body);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* The footer (while Slip-Box shows), fixed at the bottom above the level bar: Passages,
       Notes under this and Linked from, each folded with its caret. It scrolls on its own
       when it holds more than fits. */
    .sections {
      flex: none;
      max-height: calc(var(--space-xl) * 6.5);
      overflow-y: auto;
      border-top: var(--border-width) solid var(--color-border);
      padding-top: var(--space-sm);
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .sections button {
      appearance: none;
      border: 0;
      background: transparent;
      font: inherit;
      margin: 0;
      border-radius: var(--radius-sm);
      cursor: pointer;
      text-align: left;
    }
    .sections .fold {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      margin-left: calc(-1 * var(--space-xs));
      padding: var(--space-2xs) var(--space-xs);
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-normal);
      color: var(--color-body);
    }
    :host([narrow]) .sections .fold {
      min-height: calc(var(--space-lg) + var(--space-sm));
    }
    .fold .caret {
      display: inline-flex;
      color: var(--color-mute);
    }
    .fold[aria-expanded="true"] .caret svg {
      transform: rotate(90deg);
    }
    .fold:hover {
      color: var(--color-ink);
    }
    .section-body {
      padding-left: var(--space-md);
    }
    .section-body .none {
      margin: 0;
      font-size: var(--text-caption);
      line-height: var(--leading-normal);
      color: var(--color-body-mid);
    }
    .passage {
      display: flex;
      align-items: flex-start;
      gap: var(--space-xs);
    }
    .passage .x {
      flex: none;
      margin-top: var(--space-xs);
    }
    .row {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      width: calc(100% + var(--space-sm));
      margin-left: calc(-1 * var(--space-xs));
      padding: var(--space-2xs) var(--space-xs);
      color: var(--color-body);
    }
    :host([narrow]) .row {
      min-height: calc(var(--space-xl) + var(--space-sm));
      box-sizing: border-box;
      justify-content: center;
    }
    .row:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    .row:disabled {
      cursor: default;
    }
    .row .words,
    .row .name {
      display: block;
      max-width: 100%;
      font-size: var(--text-sm);
      line-height: var(--leading-normal);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row .name {
      font-weight: var(--weight-semibold);
    }
    .row .chapter-of {
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      color: var(--color-mute);
    }
    .row.gone .words {
      color: var(--color-mute);
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
    /* The status keeps the width of its widest usual words, so "Not synced" coming and
       going never changes where the footer wraps and the row never jumps. The words
       stack in one grid cell; the hidden ones only give it their width. */
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
    /* Jev's answers at a checked line's end (the editor kit places them): each the
       option's icon and name, several in one row, on a soft tint. */
    .marks {
      display: inline-flex;
      align-items: center;
      padding: 0 var(--space-xs);
      border-radius: var(--radius-sm);
      background: var(--color-canvas-soft);
      font-size: var(--text-caption);
      font-weight: var(--weight-normal);
      line-height: calc(var(--text-sm) * var(--leading-normal));
      min-height: calc(var(--text-sm) * var(--leading-normal));
      color: var(--color-body-mid);
      white-space: nowrap;
    }
    .marks .mark {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2xs);
    }
    /* The one mark of an evaluator shown as one mark (line-checks): the colors of
       choice-point-cards' marks, filling the soft tint behind them. */
    .marks .mark.right,
    .marks .mark.wrong {
      margin: 0 calc(-1 * var(--space-xs));
      padding: 0 var(--space-xs);
      border-radius: var(--radius-sm);
    }
    .marks .mark.right {
      color: var(--color-success);
      background: var(--color-success-subtle);
    }
    .marks .mark.wrong {
      color: var(--color-danger);
      background: var(--color-danger-subtle);
    }
    /* The dock is narrow, and so is the stage on the phone ([narrow]), so there a mark
       shows only its icon, and its name above it on hover, out of the line's flow so the
       text never moves. The stage on the desk keeps the name. */
    :host(:not([stage])) .marks .mark,
    :host([narrow]) .marks .mark {
      position: relative;
    }
    :host(:not([stage])) .marks .mark .name,
    :host([narrow]) .marks .mark .name {
      display: none;
    }
    :host(:not([stage])) .marks .mark:hover .name,
    :host([narrow]) .marks .mark:hover .name {
      display: block;
      position: absolute;
      bottom: calc(100% + var(--space-2xs));
      right: 0;
      z-index: 1;
      padding: 0 var(--space-xs);
      border-radius: var(--radius-sm);
      background: var(--color-canvas-soft);
      box-shadow: var(--shadow-card);
      color: var(--color-body-mid);
      font-size: var(--text-caption);
      white-space: nowrap;
      pointer-events: none;
    }
    .marks svg {
      display: block;
      flex: none;
    }
    .marks .sep {
      color: var(--color-mute);
      padding: 0 var(--space-xs);
    }
    .marks.failed {
      color: var(--color-warning);
      background: var(--color-warning-subtle);
    }
    .marks.pending {
      background: none;
    }
    .marks.pending i {
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
      .marks.pending i {
        animation: none;
      }
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
  // The muted line on an empty Slip-Box (machine.js: hintOf), drawn by CodeMirror where the
  // text starts, and the hint it was last set to.
  #hint = new Compartment();
  #hintFor = null;
  // Which source links' highlights are gone, as last handed to the editor's tags, and the
  // actor's facts it was made from.
  #missing = () => false;
  #missingFrom = null;
  // The hashtags that name an evaluator, and the report they and the marks were drawn from.
  #known = new Set();
  #checksFrom = undefined;
  // The evaluator list an open "#" picker was last asked to show, and the notes, feature
  // and open note the "[[" picker and the tags' titles were last drawn from.
  #evaluatorsFrom = undefined;
  #linksFrom = null;

  #extensions() {
    return [
      ...baseExtensions({
        vim: this.#actor.snapshot?.context.vimKeys === true,
        history: false,
        quit: this.stage ? () => this.#actor.send({ type: "_quit" }) : null,
      }),
      paragraphs({ notList: leveled, box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      levelField,
      levelTheme,
      // A source link is drawn as a tag (the editor kit, 10); following one asks the actor.
      sourceLinks({
        follow: (id) => this.#actor.send({ type: "_follow", id }),
        icon: (into) => render(icon("link"), into),
        missing: (id) => this.#missing(id),
        // A link names its note by id; the tag shows that note's title as it is now.
        title: (id) => (this.#actor.snapshot ? linkTitleOf(this.#actor.snapshot.context)(id) : null),
        hint: (id, gone) => (this.#actor.snapshot ? linkHintOf(this.#actor.snapshot.context)(id, gone) : gone ? "This highlight was removed" : "Open the passage"),
      }),
      // A web address is drawn as a link that opens in a new tab (the editor kit, 10).
      webLinks(),
      // Hashtags and Jev's answers at the lines they name (the editor kit, 10).
      hashtags({ known: (name) => this.#known.has(name) }),
      hashtagPicker({ tags: () => pickerTags(this.#actor.snapshot?.context.evaluators) }),
      // "[[" offers the notes to link to, only while Slip-Box is shown (linkableNotes).
      notePicker({ targets: () => (this.#actor.snapshot ? linkableNotes(this.#actor.snapshot.context) : []) }),
      lineMarks({ render: drawMarks }),
      this.#history.of(history()),
      this.#hint.of([]),
      EditorView.updateListener.of(this.#onUpdate),
      EditorView.domEventHandlers({
        // Leaving the editor finishes every line.
        blur: (_e, view) => {
          const doc = view.state.doc.toString();
          this.#actor.send({ type: "_finished", lines: named(doc, doc.split("\n").map((l) => l.trim()).filter(Boolean)) });
          this.#actor.send({ type: "_blurred" });
        },
        focus: () => {
          this.#actor.send({ type: "_focused" });
          // A press on the title moves the cursor there after this.
          if (this.#actor.snapshot && prewritten(this.#actor.snapshot)) this.#view?.dispatch({ selection: { anchor: this.#view.state.doc.length } });
          this.#startTyping();
        },
        // The page-wide Vim level keys arrive here as a "level" event (setLineLevel).
        level: (e, view) => {
          view.dispatch(toLevel(view.state, e.detail));
          return true;
        },
        // \t typed in this editor (openTypeMenu); a note with no type label ignores it.
        typemenu: () => {
          const type = this.#homeNow(this.#actor.snapshot)?.type;
          if (type) this.#openTypes(type, TO_EDITOR);
          return true;
        },
        // `:tab split` typed in this editor (the "tab" Ex command above).
        tabsplit: () => {
          this.#actor.send({ type: "_stage" });
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
    if (update.docChanged || leveled) {
      const body = serialize(update.state.doc.toString(), levelsOf(update.state));
      // Not our own load echoing back, nor an unchanged serialization.
      if (body !== this.#shown) {
        this.#shown = body;
        this.#actor.send({ type: "_typed", body });
      }
    }
    // After the text, so a line finished by Enter goes out with the save of that text. A
    // note loaded into the editor (setAllLevels) is not the user finishing a line.
    const loaded = update.transactions.some((t) => t.effects.some((e) => e.is(setAllLevels)));
    if (loaded || !update.view.hasFocus || !(update.selectionSet || update.docChanged)) return;
    const lines = named(update.state.doc.toString(), finishedLines(update));
    if (lines.length) this.#actor.send({ type: "_finished", lines });
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
    // The page is in its phone layout in the phone preview (7.5, views only read it) or
    // below dock-desk's narrow-desk breakpoint (6.4), the same 45rem.
    const root = document.documentElement;
    const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
    this.toggleAttribute("narrow", root.getAttribute("data-viewport") === "phone" || globalThis.innerWidth < 45 * rem);
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
      state: EditorState.create({ doc, selection: { anchor: this.#actor.snapshot && prewritten(this.#actor.snapshot) ? doc.length : 0 }, extensions: this.#extensions() }),
    });
    this.#shown = body; // before the leveling dispatch, so #onUpdate sees no change
    this.#checksFrom = undefined;
    this.#hintFor = null;
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
      // Taking the document away fires no blur, and while the actor thinks the keyboard
      // is in the note, a chapter change does not move it.
      if (this.#view?.hasFocus) this.#actor.send({ type: "_blurred" });
      this.#view?.destroy();
      this.#view = null;
      return;
    }
    if (!this.#view) this.#build(region);
    const snapshot = this.#actor.snapshot;
    if (!snapshot || !this.#view) return;
    const { body, vimKeys, notes, removed, checks } = snapshot.context;
    setVim(this.#view, vimKeys);
    const hint = hintOf(snapshot.context);
    if (hint !== this.#hintFor) {
      this.#hintFor = hint;
      this.#view.dispatch({ effects: this.#hint.reconfigure(hint ? placeholder(hint) : []) });
    }
    if (checks !== this.#checksFrom) {
      this.#checksFrom = checks;
      this.#known = knownTags(checks);
      refreshHashtags(this.#view);
      this.#view.dispatch({ effects: setLineMarks.of(lineMarksOf(checks)) });
    }
    if (snapshot.context.evaluators !== this.#evaluatorsFrom) {
      this.#evaluatorsFrom = snapshot.context.evaluators;
      refreshPicker(this.#view);
    }
    const { entries, hidden, id } = snapshot.context;
    if (entries !== this.#linksFrom?.entries || hidden !== this.#linksFrom?.hidden || id !== this.#linksFrom?.id) {
      this.#linksFrom = { entries, hidden, id };
      refreshPicker(this.#view);
      refreshLinks(this.#view);
    }
    if (notes !== this.#missingFrom?.notes || removed !== this.#missingFrom?.removed) {
      this.#missingFrom = { notes, removed };
      this.#missing = linkMissing(snapshot.context);
      missingLinks(this.#view, this.#missing);
    }
    // The new note can arrive after the keyboard did (the list focuses the editor while
    // its read is in flight): start typing once per note picked.
    const typingFor = startsTyping(snapshot) ? snapshot.context.id : null;
    if (typingFor !== this.#typingFor) {
      this.#typingFor = typingFor;
      this.#startTyping();
    }
    if (body === this.#shown) return; // never the user's own keystroke (set #shown first)
    const { doc, levels } = parseBody(body);
    this.#shown = body;
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: doc },
      ...(prewritten(snapshot) ? { selection: { anchor: doc.length } } : {}),
      effects: [setAllLevels.of(levels), this.#history.reconfigure([])],
    });
    this.#view.dispatch({ effects: this.#history.reconfigure(history()) });
  }

  focusEditor() {
    this.#view?.focus();
  }

  // The note picked before it is written, for which updated() last started typing.
  #typingFor = null;

  // A new note picked from the list (startsTyping, 12): the keyboard here starts in Vim's
  // insert mode, so the first letter is text, not a Vim command.
  #startTyping() {
    const view = this.#view;
    const snapshot = this.#actor.snapshot;
    if (!view?.hasFocus || snapshot?.context.vimKeys !== true || !startsTyping(snapshot)) return;
    const cm = getCM(view);
    if (cm?.state?.vim && !cm.state.vim.insertMode) Vim.handleKey(cm, "i", "user");
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
    // A save is not news (5, local-first): only a change the server has not had for a
    // while is, because closing the device then would leave it on this device alone.
    if (notSynced(snapshot.context)) return "Not synced";
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

  #relink() {
    this.#actor.send({ type: "_relink" });
  }

  // The chapter label (machine.js: chapterLabelOf decides what it says and offers).
  #chapter(label) {
    if (!label) return nothing;
    return html`<span class="chapter" tabindex=${label.action ? "-1" : nothing}
      ><span>${label.text}</span>${label.action
        ? html`<button class="relink" type="button" title=${label.action} @mousedown=${(e) => e.preventDefault()} @click=${this.#relink}>
            ${label.action}
          </button>`
        : nothing}</span
    >`;
  }

  // The About line (12): computed by the machine's pure aboutTitleOf, so the rule — a
  // saved note's link, or the stage's subject on a new note — is
  // tested in Node and the view only renders the result.
  #aboutTitle(snapshot) {
    return aboutTitleOf(snapshot);
  }

  // The header shown only while following the stage (D7): the About line with Open on
  // stage, and under it the chapter label's line. Open on stage is disabled while the
  // editor holds no note; its label names the action for assistive tech.
  #header(aboutTitle, chapter, id, onStage, vimKeys) {
    return html`
      <div class="header">
        <span class="about" title=${aboutTitle ?? nothing}>${aboutTitle ? html`About: ${aboutTitle}` : nothing}</span>
        ${this.#openButton(id, onStage, vimKeys)}
      </div>
      <div class="place">${this.#chapter(chapter)}</div>
    `;
  }

  // Open on stage, disabled while the editor holds no note; its label names the action
  // for assistive tech.
  #openButton(id, onStage, vimKeys) {
    const label = `${onStage ? "Show on stage" : "Open on stage"}${vimKeys ? " (:tab split)" : ""}`;
    return html`<button
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
        </button>`;
  }

  // --- The home line and the footer (Slip-Box) ---------------------------------------

  // Add to Slip-Box's list (UI state): open or not, and the row marked for Enter.
  #slip = { open: false, selected: 0 };
  // The footer sections the user folded, kept for every note (foldStore).
  #folded = foldStore.recall();

  // The type menu (UI state): open or not, and the row marked for Enter.
  #types = { open: false, selected: 0 };

  // While Slip-Box shows, the home line takes the About line's place (and the stage's
  // editor gets one too).
  #homeNow(snapshot) {
    return snapshot.context.subjecting || snapshot.context.staged ? homeOf(snapshot) : null;
  }

  // The keyboard returns where it came from: a key typed in the text goes back to the text,
  // since that is where the user was working (`back` is TO_EDITOR or a control's selector).
  #giveBack(back) {
    this.updateComplete.then(() => (back === TO_EDITOR ? this.focusEditor() : this.renderRoot.querySelector(back)?.focus()));
  }

  #openTypes(type, back = ".home-type") {
    const at = type.options.findIndex((t) => t.value === type.value);
    this.#types = { open: !this.#types.open, selected: Math.max(0, at), back };
    this.#slip = { open: false, selected: 0 };
    this.requestUpdate();
    if (this.#types.open) this.updateComplete.then(() => this.renderRoot.querySelector(".type-menu")?.focus());
  }

  #closeTypes(refocus) {
    if (!this.#types.open) return;
    const { back } = this.#types;
    this.#types = { open: false, selected: 0 };
    this.requestUpdate();
    if (refocus) this.#giveBack(back);
  }

  // A type picked: set it, or, for Permanent while the note is not in the Slip-Box, open
  // the Add to Slip-Box list, where a place sets both. A greyed type only says why, in its
  // line, because a phone has no tooltip.
  #pickType(option) {
    if (!option) return;
    if (!option.enabled) {
      this.#types = { ...this.#types, told: option.value };
      this.requestUpdate();
      return;
    }
    if (option.needsPlace) {
      const { back } = this.#types;
      this.#types = { open: false, selected: 0 };
      this.#slip = { open: false, selected: 0 };
      this.#openSlip(back);
      return;
    }
    this.#actor.send({ type: "_retype", noteType: option.value });
    this.#closeTypes(true);
  }

  #typeKey(e, type, vimKeys) {
    const key = pickerKey(e, { vim: vimKeys });
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    if (key === "close") return this.#closeTypes(true);
    if (key === "pick") return this.#pickType(type.options[this.#types.selected]);
    const n = type.options.length;
    this.#types = { open: true, back: this.#types.back, selected: (((this.#types.selected + (key === "down" ? 1 : -1)) % n) + n) % n };
    this.requestUpdate();
  }

  #typeMenu(snapshot, type) {
    if (!this.#types.open) return nothing;
    const selected = Math.min(this.#types.selected, type.options.length - 1);
    return html`<div
      class="slip-list type-menu"
      role="menu"
      aria-label="Type of note"
      tabindex="-1"
      aria-activedescendant=${`type-${selected}`}
      @keydown=${(e) => this.#typeKey(e, type, snapshot.context.vimKeys)}
      @focusout=${(e) => !e.currentTarget.contains(e.relatedTarget) && this.#closeTypes(false)}
    >
      ${type.options.map(
        (t, i) => html`<div
          class="slip-row type-row"
          id=${`type-${i}`}
          role="menuitemradio"
          aria-checked=${t.value === type.value}
          aria-disabled=${!t.enabled}
          aria-selected=${i === selected}
          title=${t.why ?? nothing}
          @mousedown=${(e) => e.preventDefault()}
          @click=${() => this.#pickType(t)}
        >
          <span class="tag">${t.label}${t.value === type.value ? icon("check") : nothing}</span><span class="under" aria-live="polite">${this.#types.told === t.value ? t.why : t.says}</span>
        </div>`,
      )}
    </div>`;
  }

  // `back` is where the keyboard returns (#giveBack).
  #openSlip(back = ".home-add") {
    this.#slip = { open: !this.#slip.open, selected: 0, back };
    this.requestUpdate();
    // The keyboard goes to the list, where the picker's keys work (the kit's pickerKey).
    if (this.#slip.open) this.updateComplete.then(() => this.renderRoot.querySelector(".slip-list")?.focus());
  }

  #closeSlip(refocus) {
    if (!this.#slip.open) return;
    const { back } = this.#slip;
    this.#slip = { open: false, selected: 0 };
    this.requestUpdate();
    if (refocus) this.#giveBack(back);
  }

  #pickSlip(targets, index) {
    const target = targets[index];
    if (!target) return;
    this.#actor.send({ type: "_place", id: target.id });
    this.#closeSlip(true);
  }

  #slipKey(e, targets, vimKeys) {
    const key = pickerKey(e, { vim: vimKeys });
    if (!key) return;
    e.preventDefault();
    e.stopPropagation();
    if (key === "close") return this.#closeSlip(true);
    if (key === "pick") return this.#pickSlip(targets, this.#slip.selected);
    const n = targets.length;
    this.#slip = { ...this.#slip, selected: (((this.#slip.selected + (key === "down" ? 1 : -1)) % n) + n) % n };
    this.requestUpdate();
    this.updateComplete.then(() => this.renderRoot.querySelector('.slip-row[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }));
  }

  #slipList(snapshot) {
    const targets = slipBoxTargets(snapshot.context);
    if (!this.#slip.open || !targets.length) return nothing;
    const selected = Math.min(this.#slip.selected, targets.length - 1);
    return html`<div
      class="slip-list"
      role="listbox"
      aria-label="Add to Slip-Box"
      tabindex="-1"
      aria-activedescendant=${`slip-${selected}`}
      @keydown=${(e) => this.#slipKey(e, targets, snapshot.context.vimKeys)}
      @focusout=${(e) => !e.currentTarget.contains(e.relatedTarget) && this.#closeSlip(false)}
    >
      ${targets.map(
        (t, i) => html`<div
          class="slip-row"
          id=${`slip-${i}`}
          role="option"
          aria-selected=${i === selected}
          @mousedown=${(e) => e.preventDefault()}
          @click=${() => this.#pickSlip(targets, i)}
        >
          <span class="tag">${t.title}</span>${t.about ? html`<span class="under">${t.about}</span>` : nothing}
        </div>`,
      )}
    </div>`;
  }

  // The home line (machine.js: homeOf decides what it names and offers).
  #home(snapshot, home) {
    const { vimKeys } = snapshot.context;
    const type = home.type
      ? html`<button
          class="home-type"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${this.#types.open}
          title=${`Type of note${vimKeys ? " (\\t)" : ""}`}
          aria-label=${`Type of note: ${home.type.options.find((t) => t.value === home.type.value).label}${vimKeys ? " (\\t)" : ""}`}
          @mousedown=${(e) => e.preventDefault()}
          @click=${() => this.#openTypes(home.type)}
        >
          ${vimKeys ? html`<kbd>\\t</kbd> ` : nothing}${home.type.options.find((t) => t.value === home.type.value).label}
        </button>`
      : null;
    const books = home.books.map(
        (b) => html`<span class="home-book" tabindex=${b.action ? "-1" : nothing}
          ><span title=${b.text}>${b.text}</span>${b.action
            ? html`<button class="relink" type="button" title=${b.action} @mousedown=${(e) => e.preventDefault()} @click=${this.#relink}>${b.action}</button>`
            : nothing}</span
        >`,
    );
    const items = [
      // The type leads the first line, beside the book when there is one.
      ...(type && books.length ? [html`<span class="home-first">${type}${books[0]}</span>`, ...books.slice(1)] : type ? [type, ...books] : books),
      ...home.places.map(
        (p) => html`<span class="home-place"
          ><button class="home-open" type="button" title=${`Open ${p.label}`} @click=${() => this.#actor.send({ type: "_follow", id: p.id })}>${p.label}</button
          >${p.removable
            ? html`<button
                class="x"
                type="button"
                ?disabled=${p.stays}
                aria-label=${p.stays ? "A permanent note stays in the Slip-Box" : `Take it out of ${p.label}`}
                title=${p.stays ? "A permanent note stays in the Slip-Box" : `Take it out of ${p.label}`}
                @mousedown=${(e) => e.preventDefault()}
                @click=${() => this.#actor.send({ type: "_unplace", id: p.id })}
              >
                ${icon("x")}
              </button>`
            : nothing}</span
        >`,
      ),
      ...(home.add
        ? [
            html`<button
              class="home-add"
              type="button"
              aria-haspopup="listbox"
              aria-expanded=${this.#slip.open}
              ?disabled=${!home.add.enabled}
              title=${home.add.enabled ? "Put this note under the Slip-Box or a note in it" : "There is no other place in the Slip-Box"}
              @mousedown=${(e) => e.preventDefault()}
              @click=${() => this.#openSlip()}
            >
              Add to Slip-Box…
            </button>`,
          ]
        : []),
    ];
    // A dot between the places and Add, never after the first line (the type and the book),
    // which ends its own line; with no book, none after the type either.
    const first = type && !books.length ? 0 : books.length;
    return html`<div class="home" role="group" aria-label="Where this note belongs">
      ${items.map((item, i) => html`${i > first ? html`<span class="sep" aria-hidden="true">·</span>` : nothing}${item}`)}${home.type ? this.#typeMenu(snapshot, home.type) : nothing}${this.#slipList(snapshot)}
    </div>`;
  }

  #toggleFold(key) {
    this.#folded = this.#folded.includes(key) ? this.#folded.filter((k) => k !== key) : [...this.#folded, key];
    foldStore.remember(this.#folded);
    this.requestUpdate();
  }

  // One foldable footer section: its caret and name, then its rows or a muted line.
  #section(key, name, rows, none) {
    const open = !this.#folded.includes(key);
    return html`<div class="section">
      <button class="fold" type="button" aria-expanded=${open} @click=${() => this.#toggleFold(key)}>
        <span class="caret">${icon("caret-right")}</span><span>${name}</span>
      </button>
      ${open ? html`<div class="section-body">${rows.length ? rows : html`<p class="none">${none}</p>`}</div>` : nothing}
    </div>`;
  }

  #noteRow(n) {
    return html`<button class="row" type="button" title=${`Open ${n.title}`} @click=${() => this.#actor.send({ type: "_follow", id: n.id })}>
      <span class="name">${n.title}</span>
    </button>`;
  }

  // The footer (machine.js: footerOf decides what each section holds).
  #sections(footer) {
    const passages = footer.passages.map(
      (p) => html`<div class="passage">
        <button
          class=${p.gone ? "row gone" : "row"}
          type="button"
          ?disabled=${p.gone}
          title=${p.gone ? "This highlight was removed" : "Open the passage"}
          @click=${() => this.#actor.send({ type: "_passage", id: p.id })}
        >
          <span class="words">${p.words}</span>${p.chapter ? html`<span class="chapter-of">${p.chapter}</span>` : nothing}
        </button>
        <button
          class="x"
          type="button"
          aria-label="Take this passage out of the note"
          title="Take this passage out of the note"
          @click=${() => this.#actor.send({ type: "_unpassage", id: p.id })}
        >
          ${icon("x")}
        </button>
      </div>`,
    );
    return html`<div class="sections">
      ${this.#section("passages", "Passages", passages, "No passages yet.")}
      ${footer.under ? this.#section("under", "Notes under this", footer.under.map((n) => this.#noteRow(n)), "No notes under this yet.") : nothing}
      ${this.#section("linked", "Linked from", footer.linked.map((n) => this.#noteRow(n)), "No note links here yet.")}
    </div>`;
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
    const { subjecting, id, vimKeys } = snapshot.context;
    const aboutTitle = this.#aboutTitle(snapshot);
    // The footer sits above the level bar.
    const home = this.#homeNow(snapshot);
    const footer = footerOf(snapshot.context);
    if (!home && this.#slip.open) this.#slip = { open: false, selected: 0 };
    if (!home?.type && this.#types.open) this.#types = { open: false, selected: 0 };
    const header = home
      ? html`<div class="header homed">${this.#home(snapshot, home)}${subjecting ? this.#openButton(id, isStaged(snapshot.context), vimKeys) : nothing}</div>`
      : subjecting
        ? this.#header(aboutTitle, chapterLabelOf(snapshot), id, isStaged(snapshot.context), vimKeys)
        : nothing;
    // .region has no bindings, so Lit never touches CM6's subtree on re-render.
    return html`
      <div class="editor">
        ${header}
        <div class="region" role="textbox" aria-label="Note"></div>
        ${footer ? this.#sections(footer) : nothing}
        <div class="footer">
          <p class="status">
            <span>${this.#status(snapshot)}</span><span class="sizer" aria-hidden="true">New note</span
            ><span class="sizer" aria-hidden="true">Not synced</span>
          </p>
          ${this.#levelBar(vimKeys)}
        </div>
      </div>
    `;
  }
}

customElements.define("note-editor", NoteEditor);
