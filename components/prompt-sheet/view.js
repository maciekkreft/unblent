import { LitElement, html, css, nothing, render } from "lit";
import { mount, unmount, ask, send } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Prec, Annotation } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, writable, rowAction, rowTarget, boxEdge, chooserOf, setLine, moreLine, occasionOf, cardOf, changedSince, offTopic } from "./machine.js";
import saved from "./events/prompt-sheet.saved.json" with { type: "json" };
import add from "./commands/add.json" with { type: "json" };

// The view sits in journal-entry's slot, under the day's text inside its scrolling page (the
// product page nests it), so it scrolls with the day it is about.

// Each answer box is a CodeMirror editor built on the editor kit (10), so it takes Vim's keys
// when the "Vim keys" preference (12) is on and makes paragraphs on Enter. Its frame is drawn
// around it by .box, so the theme draws none; only what differs from the kit's theme.
const boxTheme = EditorView.theme({
  "&": { flex: "1" },
  ".cm-content": {
    padding: "var(--space-xs) var(--space-sm)",
    minHeight: "calc(var(--text-body) * var(--leading-normal) * 1.5)",
  },
});

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

// A box on a day that cannot be written is shown, not edited; it takes no focus, so the
// sheet's own keydown folds it on Escape.
const readOnly = (read) => (read ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [placeholder("Write your answer")]);

const OFF_TOPIC = "This may answer something other than the question";

