import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, StateField, StateEffect, RangeSetBuilder, Compartment, MapMode, Prec } from "@codemirror/state";
import { EditorView, Decoration, placeholder } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs, sourceLinks, missingLinks, webLinks, toRegister, hashtags, refreshHashtags, hashtagPicker, refreshHashtagPicker, shortName, lineMarks, setLineMarks, finishedLines, hashtagScopes } from "editor";
import { machine, shown, selectedOf, conflictOn, longDate, parseBody, serialize, showing, linkMissing, textEdge, nestedStep, flagShown, knownTags, lineMarksOf, marksOf, markAt, pastKey, wordAround, fingerPassage, addToNote, sourceLink } from "./machine.js";
import saved from "./events/day.saved.json" with { type: "json" };
import dayShown from "./events/day.shown.json" with { type: "json" };
import closed from "./events/book.closed.json" with { type: "json" };
import passageSelected from "./events/passage.selected.json" with { type: "json" };
import noteSaved from "./events/note.saved.json" with { type: "json" };
import noteDiscarded from "./events/note.discarded.json" with { type: "json" };
import passageAdded from "./events/passage.added.json" with { type: "json" };
import linkCopied from "./events/link.copied.json" with { type: "json" };
import textCopied from "./events/text.copied.json" with { type: "json" };

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
// day in conflict) is read only and offers no placeholder. It stays not editable, so a tap
// on a phone opens no on-screen keyboard, and the tabindex is what lets it hold the keys.
const editability = (on) => [
  EditorState.readOnly.of(!on),
  EditorView.editable.of(on),
  EditorView.contentAttributes.of(on ? { "aria-label": "Today's entry" } : { "aria-label": "The entry", tabindex: "0" }),
  on ? placeholder("What is on your mind? Enter starts a new paragraph; Shift+Enter breaks the line.") : [],
];

// The day's highlights (machine.js: marksOf), painted as marks that add no box, so the text
// never moves. The field holds what it is given, since a day shown here takes no typing.
const setMarks = StateEffect.define();
const markField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) deco = e.value;
    return tr.docChanged ? deco.map(tr.changes) : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const markSet = (marks, glowing) =>
  Decoration.set(
    marks
      .filter((m) => m.from < m.to)
      .map((m) =>
        Decoration.mark({
          class: `hl${m.commented ? " commented" : ""}${m.id === glowing ? " glow" : ""}`,
          attributes: { "data-id": m.id },
        }).range(m.from, m.to),
      ),
    true,
  );

