import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { EditorState, Prec, Annotation } from "@codemirror/state";
import { EditorView, placeholder } from "@codemirror/view";
import { Vim, getCM } from "@replit/codemirror-vim";
import { baseExtensions, setVim, toRegister } from "editor";
import { machine, writable, shownValues, earlierDays, changedLine, dayName, dateOf } from "./machine.js";
import saved from "./events/values.saved.json" with { type: "json" };

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
  });
const nameTheme = boxTheme(true);
const meaningTheme = boxTheme(false);

const HINTS = { name: "A value, such as Being a present parent", meaning: "An example of living it (optional)" };
const LABELS = { name: "Value", meaning: "Example" };

// A box's text set from the draft rather than typed, which is not sent back as an edit.
const fromDraft = Annotation.define();

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
      events: { "values.saved": saved },
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
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding-top: var(--space-md);
      border-top: var(--border-width) solid var(--color-border);
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
  `;

  #actor = new ActorController(this);

  // Where the keyboard goes once the next render lands, as a selector. Kept here because
  // the elements exist only after render.
  #focusNext = null;

  // The editors of the open sheet by key ("<id>:<field>"), each with the region it is
  // drawn in; and what the last render asked of each box.
  #boxes = new Map();
  #wanted = new Map();

  updated() {
    this.#syncBoxes();
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
  #keys(key) {
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (event.isComposing) return false;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            this.#next(key);
            return true;
          }
          if (event.key !== "Escape") return false;
          event.stopPropagation();
          const mode = this.#boxes.get(key)?.vimOn ? getCM(view)?.state?.vim : null;
          if (mode?.insertMode || mode?.visualMode) return false;
          event.preventDefault();
          this.#done();
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
      this.#keys(key),
      ...baseExtensions({ vim: vimOn }),
      spec.field === "name" ? nameTheme : meaningTheme,
      placeholder(HINTS[spec.field]),
      EditorView.contentAttributes.of({ "aria-label": LABELS[spec.field] }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromDraft))) return;
        this.#actor.send({ type: "_edit", id: spec.id, field: spec.field, value: update.state.doc.toString() });
      }),
      // Which row the keyboard went to tells the machine whether this row was left.
      EditorView.domEventHandlers({
        blur: (event) => this.#actor.send({ type: "_blur", id: spec.id, to: event.relatedTarget?.closest?.(".row")?.dataset.id ?? null }),
      }),
    ];
  }

  // Editors are made when a row is drawn and dropped when it goes; one kept follows its
  // draft text (a change from the fact while nothing waits to save) and Vim.
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
        box = { region, vimOn };
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
      const doc = box.view.state.doc.toString();
      if (doc !== spec.text) box.view.dispatch({ changes: { from: 0, to: doc.length, insert: spec.text }, annotations: fromDraft.of(true) });
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

  // Today's sheet opens with the keyboard in the first name; an earlier day's, which
  // takes no typing, on Close.
  #open() {
    const context = this.#actor.snapshot.context;
    this.#send({ type: "_open" }, writable(context) ? ".box[data-key]" : ".sheet .close");
  }

  #done() {
    this.#send({ type: "_done" }, ".card, .new");
  }

  // A page that nests the sheet hands it the keyboard by its host (journal-entry, with
  // Vim keys): folded, on the card or the Write your values row; open, on the first box,
  // in Vim's normal mode, or on a button of a sheet that is only read.
  focus(options) {
    const first = this.renderRoot?.querySelector(".box[data-key]");
    const box = first && this.#boxes.get(first.dataset.key);
    if (box) return box.view.focus();
    const button = this.renderRoot?.querySelector("section > .card, section > .new, .sheet button");
    if (button) button.focus(options);
    else super.focus(options);
  }

  #add() {
    this.#actor.send({ type: "_add" });
    this.#focusNext = `.box[data-key="${this.#actor.snapshot?.context.drafts.at(-1)?.id}:name"]`;
    this.requestUpdate();
  }

  #remove(id) {
    this.#send({ type: "_remove", id }, `.row[data-id="${id}"] .undo`);
  }

  #undo(id) {
    this.#send({ type: "_undo", id }, `.box[data-key="${id}:name"]`);
  }

  #box(draft, field) {
    const key = `${draft.id}:${field}`;
    this.#wanted.set(key, { id: draft.id, field, text: draft[field] });
    return html`<div class="box" data-key=${key} data-field=${field}></div>`;
  }

  // A value to read: its name and sentence as text.
  #readRow(v, extra = nothing, state = "") {
    return html`<div class="row ${state}" data-id=${v.id}>
      <div class="fields">
        <p class="name">${v.name || "—"}</p>
        ${v.meaning ? html`<p class="meaning">${v.meaning}</p>` : nothing}
      </div>
      ${extra}
    </div>`;
  }

  #row(context, draft) {
    if (context.removing.includes(draft.id)) {
      return this.#readRow(
        draft,
        html`<button class="undo" type="button" @click=${() => this.#undo(draft.id)}>Undo</button><span class="drain"></span>`,
        "removing",
      );
    }
    return html`<div class="row" data-id=${draft.id}>
      <div class="fields">${this.#box(draft, "name")} ${this.#box(draft, "meaning")}</div>
      <button class="remove" type="button" aria-label="Remove ${draft.name.trim() || "this value"}" title="Remove" @click=${() => this.#remove(draft.id)}>
        ${icon("x")}
      </button>
    </div>`;
  }

  #foot(context, { about = nothing, back = false } = {}) {
    const read = !writable(context);
    return html`<div class="foot">
      <div class="about">${about}</div>
      <div class="buttons">
        ${back ? html`<button type="button" class="back" @click=${() => this.#send({ type: "_back" }, ".sheet .close, .sheet .done")}>Back</button>` : nothing}
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
    let body;
    if (context.viewing) {
      const { kind, day, values } = context.viewing;
      body = html`<p class="caption">${kind === "current" ? "Today's values" : `Your values on ${dayName(day, today)}`}</p>
        <div class="rows">${values.length ? values.map((v) => this.#readRow(v)) : html`<p class="empty">No values.</p>`}</div>
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
          ${write ? context.drafts.map((d) => this.#row(context, d)) : context.drafts.map((v) => this.#readRow(v))}
        </div>
        ${write
          ? html`<button type="button" class="new" @click=${() => this.#add()}><span class="plus">${icon("plus")}</span>New value</button>`
          : nothing}
        ${this.#foot(context, { about })}`;
    }
    return html`<div class="sheet ${writable(context) ? "" : "read"}" role="group" aria-label="Your values" @keydown=${keydown}>${body}</div>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    this.#wanted.clear();
    if (snapshot.matches("loading")) return nothing;
    const failed = snapshot.matches("failed");
    const names = shownValues(context).map((v) => v.name.trim() || "A value");
    // An earlier day without values has nothing to show.
    if (!failed && !context.open && !names.length && !writable(context)) return nothing;
    let body;
    if (failed) body = html`<p class="empty">Your values are unavailable.</p>`;
    else if (context.open) body = this.#sheet(context);
    else if (names.length) body = html`<button type="button" class="card" @click=${() => this.#open()}>${names.join(" · ")}</button>`;
    else body = html`<button type="button" class="new" @click=${() => this.#open()}><span class="plus">${icon("plus")}</span>Write your values</button>`;
    return html`<section aria-labelledby="heading">
      <h3 id="heading">Your values</h3>
      ${body}
    </section>`;
  }
}

customElements.define("values-sheet", ValuesSheet);