// Which sheets are unfolded, per day, kept across reloads (3.1): the view's own UI state under
// a key named for the component, so it follows the browser, not the account, and losing it
// only folds the sheets. Only the days still listed are kept, so the key does not grow. A
// browser refusing storage reads nothing and drops the write.
const KEY = "prompt-sheet.unfolded";
const readAll = () => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
};
const unfolded = {
  read(day) {
    const ids = readAll()[day];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  },
  write(day, ids) {
    try {
      const all = readAll();
      if (JSON.stringify(all[day] ?? []) === JSON.stringify(ids)) return;
      if (ids.length) all[day] = ids;
      else delete all[day];
      if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all));
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the sheets fold on reload.
    }
  },
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
        send: (target, name, payload) => send(machine, target, name, payload),
        mint: ulid,
        now: () => Date.now(),
        unfolded,
      },
      events: { "prompt-sheet.saved": saved },
      commands: { add },
    });
    this.subscription = this.actor.subscribe((snapshot) => {
      // Only once the day's sheets are in, so the empty start does not forget them. A sheet
      // still showing the sets is not kept, so it is not reopened.
      if (snapshot.matches("ready"))
        unfolded.write(snapshot.context.day, snapshot.context.drafts.filter((d) => d.setId).map((d) => d.id));
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

class PromptSheet extends LitElement {
  static styles = css`
    :host {
      display: block;
      container-type: inline-size;
      color: var(--color-body);
    }
    /* The page around spaces what it holds with a gap, so a day without a sheet must take no
       place in it at all. */
    :host([idle]) {
      display: none;
    }
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
    svg {
      display: block;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .row {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    /* The folded card: read, not typed into. The press target is a button, so what it holds
       is spans, drawn as blocks. */
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: var(--space-sm) var(--space-md);
      border-color: var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-canvas-soft);
      color: var(--color-ink);
      overflow-wrap: anywhere;
    }
    .card:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
    }
    .card span {
      display: block;
    }
    .card .name {
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
    }
    .card .prompt {
      color: var(--color-body-mid);
    }
    .card .answer {
      white-space: pre-line;
    }
    .note {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .sheet {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-md);
    }
    .head > span:first-child {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .title {
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .based,
    .occasion {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .occasion {
      white-space: nowrap;
    }
    .lead {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .sets {
      display: flex;
      flex-direction: column;
    }
    .sets .cap {
      padding: var(--space-xs) var(--space-sm) 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .set,
    .more {
      display: flex;
      justify-content: space-between;
      gap: var(--space-md);
      text-align: left;
      padding: var(--space-xs) var(--space-sm);
      border: none;
      border-radius: var(--radius-sm);
      background: none;
      font-size: var(--text-body);
    }
    .set:hover,
    .set:focus,
    .more:hover,
    .more:focus {
      background: var(--color-surface-hover);
      box-shadow: none;
    }
    .set > span:first-child {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .set small {
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .more {
      justify-content: flex-start;
      align-items: center;
      gap: var(--space-xs);
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .field > b {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .field > small {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* CodeMirror owns everything inside .box's editor; the frame is drawn here, around it. */
    .box {
      position: relative;
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
    .sheet.read .box {
      border-color: transparent;
      cursor: default;
    }
    /* The mark stands at the end of the box, outside the text, which keeps room for it. */
    .box.marked .cm-content {
      padding-right: calc(var(--text-body) + var(--space-sm) * 2);
    }
    .fit {
      position: absolute;
      top: var(--space-xs);
      right: var(--space-sm);
      display: grid;
      place-items: center;
      height: calc(var(--text-body) * var(--leading-normal));
      font-size: var(--text-body);
      color: var(--color-mute);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    .foot {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .buttons {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
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
    /* A narrow page, such as a phone: larger targets for a finger. */
    @container (width < 30rem) {
      .buttons button {
        padding: var(--space-sm) var(--space-md);
      }
      .set,
      .more {
        padding-block: var(--space-sm);
      }
    }
  `;

  #actor = new ActorController(this);

  // Where the keyboard goes once the next render lands. Kept here because the elements exist
  // only after render.
  #focusNext = null;
  // The last add the keyboard was given for.
  #landed = 0;
  // Whether the keyboard was inside before this render, and whether the last thing the user
  // did here was a press: after a press nothing moves, as a keyboard moved onto text would
  // come up on a phone.
  #holding = false;
  #byPress = false;

  constructor() {
    super();
    this.addEventListener("keydown", () => { this.#byPress = false; }, true);
    this.addEventListener("pointerdown", () => { this.#byPress = true; }, true);
  }

  // The editors of the open sheets by key ("<id>:<index>"), each with the region it is drawn
  // in; and what the last render asked of each box.
  #boxes = new Map();
  #wanted = new Map();

  willUpdate() {
    this.#holding = this.matches(":focus-within");
    const snapshot = this.#actor.snapshot;
    this.toggleAttribute("idle", !snapshot || !(snapshot.matches("failed") || this.#items(snapshot.context).length));
  }

  updated() {
    this.#syncBoxes();
    const context = this.#actor.snapshot?.context;
    if (context && context.landing !== this.#landed) {
      this.#landed = context.landing;
      this.#focusNext = `.row[data-id="${context.drafts.at(-1)?.id}"]`;
    }
    if (this.#focusNext) {
      const target = this.renderRoot.querySelector(this.#focusNext);
      this.#focusNext = null;
      const box = [...this.#boxes.values()].find((b) => b.region === target);
      if (box) this.#focusBox(box);
      else if (target?.classList.contains("row")) this.#focusRow(target);
      else target?.focus();
    }
    // What held the keyboard went (a removal, an Undo, a chooser closed).
    if (this.#holding && !this.#byPress && !this.matches(":focus-within")) this.#actor.send({ type: "_handBack" });
  }

  // A box given the keyboard by a pick or from a card takes it in Vim's insert mode when Vim
  // keys is on, so the first key typed is text. The editor takes focus without scrolling, and
  // the sheet may stand below the fold.
  #focusBox(box) {
    box.view.focus();
    box.region.scrollIntoView({ block: "nearest" });
    const cm = box.vimOn ? getCM(box.view) : null;
    if (cm && cm.state?.vim?.insertMode !== true) Vim.handleKey(cm, "i", "user");
  }

  // Escape (12): with Vim on, an Escape in insert or visual mode is Vim's, back to normal
  // mode; any other folds the sheet like Done. A keydown handler at Prec.highest, not a
  // keymap, because the Vim plugin's handler runs before every keymap and would take it.
  #keys(id, index) {
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (this.#boxEdge(event, view, `${id}:${index}`)) return true;
          if (event.key !== "Escape" || event.isComposing) return false;
          event.stopPropagation();
          const box = this.#boxes.get(`${id}:${index}`);
          const mode = box?.vimOn ? getCM(view)?.state?.vim : null;
          if (mode?.insertMode || mode?.visualMode) return false;
          event.preventDefault();
          this.#done(id);
          return true;
        },
      }),
    );
  }

  // j on a box's last line or k on its first, in Vim's normal mode, moves on to the next or
  // the previous box of the sheet, and past its last or first box to the row after or before
  // it (12, "Vim keys").
  #boxEdge(event, view, key) {
    const box = this.#boxes.get(key);
    if (!box?.vimOn) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const step = boxEdge(event, getCM(view)?.state?.vim, line, { first: 1, last: view.state.doc.lines });
    if (!step) return false;
    const row = box.region.closest(".row");
    const regions = [...row.querySelectorAll(".box[data-key]")];
    const next = regions[regions.indexOf(box.region) + (step === "down" ? 1 : -1)];
    const to = next && this.#boxes.get(next.dataset.key);
    if (to) this.#landIn(to, step === "down" ? "first" : "last");
    else this.#leaveRow(row, step);
    event.preventDefault();
    return true;
  }

  // Past a row's ends the keyboard goes on to the next row, and past the list's ends the move
  // is the page's (journal-entry moves on from there); a key in a box is the box's text to
  // the page, so it is handed on from the host.
  #leaveRow(row, step) {
    const rows = this.#rows();
    const at = rows.indexOf(row) + (step === "down" ? 1 : -1);
    if (at < 0 || at >= rows.length) {
      this.dispatchEvent(new KeyboardEvent("keydown", { key: step === "down" ? "ArrowDown" : "ArrowUp", bubbles: true, composed: true }));
    } else this.#focusRow(rows[at], step === "down" ? "first" : "last");
  }

  // A box takes the keyboard in Vim's normal mode, at the start of its first line or its last.
  #landIn(box, edge) {
    const { doc } = box.view.state;
    box.view.focus();
    const n = edge === "first" ? 1 : doc.lines;
    box.view.dispatch({ selection: { anchor: doc.line(n).from }, scrollIntoView: true });
  }

  #rows() {
    return [...(this.renderRoot?.querySelectorAll(".list > .row") ?? [])];
  }

  // The stops of a chooser, in the order shown: its sets, "N more sets", then its button.
  #stops(row) {
    return [...row.querySelectorAll(".set, .more, .buttons button")];
  }

  // A card takes the keyboard itself; a chooser on its first set (its last stop, coming from
  // below); an open sheet in its first box (its last, coming from below), or on Close when
  // its boxes take no keyboard.
  #focusRow(row, edge = "first") {
    const card = row.querySelector(".card");
    if (card) return card.focus();
    if (row.querySelector(".chooser")) {
      const stops = this.#stops(row);
      return (edge === "first" ? stops[0] : stops.at(-1))?.focus();
    }
    const regions = [...row.querySelectorAll(".box[data-key]")];
    const region = edge === "first" ? regions[0] : regions.at(-1);
    const box = region && this.#boxes.get(region.dataset.key);
    if (box && !box.readOn) this.#landIn(box, edge);
    else row.querySelector(".close, .done")?.focus();
  }

  // A page that nests the sheets hands them the keyboard by the host (journal-entry, with Vim
  // keys): the first row, or the last when it comes from below. With no row it stays where it
  // was, so the entry passes this view over.
  focus(options) {
    const rows = this.#rows();
    const row = options?.from === "below" ? rows.at(-1) : rows[0];
    if (row) this.#focusRow(row, options?.from === "below" ? "last" : "first");
  }

  // The list's keys (12, "Vim keys"), on a card, a set or a sheet's button; a box decides its
  // own (#boxEdge). gg is two presses, so a first g waits a moment for the second. In a
  // chooser a move steps through its stops first.
  #gAt = 0;
  #rowKey = (event) => {
    if (event.defaultPrevented) return;
    const target = event.composedPath()[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName)) return;
    const context = this.#actor.snapshot?.context;
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const action = rowAction(event, context?.vimKeys === true, afterG);
    this.#gAt = action === "g" ? Date.now() : 0;
    if (!action) return;
    if (action === "g") return event.preventDefault();
    if (action === "add") {
      if (!writable(context) || !this.#actor.snapshot.matches("ready")) return;
      event.preventDefault();
      return this.#add();
    }
    const rows = this.#rows();
    const at = rows.findIndex((r) => r.contains(target));
    const row = rows[at];
    if (row?.querySelector(".chooser") && (action === "up" || action === "down")) {
      const stops = this.#stops(row);
      const to = rowTarget(action, stops.indexOf(target), stops.length);
      if (typeof to === "number") {
        event.preventDefault();
        return stops[to].focus();
      }
    }
    const to = rowTarget(action, at, rows.length);
    if (to === null || to === "leave") return;
    event.preventDefault();
    this.#focusRow(rows[to], action === "up" ? "last" : "first");
  };

  #extensions(key, spec, vimOn) {
    const { id, index } = spec;
    return [
      this.#keys(id, index),
      ...baseExtensions({ vim: vimOn }),
      paragraphs({ box: (into, ticked) => render(ticked ? icon("check-square") : icon("square"), into) }),
      boxTheme,
      this.#boxes.get(key).read.of(readOnly(spec.read)),
      EditorView.contentAttributes.of({ "aria-label": spec.prompt }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#actor.send({ type: "_edit", id, index, value: update.state.doc.toString() });
      }),
      EditorView.domEventHandlers({ blur: () => this.#actor.send({ type: "_blur", id }) }),
    ];
  }

  // Editors are made when a sheet opens and dropped when it folds; an open one follows its
  // draft text (a change from the fact while nothing waits to save) and Vim. Lit draws the
  // list by position, so when a sheet above folds, an editor moves to the region now drawn
  // for it rather than being made again.
  #syncBoxes() {
    const vimOn = this.#actor.snapshot?.context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll(".box[data-key]")].map((r) => [r.dataset.key, r]));
    for (const [key, box] of this.#boxes) {
      const region = regions.get(key);
      if (!region) {
        box.view.destroy();
        this.#boxes.delete(key);
      } else if (region !== box.region || box.view.dom.parentNode !== region) {
        region.prepend(box.view.dom);
        box.region = region;
      }
    }
    for (const [key, region] of regions) {
      const spec = this.#wanted.get(key);
      if (!spec) continue;
      let box = this.#boxes.get(key);
      if (!box) {
        box = { region, vimOn, read: new Compartment(), readOn: spec.read };
        this.#boxes.set(key, box);
        box.view = new EditorView({
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there, so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: spec.text, extensions: this.#extensions(key, spec, vimOn) }),
        });
        region.prepend(box.view.dom);
        continue;
      }
      const effects = [];
      box.vimOn = vimOn;
      setVim(box.view, vimOn);
      // A sheet open as the journal's day ends at 2:00 turns read only in place.
      if (box.readOn !== spec.read) {
        box.readOn = spec.read;
        effects.push(box.read.reconfigure(readOnly(spec.read)));
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

  #send(event, focus) {
    this.#focusNext = focus;
    this.#actor.send(event);
    this.requestUpdate();
  }

  #add() {
    this.#actor.send({ type: "_add" });
    this.#focusNext = `.row[data-id="${this.#actor.snapshot?.context.drafts.at(-1)?.id}"]`;
    this.requestUpdate();
  }

  // An earlier day's boxes take no keyboard, so its sheet opens with it on Close.
  #open(id) {
    const writing = writable(this.#actor.snapshot.context);
    this.#send({ type: "_open", id }, writing ? `.box[data-key="${id}:0"]` : `.row[data-id="${id}"] .close`);
  }

  #done(id) {
    this.#send({ type: "_done", id }, `.card[data-id="${id}"]`);
  }

  // After a key the keyboard moves on to the row after the sheet; with none it goes to + Add
  // sheet, as updated() sees it went. After a press nothing moves.
  #delete(id) {
    const rows = this.#rows();
    const next = rows[rows.findIndex((row) => row.dataset.id === id) + 1];
    this.#send({ type: "_delete", id }, next && !this.#byPress ? `.row[data-id="${next.dataset.id}"]` : null);
  }

  #pick(id, setId) {
    this.#send({ type: "_pick", id, setId }, `.box[data-key="${id}:0"]`);
  }

  // The keyboard lands on the first set "N more sets" showed.
  #more(id) {
    const n = chooserOf(this.#actor.snapshot.context, id).shown.length;
    this.#send({ type: "_more", id }, `.row[data-id="${id}"] .set:nth-of-type(${n + 1})`);
  }

  #card(context, r) {
    const { name, shown, more } = cardOf(r);
    return html`<button type="button" class="card" data-id=${r.id} @click=${() => this.#open(r.id)}>
      <span class="name">${name}</span>
      ${shown.map((a) => html`<span><span class="prompt">${a.prompt}</span><span class="answer">${a.answer}</span></span>`)}
      ${more ? html`<span class="note">${moreLine(more, "more answer", "more answers")}</span>` : nothing}
      ${!writable(context) && changedSince(context, r) ? html`<span class="note">The set has changed since. This day keeps the prompts it was answered with.</span>` : nothing}
    </button>`;
  }

  // Escape on a button closes the sheet like Done; the key is taken so nothing around it acts
  // too. The boxes decide their own Escape, for Vim (#keys).
  #escape(id) {
    return (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      this.#done(id);
    };
  }

  #chooser(context, draft) {
    const { shown, more } = chooserOf(context, draft.id);
    return html`<div class="sheet chooser" role="group" aria-label="Journal prompts" @keydown=${this.#escape(draft.id)}>
      <p class="lead">Choose a set to answer today.</p>
      <div class="sets">
        ${shown.length ? html`<span class="cap">Your sets</span>` : html`<p class="empty">You have no prompt sets.</p>`}
        ${shown.map(
          (s) => html`<button type="button" class="set" data-set=${s.id} @click=${() => this.#pick(draft.id, s.id)}>
            <span><span>${s.name}</span><small>${setLine(s)}</small></span>
            ${s.occasion ? html`<span class="occasion">${s.occasion}</span>` : nothing}
          </button>`,
        )}
        ${more ? html`<button type="button" class="more" @click=${() => this.#more(draft.id)}>${moreLine(more, "more set", "more sets")}</button>` : nothing}
      </div>
      <div class="foot">
        <p class="note">Change your sets in Settings › Prompts.</p>
        <div class="buttons">
          <button type="button" class="delete" @click=${() => this.#delete(draft.id)}>Remove from this day</button>
        </div>
      </div>
    </div>`;
  }

  // One box as the render wants it; the editor inside it is made in updated(). A press on the
  // prompt puts the keyboard in its box, as a label does for a field.
  #box(context, draft, index) {
    const key = `${draft.id}:${index}`;
    const { prompt, answer } = draft.answers[index];
    const read = !writable(context);
    this.#wanted.set(key, { id: draft.id, index, prompt, read, text: answer });
    const off = offTopic(context, draft.id, index);
    const focus = () => {
      const box = this.#boxes.get(key);
      if (box && !read) this.#focusBox(box);
    };
    return html`<div class="field">
      <b @click=${focus}>${prompt}</b>
      <div class="box ${off ? "marked" : ""}" data-key=${key}>
        ${off ? html`<span class="fit" role="img" aria-label=${OFF_TOPIC} title=${OFF_TOPIC}>${icon("question")}</span>` : nothing}
      </div>
      ${off ? html`<small>${prompt}</small>` : nothing}
    </div>`;
  }

  #sheet(context, draft) {
    const read = !writable(context);
    const record = context.sheets.find((r) => r.id === draft.id);
    const occasion = occasionOf(context, draft.setId);
    return html`<div class="sheet ${read ? "read" : ""}" role="group" aria-label=${draft.setName} @keydown=${this.#escape(draft.id)}>
      <div class="head">
        <span>
          <span class="title">${draft.setName}</span>
          ${draft.basedOn ? html`<span class="based">Based on ${draft.basedOn}</span>` : nothing}
        </span>
        ${occasion ? html`<span class="occasion">${occasion}</span>` : nothing}
      </div>
      ${draft.answers.map((_, i) => this.#box(context, draft, i))}
      ${read && record && changedSince(context, record) ? html`<p class="note">The set has changed since. This day keeps the prompts it was answered with.</p>` : nothing}
      <div class="buttons">
        ${read
          ? html`<button type="button" class="close" @click=${() => this.#done(draft.id)}>Close</button>`
          : html`<button type="button" class="delete" @click=${() => this.#delete(draft.id)}>Remove from this day</button>
              <button type="button" class="done" @click=${() => this.#done(draft.id)}>Done</button>`}
      </div>
    </div>`;
  }

  // A new sheet joins the list where it will stand once kept, last, so the sheet keeps its
  // place (and the keyboard) when the fact first announces it.
  #items({ sheets, drafts }) {
    return [...sheets, ...drafts.filter((d) => !sheets.some((r) => r.id === d.id))];
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const failed = snapshot.matches("failed");
    const { context } = snapshot;
    this.#wanted.clear();
    const items = this.#items(context);
    const draftOf = (r) => context.drafts.find((d) => d.id === r.id);
    if (!items.length && !failed) return nothing;
    const item = (r) => {
      const draft = draftOf(r);
      const body = !draft ? this.#card(context, r) : draft.setId ? this.#sheet(context, draft) : this.#chooser(context, draft);
      return html`<div class="row" data-id=${r.id}><h3>Journal prompts</h3>${body}</div>`;
    };
    return html`<section tabindex="-1" aria-label="Journal prompts">
      ${failed ? html`<p class="empty">Journal prompts are unavailable.</p>` : nothing}
      ${items.length ? html`<div class="list" @keydown=${this.#rowKey}>${items.map(item)}</div>` : nothing}
    </section>`;
  }
}

customElements.define("prompt-sheet", PromptSheet);