// A finger's gesture (book-reader and chat-thread, copied because components never import
// each other, 11.2): how long it rests before it is a hold, and how far it may stray.
const HOLD_MS = 400;
const HOLD_SLOP = 10;
const COPIED_MS = 1200;
// Vim's two-press keys count within this long of the first press, as in the reader.
const CHORD_MS = 1000;
// A press that means something of its own inside a highlight: following a link.
const onLink = (path) => path.some((el) => el.classList?.contains("cm-source-link") || el.classList?.contains("cm-web-link"));

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
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        mint: ulid,
        now: () => Date.now(),
        // A try page (8) shows the journal signed out.
        tryPage: location.pathname.startsWith("/try/"),
        pushRegister: toRegister,
      },
      events: {
        "day.saved": saved,
        "day.shown": dayShown,
        "book.closed": closed,
        "passage.selected": passageSelected,
        "note.saved": noteSaved,
        "note.discarded": noteDiscarded,
        "passage.added": passageAdded,
        "link.copied": linkCopied,
        "text.copied": textCopied,
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

class JournalEntry extends LitElement {
  static properties = {
    height: { type: String, reflect: true },
  };

  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // in the writing box.
  // Slotting is manual, so a nested view a flag hides (8) is left unassigned and not shown,
  // while it stays connected and its actor mounted.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true, slotAssignment: "manual" };

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
      position: relative;
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
      position: relative;
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
      font-size: var(--text-sm);
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
    /* A highlight, as in the book reader: one color, rounded ends on every wrapped line, and
       no box of its own, so the painted text measures as the bare text did. */
    .hl {
      background: var(--color-highlight);
      border-radius: var(--radius-sm);
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
      cursor: pointer;
    }
    .hl.commented {
      box-shadow: inset 0 calc(-1 * var(--border-width)) 0 var(--color-accent);
    }
    .hl.glow {
      animation: entry-glow calc(3 * var(--duration-slide)) var(--ease);
    }
    @keyframes entry-glow {
      from,
      60% {
        background: var(--color-accent-selection);
        box-shadow: 0 0 0 var(--space-2xs) var(--color-accent-selection);
      }
    }
    /* A touch screen selects no earlier day: the browser's selection jumps as a finger moves,
       so a finger's passage is the entry's own (#held). The text keeps its default
       touch-action, because the day scrolls with a finger: iOS reads that as the touch begins,
       before a hold can be told from a drag, and a hold stops the scroll with #touchmove. */
    @media (hover: none) and (pointer: coarse) {
      .region.past .cm-content {
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
    }
    /* A finger's passage: boxes over its lines, never a change inside the editor, because a
       node redrawn under a finger takes the touch with it. */
    .passage {
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
    }
    .passage i {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--px, 0) var(--py, 0);
      width: var(--pw, 0);
      height: var(--ph, 0);
      background: var(--color-accent-selection);
      border-radius: var(--radius-sm);
    }
    /* A highlight's bubble (book-reader's): under the passage's end, placed by --bx/--by. */
    .bubble {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--bx, 0) var(--by, 0);
      margin-top: var(--space-xs);
      z-index: 2;
      box-sizing: border-box;
      max-width: 100%;
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-2xs) var(--space-xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
      font-size: var(--text-caption);
      color: var(--color-mute);
      user-select: none;
      -webkit-user-select: none;
    }
    .bubble .act {
      border: 0;
      background: none;
      font-size: var(--text-caption);
      padding: var(--space-2xs) var(--space-xs);
      color: var(--color-body);
    }
    .bubble .act.remove:hover {
      color: var(--color-danger);
    }
    /* aria-disabled rather than disabled, so the button still takes the press and says why. */
    .bubble .act[aria-disabled="true"] {
      cursor: default;
      color: var(--color-mute);
      background: none;
    }
    .bubble textarea {
      flex: 1 0 100%;
      box-sizing: border-box;
      min-height: calc(var(--text-sm) * var(--leading-normal) * 3);
      padding: var(--space-xs);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      color: var(--color-ink);
      font: inherit;
      font-size: var(--text-sm);
      resize: vertical;
      user-select: text;
      -webkit-user-select: text;
    }
    .bubble textarea:focus {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* What a key did or why it could not, said for a moment over the foot of the day. */
    .said {
      position: absolute;
      bottom: var(--space-sm);
      left: var(--space-lg);
      z-index: 2;
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      box-shadow: var(--shadow-card);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
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
    /* On the phone ([narrow]) a mark shows only its icon, and its name above it on hover,
       out of the line's flow so the text never moves, as in note-editor's dock. */
    :host([narrow]) .marks .mark {
      position: relative;
    }
    :host([narrow]) .marks .mark .name {
      display: none;
    }
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
  // Which source links' highlights are gone, as last handed to the editor's tags, and the
  // actor's facts it was made from.
  #missing = () => false;
  #missingFrom = null;
  // The hashtags that name an evaluator, and the report they and the marks were drawn from.
  #known = new Set();
  #checksFrom = undefined;
  // The evaluator list an open "#" picker was last asked to show.
  #evaluatorsFrom = undefined;

  #send(event) {
    this.#actor.send(event);
  }

  // The page is in its phone layout in the phone preview (7.5, views only read it) or
  // below dock-desk's narrow-desk breakpoint (6.4), the same 45rem; the preview narrows
  // this view, so a resize is when to look again.
  #resized = new ResizeObserver(() => {
    const root = document.documentElement;
    const rem = parseFloat(getComputedStyle(root).fontSize) || 16;
    this.toggleAttribute("narrow", root.getAttribute("data-viewport") === "phone" || globalThis.innerWidth < 45 * rem);
    this.#placeBubble();
  });

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("keydown", this.#onNestedKey);
    // On the host before a touch begins: only a listener that is not passive may refuse a
    // move, and iOS decides that as the touch begins. A touch may end with no pointerup.
    this.addEventListener("touchmove", this.#touchmove, { passive: false });
    this.addEventListener("touchend", this.#touchend);
    this.addEventListener("touchcancel", this.#touchend);
    this.#resized.observe(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#resized.disconnect();
    this.removeEventListener("keydown", this.#onNestedKey);
    this.removeEventListener("touchmove", this.#touchmove);
    this.removeEventListener("touchend", this.#touchend);
    this.removeEventListener("touchcancel", this.#touchend);
    this.#cancelHold();
    clearTimeout(this.#saidTimer);
    clearTimeout(this.#glowTimer);
    this.#view?.destroy();
    this.#view = null;
  }

  // dock-desk's Ctrl+h/j/k/l and list-then-item focus a panel by its host: land in the text,
  // which holds the keyboard on an earlier day too.
  focus(options) {
    if (this.#view) this.#view.focus();
    else super.focus(options);
  }

  #nested() {
    return this.renderRoot?.querySelector("slot")?.assignedElements() ?? [];
  }

  // The keyboard handed to a nested view the way a container hands it to its child
  // (list-then-item): the view decides where in it the keyboard lands, and one that shows
  // nothing to land on (an earlier day without values) is passed over.
  #enter(from, dir) {
    const nested = this.#nested();
    for (let i = from; i >= 0 && i < nested.length; i += dir) {
      nested[i].focus({ from: dir > 0 ? "above" : "below", preventScroll: false });
      if (nested[i].matches(":focus-within")) return true;
    }
    return false;
  }

  // Back up to the start of the text's last line, in Vim's normal mode.
  #toText() {
    if (!this.#view) return false;
    const { doc } = this.#view.state;
    this.#view.focus();
    this.#view.dispatch({ selection: { anchor: doc.line(doc.lines).from }, scrollIntoView: true });
    return true;
  }

  // A j or k a nested view did not use bubbles out of it to here (12, "Vim keys"). Never
  // while typing in a box of it, where a letter is text.
  #onNestedKey = (event) => {
    if (event.defaultPrevented) return;
    const step = nestedStep(event, this.#actor.snapshot?.context.vimKeys === true);
    if (!step) return;
    const path = event.composedPath();
    const target = path[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName)) return;
    const at = this.#nested().findIndex((el) => path.includes(el));
    if (at < 0) return;
    const moved = step === "down" ? this.#enter(at + 1, 1) : this.#enter(at - 1, -1) || this.#toText();
    if (moved) event.preventDefault();
  };

  #extensions(editable, vimOn) {
    return [
      // j on the last line goes down onto the nested views (12, "Vim keys"). A keydown
      // handler at Prec.highest, because the Vim plugin's handler runs before every keymap.
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event, view) => {
            if (!this.#editableOn && this.#pastKeydown(event, view)) return true;
            if (this.#actor.snapshot?.context.vimKeys !== true) return false;
            const line = view.state.doc.lineAt(view.state.selection.main.head).number;
            // The text's very last line, blank or not: the editor kit stops on blank lines
            // at the end (10), so dd can remove them before j leaves the text.
            if (textEdge(event, getCM(view)?.state?.vim, line, { last: view.state.doc.lines }) !== "down") return false;
            if (!this.#enter(0, 1)) return false;
            event.preventDefault();
            return true;
          },
        }),
      ),
      ...baseExtensions({ vim: vimOn, quit: () => this.#send({ type: "_quit" }) }),
      paragraphs({ notList: leveled, box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      this.#editable.of(editability(editable)),
      levelField,
      levelTheme,
      markField,
      // A source link is drawn as a tag (the editor kit, 10), followed also on an earlier
      // day, which takes no typing; the link stays raw in the text, so serialize keeps it.
      sourceLinks({
        follow: (id) => this.#send({ type: "_follow", id }),
        icon: (into) => render(icon("link"), into),
        missing: this.#missing,
      }),
      // A web address is drawn as a link that opens in a new tab (the editor kit, 10),
      // also on an earlier day.
      webLinks(),
      // Hashtags and Jev's answers at the lines they name (the editor kit, 10), also on an
      // earlier day.
      hashtags({ known: (name) => this.#known.has(name) }),
      // The kit never opens it on an earlier day, which takes no typing.
      hashtagPicker({ tags: () => pickerTags(this.#actor.snapshot?.context.evaluators) }),
      lineMarks({ render: drawMarks }),
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
        // The cursor leaving a highlight takes its bubble with it, as long as the keyboard
        // is on the text; a bubble holding the keyboard stays.
        if (update.selectionSet && update.view.hasFocus && this.#active && markAt(this.#marks, update.state.selection.main.head)?.id !== this.#active) this.#closeBubble();
        if (update.docChanged || leveled) {
          const text = serialize(update.state.doc.toString(), levelsOf(update.state));
          if (text !== this.#shown) {
            this.#shown = text;
            this.#send({ type: "_edit", text });
          }
        }
        // After the text, so a line finished by Enter goes out with the save of that text.
        // A day put into the editor (setAllLevels) is not the user finishing a line.
        const loaded = update.transactions.some((t) => t.effects.some((e) => e.is(setAllLevels)));
        if (loaded || !this.#editableOn || !update.view.hasFocus || !(update.selectionSet || update.docChanged)) return;
        const lines = named(update.state.doc.toString(), finishedLines(update));
        if (lines.length) this.#send({ type: "_finished", lines });
      }),
      EditorView.domEventHandlers({
        // Leaving the box finishes every line.
        blur: (_e, view) => {
          const doc = view.state.doc.toString();
          if (this.#editableOn) this.#send({ type: "_finished", lines: named(doc, doc.split("\n").map((l) => l.trim()).filter(Boolean)) });
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
    const slot = this.renderRoot.querySelector("slot");
    if (slot && snapshot) {
      const want = [...this.children].filter((c) => flagShown(c.getAttribute("flag"), snapshot.context.hidden));
      const have = slot.assignedElements();
      if (want.length !== have.length || want.some((c, i) => c !== have[i])) slot.assign(...want);
    }
    const region = this.renderRoot.querySelector(".region");
    // Signed out the region is gone; an editor kept detached would still be what focus()
    // lands in.
    if (!region) {
      this.#view?.destroy();
      this.#view = null;
    }
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
      this.#checksFrom = undefined;
    }
    setVim(this.#view, vimKeys);
    const { checks } = snapshot.context;
    if (checks !== this.#checksFrom) {
      this.#checksFrom = checks;
      this.#known = knownTags(checks);
      refreshHashtags(this.#view);
      this.#view.dispatch({ effects: setLineMarks.of(lineMarksOf(checks)) });
    }
    const { evaluators } = snapshot.context;
    if (evaluators !== this.#evaluatorsFrom) {
      this.#evaluatorsFrom = evaluators;
      refreshHashtagPicker(this.#view);
    }
    const { notes, removed } = snapshot.context;
    if (notes !== this.#missingFrom?.notes || removed !== this.#missingFrom?.removed) {
      this.#missingFrom = { notes, removed };
      this.#missing = linkMissing(snapshot.context);
      missingLinks(this.#view, this.#missing);
    }
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
    this.#afterMarks(snapshot);
    this.#afterComment(snapshot.context);
  }

  // --- Highlights on an earlier day (13, Highlight) --------------------------------------

  // What is painted, and the bubble's highlight (the view's own UI state, as in the reader).
  #marks = [];
  #marksFrom = null;
  #active = null;
  // Whether the open bubble's highlight has been seen, because a new one's note arrives just
  // after the bubble opens, and whether its first button should take the keyboard.
  #activeSeen = false;
  #bubbleKeys = false;
  #bubbleShown = null;
  #lastReveal = 0;
  #lastGlow = 0;
  #glowing = null;
  #glowTimer = 0;
  #dayShown = null;
  // "text", "link", "note" or "passage" for a Copied or Added shown for a moment, "why" for
  // why Add to note cannot be pressed.
  #said = null;
  #why = "";
  #saidTimer = 0;
  #yAt = 0;
  #dAt = 0;

  // After the text is in the editor: paint the shown day's highlights and act on the
  // machine's one-shots, a glow only once its highlight is painted, since the day it is on
  // may arrive after the event.
  #afterMarks(snapshot) {
    const { context } = snapshot;
    const { day, editable } = shown(context.picture, selectedOf(context), context.fresh, Date.now());
    const doc = this.#view.state.doc.toString();
    if (day.id !== this.#dayShown) {
      this.#dayShown = day.id;
      this.#closeBubble(false);
      this.#dropFinger();
    }
    const key = `${day.id}|${this.#glowing}`;
    const from = this.#marksFrom;
    if (!from || from.highlights !== context.highlights || from.doc !== doc || from.key !== key) {
      this.#marksFrom = { highlights: context.highlights, doc, key };
      this.#marks = editable ? [] : marksOf(context.highlights, day.day, doc);
      this.#view.dispatch({ effects: setMarks.of(markSet(this.#marks, this.#glowing)) });
    }
    if (context.reveal && context.reveal.n !== this.#lastReveal) {
      this.#lastReveal = context.reveal.n;
      this.#openBubble(context.reveal.id);
    }
    const { glow } = context;
    const target = glow && glow.n !== this.#lastGlow ? this.#marks.find((m) => m.id === glow.id) : null;
    if (target) {
      this.#lastGlow = glow.n;
      clearTimeout(this.#glowTimer);
      this.#glowing = glow.id;
      this.#view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
      const ms = parseFloat(getComputedStyle(this).getPropertyValue("--duration-slide")) || 300;
      this.#glowTimer = setTimeout(() => {
        this.#glowing = null;
        this.requestUpdate();
      }, 3 * ms + 100);
      this.requestUpdate();
    }
    if (this.#active) {
      const held = context.highlights.some((h) => h.id === this.#active);
      if (held) this.#activeSeen = true;
      else if (this.#activeSeen) this.#closeBubble(false);
    }
  }

  #openBubble(id, keys = false) {
    this.#saveComment();
    this.#send({ type: "_commentClose" });
    this.#active = id;
    this.#activeSeen = false;
    this.#bubbleKeys = keys;
    this.#bubbleShown = null;
    this.#say(null);
    this.requestUpdate();
  }

  // `back` hands the keyboard to the text when the bubble held it.
  #closeBubble(back = true) {
    if (!this.#active) return;
    const held = this.renderRoot.querySelector(".bubble")?.matches(":focus-within");
    this.#saveComment();
    this.#send({ type: "_commentClose" });
    this.#active = null;
    this.requestUpdate();
    if (back && held) this.#view?.focus();
  }

  #saveComment() {
    const box = this.renderRoot?.querySelector(".bubble textarea");
    if (box) this.#send({ type: "_commentSave", body: box.value });
  }

  // Under the end of the passage, inside the page. The first time, in view, and with the
  // keyboard when Enter opened it.
  #placeBubble() {
    const bubble = this.renderRoot?.querySelector(".bubble");
    const mark = this.#marks.find((m) => m.id === this.#active);
    const page = this.renderRoot?.querySelector(".page");
    if (!bubble || !page || !mark || !this.#view) return;
    const end = this.#view.coordsAtPos(mark.to, -1);
    if (!end) return;
    const box = page.getBoundingClientRect();
    const x = Math.max(0, Math.min(page.clientWidth - bubble.offsetWidth, end.left - box.left - bubble.offsetWidth / 2));
    bubble.style.setProperty("--bx", `${Math.round(x)}px`);
    bubble.style.setProperty("--by", `${Math.round(end.bottom - box.top)}px`);
    if (this.#bubbleShown === this.#active) return;
    this.#bubbleShown = this.#active;
    bubble.scrollIntoView({ block: "nearest" });
    if (this.#bubbleKeys) bubble.querySelector("button")?.focus({ preventScroll: true });
  }

  #say(kind, ms = COPIED_MS) {
    clearTimeout(this.#saidTimer);
    this.#said = kind;
    this.requestUpdate();
    if (kind) {
      this.#saidTimer = setTimeout(() => {
        this.#said = null;
        this.requestUpdate();
      }, ms);
    }
  }

  // On the clipboard, inside the click or key handler, where the permission holds; a blocked
  // clipboard leaves the label as it was. A link is announced either way, so an editor's Vim
  // register still gets it.
  async #copyLink(mark) {
    const h = this.#actor.snapshot.context.highlights.find((x) => x.id === mark.id);
    try {
      await navigator.clipboard.writeText(sourceLink(mark.id, h?.quote ?? { exact: mark.exact }));
      this.#say("link");
    } catch {
      // no clipboard permission
    }
    this.#send({ type: "_copyLink", id: mark.id });
  }

  async #copyText(text, kind, announce) {
    try {
      await navigator.clipboard.writeText(text);
      this.#say(kind);
    } catch {
      // no clipboard permission
    }
    if (announce) this.#send({ type: "_copyText", text });
  }

  // A greyed Add to note still takes the press and says why, so a finger, which never sees a
  // tooltip, learns it too (Norman: feedback).
  #add(mark) {
    const add = addToNote(this.#actor.snapshot.context, mark.id);
    if (!add) return;
    if (!add.enabled) {
      this.#why = add.why ?? "";
      this.#say("why");
      return;
    }
    this.#send({ type: "_addToNote", id: mark.id });
    this.#say("note");
  }

  // Exits by Vim's own Escape, so its mode and its drawn selection end together.
  #leaveVisual(view) {
    const cm = getCM(view);
    if (cm?.state?.vim?.visualMode) Vim.handleKey(cm, "<Esc>", "user");
  }

  // The keys of an earlier day, true when one was used. See machine.js: pastKey.
  #pastKeydown(event, view) {
    const { head, empty, from, to } = view.state.selection.main;
    if (event.key === "Escape" && this.#active) {
      this.#closeBubble();
      return true;
    }
    if (this.#actor.snapshot?.context.vimKeys !== true) {
      if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return false;
      if (!empty) this.#send({ type: "_highlight", from, to, exact: true });
      else if (markAt(this.#marks, head)) this.#openBubble(markAt(this.#marks, head).id, true);
      else return false;
      return true;
    }
    const action = pastKey(event, getCM(view)?.state?.vim);
    if (action === "vim") return false;
    const mark = markAt(this.#marks, head);
    const yHeld = Date.now() - this.#yAt < CHORD_MS;
    const dHeld = Date.now() - this.#dAt < CHORD_MS;
    this.#yAt = 0;
    this.#dAt = 0;
    if (action === "global") {
      // Used here, so Vim leaves the document alone; the event goes on from the host, where
      // nothing has used it, to the global Undo, which reads it on the window.
      this.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, bubbles: true, composed: true, cancelable: true }));
    } else if (action === "yank") {
      const text = view.state.sliceDoc(from, to);
      this.#leaveVisual(view);
      if (text.trim()) this.#copyText(text, "passage", true);
    } else if (action === "make") {
      this.#send({ type: "_highlight", from, to, exact: true });
      this.#leaveVisual(view);
    } else if (action === "enter") {
      if (!mark) return false;
      this.#openBubble(mark.id, true);
    } else if (action === "y" && mark) {
      this.#openBubble(mark.id);
      if (yHeld) this.#copyText(mark.exact, "text", true);
      else {
        this.#yAt = Date.now();
        this.#copyLink(mark);
      }
    } else if (action === "a" && mark) {
      this.#openBubble(mark.id);
      this.#add(mark);
    } else if (action === "d" && mark) {
      if (dHeld) this.#send({ type: "_remove", id: mark.id });
      else this.#dAt = Date.now();
    }
    return true;
  }

  // --- A finger and the mouse on an earlier day -------------------------------------------

  // The same gesture as chat-thread's view.js, which also scrolls with a finger, copied
  // because components never import each other (11.2). Nothing refuses the touchstart, so the
  // browser keeps its scroll, its clicks and its focus; only once a hold has started does
  // #touchmove refuse the moves. A touch iOS ends anyway counts as a lift.
  #press = null;
  #holdTimer = 0;
  // From the hold until the lift: the doc as flat text, the word it started on, the [from, to)
  // painted, where the finger is.
  #finger = null;
  #lastPointer = null;

  #touchmove = (e) => {
    if (this.#finger && e.cancelable) e.preventDefault();
  };
  #touchend = (e) => {
    if (e.touches?.length) return;
    this.#cancelHold();
    if (this.#finger) this.#lift();
  };

  #cancelHold() {
    clearTimeout(this.#holdTimer);
    this.#holdTimer = 0;
  }

  // Whether the day shown takes highlights: not today's page, and not two copies waiting.
  get #past() {
    return Boolean(this.renderRoot.querySelector(".region.past")) && Boolean(this.#view);
  }

  // What the system would do with a finger's long press: a selection where the text can still
  // select (a touch screen with a fine main pointer), or a menu (Android). A mouse keeps both.
  #noNative = (e) => {
    if (this.#press?.onText) e.preventDefault();
  };

  // A finger or a pen, on the text, starts the wait for a hold; a second finger is not a
  // press, and is how a pinch begins.
  #pointerdown = (e) => {
    this.#lastPointer = e.pointerType;
    if (e.pointerType === "mouse" || (e.button != null && e.button !== 0)) return;
    if (this.#finger) return;
    this.#cancelHold();
    this.#press = null;
    if (!e.isPrimary) return;
    const path = e.composedPath();
    if (path.some((el) => el.classList?.contains("bubble"))) return;
    const onText = this.#past && path.includes(this.#view.contentDOM);
    this.#press = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, onText };
    if (onText) this.#holdTimer = setTimeout(() => this.#held(), HOLD_MS);
  };

  #pointermove = (e) => {
    const press = this.#press;
    if (!press || e.pointerId !== press.pointerId) return;
    if (this.#finger) return this.#follow(e.clientX, e.clientY);
    if (this.#holdTimer && Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > HOLD_SLOP) this.#cancelHold();
  };

  // The system took the touch, usually for a scroll: nothing waits for a hold any more, and a
  // passage being dragged is made as painted.
  #pointercancel = () => {
    this.#cancelHold();
    if (this.#finger) this.#lift();
    this.#press = null;
  };

  // A tap: on a highlight its bubble, anywhere else closes the bubble. A link keeps its own.
  #pointerup = (e) => {
    if (e.pointerType === "mouse") return;
    const press = this.#press;
    this.#cancelHold();
    if (this.#finger) return this.#lift();
    this.#press = null;
    if (!press || Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > HOLD_SLOP) return;
    this.#pressed(e.composedPath());
  };

  #pressed(path) {
    if (path.some((el) => el.classList?.contains("bubble")) || onLink(path)) return;
    const id = path.find((el) => el.classList?.contains("hl"))?.dataset.id;
    if (id) this.#openBubble(id);
    else this.#closeBubble();
  }

  // The mouse keeps the browser's selection. A drag that began on the text makes a highlight
  // as it ends, and the selection stays, so the browser's copy still copies it. The mouse
  // events a touch sends after it are not the mouse's. CodeMirror settles the selection in
  // its own mouseup on the document, so this reads it a moment later.
  #mousedown = (e) => {
    if (this.#lastPointer !== "mouse" || e.button !== 0 || !this.#past) return;
    const down = e.composedPath();
    if (down.some((el) => el.classList?.contains("bubble"))) return;
    const onText = down.includes(this.#view.contentDOM);
    window.addEventListener(
      "mouseup",
      (up) => {
        const path = up.composedPath();
        setTimeout(() => {
          if (!this.#view) return;
          const { empty, from, to } = this.#view.state.selection.main;
          if (onText && !empty) this.#send({ type: "_highlight", from, to, exact: false, open: true });
          else this.#pressed(path);
        }, 0);
      },
      { once: true },
    );
  };

  // The finger has rested: this press is no tap and no scroll any more.
  #held() {
    this.#holdTimer = 0;
    const press = this.#press;
    if (!press || !this.#view) return;
    const flat = this.#view.state.doc.toString();
    const at = this.#view.posAtCoords({ x: press.x0, y: press.y0 }, false);
    if (at == null || !flat.trim()) return;
    this.#closeBubble(false);
    const word = wordAround(flat, at);
    this.#finger = { flat, word, span: word, x: press.x0, y: press.y0, frame: 0 };
    this.#paintPassage(word[0], word[1]);
  }

  // A move may come many times a frame, and only the last before a frame can be seen.
  #follow(x, y) {
    const f = this.#finger;
    f.x = x;
    f.y = y;
    f.frame ||= requestAnimationFrame(() => this.#grow());
  }

  #grow() {
    const f = this.#finger;
    if (!f) return;
    cancelAnimationFrame(f.frame);
    f.frame = 0;
    const at = this.#view.posAtCoords({ x: f.x, y: f.y }, false);
    if (at == null) return;
    const span = fingerPassage(f.flat, f.word, at);
    if (span[0] === f.span[0] && span[1] === f.span[1]) return;
    f.span = span;
    this.#paintPassage(span[0], span[1]);
  }

  // Lifting makes what is painted, letter for letter, and its bubble opens with the comment
  // one press away; Undo takes it back (12, Undo).
  #lift() {
    this.#grow();
    const [from, to] = this.#finger.span;
    this.#dropFinger();
    this.#press = null;
    this.#send({ type: "_highlight", from, to, exact: true, open: true });
  }

  #dropFinger() {
    if (!this.#finger) return;
    cancelAnimationFrame(this.#finger.frame);
    this.#finger = null;
    this.#paintPassage(0, 0);
  }

  // The rectangles [from, to) of the doc takes on screen, in the page's own coordinates, so
  // they scroll with the text: one per run of text per line, from the text nodes alone, since
  // a range's own rectangles also hold the boxes of the lines it spans.
  #boxesOf(from, to) {
    const page = this.renderRoot.querySelector(".page");
    if (!page || from >= to) return [];
    const origin = page.getBoundingClientRect();
    const { contentDOM } = this.#view;
    const walker = document.createTreeWalker(contentDOM, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const boxes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // A widget's text (a link's tag, a line's marks) has no place in the doc.
      if (node.parentElement.closest('[contenteditable="false"]') !== contentDOM) continue;
      const start = this.#view.posAtDOM(node, 0);
      const a = Math.max(from, start);
      const b = Math.min(to, start + node.length);
      if (a >= b) continue;
      range.setStart(node, a - start);
      range.setEnd(node, b - start);
      for (const r of range.getClientRects()) {
        if (r.width > 0) boxes.push({ left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height });
      }
    }
    return boxes;
  }

  // The passage's tinted boxes. The text it names is for tests.
  #paintPassage(from, to) {
    const el = this.renderRoot.querySelector(".passage");
    if (!el) return;
    el.replaceChildren(
      ...this.#boxesOf(from, to).map((b) => {
        const box = document.createElement("i");
        box.style.setProperty("--px", `${b.left}px`);
        box.style.setProperty("--py", `${b.top}px`);
        box.style.setProperty("--pw", `${b.width}px`);
        box.style.setProperty("--ph", `${b.height}px`);
        return box;
      }),
    );
    el.dataset.text = from < to ? this.#view.state.sliceDoc(from, to) : "";
  }

  // Along the bubble with h, l or the arrows; Escape back to the text, or from the comment
  // box back to its Comment button, which keeps what was written.
  #bubbleKey = (e) => {
    const box = e.composedPath()[0]?.localName === "textarea" ? e.composedPath()[0] : null;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (box) {
        this.#saveComment();
        this.#send({ type: "_commentClose" });
        this.#commentBack = true;
        return;
      }
      this.#closeBubble();
      this.#view?.focus();
      return;
    }
    if (box) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, l: 1, h: -1 }[e.key];
    if (!step || e.ctrlKey || e.metaKey || e.altKey) return;
    const buttons = [...this.renderRoot.querySelectorAll(".bubble button")];
    buttons[(buttons.indexOf(e.composedPath()[0]) + step + buttons.length) % buttons.length]?.focus({ preventScroll: true });
    e.preventDefault();
    e.stopPropagation();
  };

  // Set when the comment box closes by Escape, which hands the keyboard to Comment.
  #commentBack = false;
  #boxFor = null;

  // The bubble for the open highlight. A press on it stays on it, and is not let move the
  // focus off the text, so a selection there can still be copied.
  #bubble(context) {
    const h = this.#active && context.highlights.find((x) => x.id === this.#active);
    if (!h) return nothing;
    const mark = this.#marks.find((m) => m.id === h.id) ?? { id: h.id, exact: h.quote?.exact ?? "" };
    const add = addToNote(context, h.id);
    const open = context.comment?.id === h.id;
    return html`
      <div class="bubble" role="group" aria-label="Highlight" @keydown=${this.#bubbleKey} @mousedown=${(e) => e.composedPath()[0]?.localName !== "textarea" && e.preventDefault()}>
        <button class="act copy" type="button" @click=${() => this.#copyText(mark.exact, "text", false)}>${this.#said === "text" ? "Copied" : "Copy"}</button>
        <button class="act copy-link" type="button" @click=${() => this.#copyLink(mark)}>${this.#said === "link" ? "Copied" : "Copy link"}</button>
        ${add
          ? html`<button class="act add" type="button" aria-disabled=${add.enabled ? "false" : "true"} title=${add.why ?? nothing} @click=${() => this.#add(mark)}>${this.#said === "note" ? "Added" : "Add to note"}</button>`
          : nothing}
        <button class="act comment" type="button" aria-expanded=${open} @click=${() => (open ? this.#commentToggle() : this.#send({ type: "_commentOpen", id: h.id }))}>Comment</button>
        <button
          class="act remove"
          type="button"
          @click=${() => {
            this.#view?.focus();
            this.#send({ type: "_remove", id: h.id });
          }}
        >
          Remove
        </button>
        ${open
          ? html`<textarea aria-label="Your comment on this passage" placeholder="Your comment on this passage" .value=${context.comment.body} @blur=${() => this.#saveComment()}></textarea>`
          : nothing}
      </div>
    `;
  }

  #commentToggle() {
    this.#saveComment();
    this.#send({ type: "_commentClose" });
  }

  // A comment box just opened gets the keyboard; one closed by Escape hands it to Comment.
  // Placed last, because the box changes the bubble's size.
  #afterComment(context) {
    const id = context.comment?.id ?? null;
    if (id !== this.#boxFor) {
      this.#boxFor = id;
      if (id) this.renderRoot.querySelector(".bubble textarea")?.focus({ preventScroll: true });
    }
    if (this.#commentBack && !id) {
      this.#commentBack = false;
      this.renderRoot.querySelector(".bubble .comment")?.focus({ preventScroll: true });
    }
    this.#placeBubble();
  }

  // What the editor shows: the text being typed on the open day, else the day's text;
  // typing only on the open day and not while two copies wait to be settled.
  get #content() {
    const { context } = this.#actor.snapshot;
    const { day, editable } = shown(context.picture, selectedOf(context), context.fresh, Date.now());
    const conflict = conflictOn(context.conflict, day);
    return { text: editable && context.draft ? context.draft.text : day.text, editable: editable && !conflict };
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    // Signed out nothing of the account shows (machine.js: showing), and with no slot drawn
    // the view nested under the text is not shown either.
    const account = showing(snapshot.context);
    if (account === "wait") return nothing;
    if (account === "sign-in") return html`<p class="empty page">Sign in to write in your journal.</p>`;
    if (snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty page">The journal is unavailable.</p>`;
    const { context } = snapshot;
    const { picture, fresh, vimKeys } = context;
    // The journal's announcement at 2:00 (shownDay) is what redraws a new page then.
    const { day, editable } = shown(picture, selectedOf(context), fresh, Date.now());
    const conflict = conflictOn(context.conflict, day);
    // The slot under the text takes the view a page nests in the entry, as chat-thread
    // holds chat-input; it sits in the page so it scrolls with the day it is about.
    return html`
      <div class="frame">
        <div
          class="scroll"
          @pointerdown=${this.#pointerdown}
          @pointermove=${this.#pointermove}
          @pointerup=${this.#pointerup}
          @pointercancel=${this.#pointercancel}
          @mousedown=${this.#mousedown}
          @contextmenu=${this.#noNative}
          @selectstart=${this.#noNative}
        >
          <div class="page ${this.#holds ? "holds" : ""}">
            <header>
              <h2>${longDate(day.day)}</h2>
            </header>
            ${conflict ? this.#conflict(conflict) : nothing}
            <div class="region ${editable && !conflict ? "open" : conflict ? "" : "past"}"></div>
            <slot @slotchange=${this.#slotted}></slot>
            <div class="passage" aria-hidden="true"></div>
            ${this.#bubble(context)}
          </div>
        </div>
        ${this.#said === "passage" ? html`<div class="said" role="status">Copied</div>` : this.#said === "why" ? html`<div class="said" role="status">${this.#why}</div>` : nothing}
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

  // The buttons go with the conflict, so the keyboard goes where focus() puts it.
  async #keep(type) {
    this.#send({ type });
    await this.updateComplete;
    this.focus();
  }

  // Both copies, each kept in one step, on any day.
  #conflict(c) {
    return html`
      <section class="conflict" aria-label="Two copies of this entry">
        <p>${c.twice ? "This day was written twice." : "This entry was also written on another device."} Keep one copy.</p>
        <div class="copies">
          <div class="copy mine">
            <h3>${c.mineLabel}</h3>
            <pre>${c.mine}</pre>
            <button type="button" class="keep-mine" @click=${() => this.#keep("_keepMine")}>Keep this copy</button>
          </div>
          <div class="copy theirs">
            <h3>${c.theirsLabel}</h3>
            <pre>${c.theirs}</pre>
            <button type="button" class="keep-theirs" @click=${() => this.#keep("_keepTheirs")}>Keep this copy</button>
          </div>
        </div>
      </section>
    `;
  }
}

customElements.define("journal-entry", JournalEntry);
