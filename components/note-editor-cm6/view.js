import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, StateField, StateEffect, RangeSetBuilder, Prec } from "@codemirror/state";
import { EditorView, Decoration, keymap, drawSelection } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { vim, Vim } from "@replit/codemirror-vim";
import { machine, parseBody, serialize, aboutTitleOf } from "./machine.js";
import saved from "./events/note.saved.json" with { type: "json" };
import opened from "./events/note.opened.json" with { type: "json" };
import refused from "./events/note.refused.json" with { type: "json" };

// The CM6 member of the note-editor role (7.3). The fact stays one plain markdown
// string; the document the user edits is marker-free, and per-line level lives in a
// StateField, so Vim motions never step over an invisible "#". parseBody/serialize
// (machine.js) are the only bridge between the two forms; this file adds the CM6
// half: the level field, the theme, and Vim's level maps.

// The pinned note's id, kept across reloads (D10): the view's own UI state under a key
// named for the role, so this editor and note-editor share it and a composer swap keeps
// the pin. Read and written through the machine's input so the machine stays importable
// in Node. Wrapped like settings/store.js so a browser refusing storage reads null and
// drops the write.
const KEY = "note-editor.pinned";
const pinStore = {
  recall() {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  remember(id) {
    try {
      if (id) localStorage.setItem(KEY, id);
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the pin lives only for this page.
    }
  },
};

// The titles of subjects this browser has seen (12), kept beside the pin under a key
// named for the role, so both members share them and a composer swap keeps them (3.1).
// "kind:id" -> title. Wrapped like pinStore: a browser refusing storage, or a malformed
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

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's flash window;
// the token is the one clock, the same --duration-undo note-list reads for its undo bar.
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// Body carries no decoration, so a new line defaults to Body for free (§2 of the
// note-editor-cm6 plan). Only Title/Heading/Subheading lines get a line decoration.
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
    deco = deco.map(tr.changes); // a level rides with its line across split/join/delete
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
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// The line levels of a state, in document order, for serialize().
function levelsOf(state) {
  const levels = new Array(state.doc.lines).fill("body");
  for (const it = state.field(levelField).iter(); it.value; it.next()) {
    const level = it.value.spec?.attributes?.["data-level"];
    if (level) levels[state.doc.lineAt(it.from).number - 1] = level;
  }
  return levels;
}

// Vim normal-mode level maps, registered once at import. The leader is "\" (Vim's
// default), mapped literally — more reliably honoured than the <leader> token.
// defineAction (not Vim.map, which is key->key only) lets a mapped key reach the live
// EditorView through cm.cm6 and dispatch a StateEffect.
Vim.defineAction("noteSetLevel", (cm, args) => {
  cm.cm6?.dispatch({ effects: setLevel.of(args.level) });
});
for (const [key, level] of [["\\1", "title"], ["\\2", "heading"], ["\\3", "subheading"], ["\\0", "body"]]) {
  Vim.mapCommand(key, "action", "noteSetLevel", { level }, { context: "normal" });
}

const levelTheme = EditorView.theme({
  "&": { height: "100%", color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "var(--leading-normal)", overflow: "auto" },
  // The caret at column 0 is drawn 0.6px left of the text, so .cm-content needs a
  // sliver of side padding or the scroller's overflow clip eats it (an `o` cursor).
  ".cm-content": { caretColor: "var(--color-accent)", padding: "0 var(--space-2xs)" },
  ".cm-line": { fontSize: "var(--text-body)", padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
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

// The fat cursor. The vim plugin ships its own Prec.highest theme for it, so this
// one both raises precedence and marks the competing properties !important to win
// regardless of stylesheet order. Focused, it fills with the accent; unfocused, it
// is hollowed from the inside with an inset shadow, which no edge clip can reach —
// the plugin draws an outline outside an absolutely positioned span, and Safari
// clips its top and left. The plugin's own colours are also not tokens.
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

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // The flash window comes from --duration-undo, read off the host so a stylesheet or
    // a test can set it; the machine only ever sees the number (importable in Node).
    const flashMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        mint: ulid,
        focus: () => this.host.focusEditor?.(),
        // The attributes are parsed by the time hostConnected runs, so the actor is
        // born knowing whether it follows the selection (6.4) and the stage (D5).
        follows: this.host.follows,
        subjecting: this.host.subject,
        recall: pinStore.recall,
        remember: pinStore.remember,
        recallTitles: titleStore.recall,
        rememberTitles: titleStore.remember,
        aboutNew: this.host.aboutNew,
        flashMs,
      },
      events: { "note.saved": saved, "note.opened": opened, "note.refused": refused },
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

class NoteEditorCm6 extends LitElement {
  static properties = {
    height: { type: String, reflect: true },
    follows: { type: Boolean, reflect: true },
    // Whether this editor follows the stage and offers the pin (D5). Reflected so the
    // page's bare `subject` reads as true and the manifest attribute is visible. Off is
    // exactly today's behaviour.
    subject: { type: Boolean, reflect: true },
    // Whether an editor holding a new note names the subject on the stage in the About
    // line (12): what the note will be linked to at its first save. Reflected so the
    // page's bare `about-new` reads as true and the manifest attribute is visible.
    aboutNew: { type: Boolean, attribute: "about-new", reflect: true },
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
    /* The pin: a toggle, muted while following, accent when pinned, its border flashing
       danger when it refused a change (D7). One icon, sized by the caption type. */
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
    .pin:hover:not(:disabled):not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    .pin[aria-pressed="true"] {
      color: var(--color-accent);
    }
    .pin.flashing {
      border-color: var(--color-danger);
    }
    .pin:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .pin:focus-visible {
      outline: var(--focus-ring);
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
    .region:focus-within {
      outline: var(--focus-ring);
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
    .status {
      margin: 0;
    }
    .levels {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .level {
      white-space: nowrap;
    }
    .level.cur {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
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

  #extensions() {
    return [
      vim(),
      // Vim mode hides the native selection (its own theme paints ::selection
      // transparent), so the visual-mode range is only visible through CM6's own
      // selection layer; without this it selects but shows nothing.
      drawSelection(),
      levelField,
      levelTheme,
      fatCursorTheme,
      history(),
      keymap.of(historyKeymap),
      EditorView.lineWrapping,
      EditorView.updateListener.of(this.#onUpdate),
      EditorView.domEventHandlers({ blur: () => this.#actor.send({ type: "_blurred" }) }),
    ];
  }

  #onUpdate = (update) => {
    const leveled = update.transactions.some((t) => t.effects.some((e) => e.is(setLevel) || e.is(setAllLevels)));
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

  firstUpdated() {
    const parent = this.renderRoot.querySelector(".region");
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
    const snapshot = this.#actor.snapshot;
    if (!snapshot || !this.#view) return;
    const { body } = snapshot.context;
    if (body === this.#shown) return; // never the user's own keystroke (set #shown first)
    const { doc, levels } = parseBody(body);
    this.#shown = body;
    this.#view.dispatch({
      changes: { from: 0, to: this.#view.state.doc.length, insert: doc },
      effects: setAllLevels.of(levels),
    });
  }

  focusEditor() {
    this.#view?.focus();
  }

  disconnectedCallback() {
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

  // The level keys, shown so a hidden Vim map becomes a visible signifier; the
  // caret's own level is marked so the map doubles as feedback about where you are.
  #levelHint() {
    const keys = [
      ["\\1", "title", "Title"],
      ["\\2", "heading", "Heading"],
      ["\\3", "subheading", "Subheading"],
      ["\\0", "body", "Body"],
    ];
    return html`<span class="levels">
      ${keys.map(
        ([key, level, label]) =>
          html`<span class=${level === this.#level ? "level cur" : "level"}
            ><kbd>${key}</kbd> ${label}</span
          >`,
      )}
    </span>`;
  }

  #togglePin() {
    this.#actor.send({ type: "_togglePin" });
  }

  // The About line (12): computed by the machine's pure aboutTitleOf, so the rule — a
  // saved note's link, or the stage's subject on a new note when about-new is on — is
  // tested in Node and the view only renders the result.
  #aboutTitle(snapshot) {
    return aboutTitleOf(snapshot);
  }

  // The header shown only while following the stage (D7): the About line, and the pin
  // toggle. The pin is disabled while the editor holds no note; its label names the
  // action for assistive tech, its colour follows the state (accent when pinned), and
  // its border flashes danger after it refuses a change.
  #header(aboutTitle, pinned, flashing, id) {
    return html`
      <div class="header">
        <span class="about">${aboutTitle ? html`About: ${aboutTitle}` : nothing}</span>
        <button
          class="pin ${flashing ? "flashing" : ""}"
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

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { subjecting, pinned, flashing, id } = snapshot.context;
    const aboutTitle = this.#aboutTitle(snapshot);
    // .region has no bindings, so Lit never touches CM6's subtree on re-render.
    return html`
      <div class="editor">
        ${subjecting ? this.#header(aboutTitle, pinned, flashing, id) : nothing}
        <div class="region" role="textbox" aria-label="Note"></div>
        <div class="footer">
          <p class="status">${this.#status(snapshot)}</p>
          ${this.#levelHint()}
        </div>
      </div>
    `;
  }
}

customElements.define("note-editor-cm6", NoteEditorCm6);
