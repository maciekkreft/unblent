import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, parseMarkdown, pieces, marks, toCriticMarkup } from "./machine.js";
import saved from "./events/redline.saved.json" with { type: "json" };

// The gap between a fragment's last line and the comment box under it, in px; the
// popover is placed in JS, so the value is not a style (7.4 covers styles).
const POPOVER_GAP = 6;
const COPIED_MS = 1500;

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo window;
// the token is the one clock, shared with the bar's animation.
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, undoMs },
      events: { "redline.saved": saved },
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

class RedlineEditor extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    /* The scrolling page; focusable, so a paste and the keys land here. */
    .page {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      outline: none;
    }
    /* The column the text sits in: wide enough for a hand-wrapped line of about a
       hundred characters to stay one line. Also the popover's positioning context, so
       the box scrolls with the fragment it belongs to. */
    .sheet {
      position: relative;
      box-sizing: border-box;
      max-width: calc(var(--space-2xl) * 14);
      margin: 0 auto;
      padding: var(--space-lg) var(--space-lg) var(--space-xl);
      color: var(--color-ink);
      line-height: var(--leading-normal);
      overflow-wrap: anywhere;
    }
    article {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    article p,
    article ul,
    article ol,
    article blockquote,
    article pre,
    article hr {
      margin: 0;
    }
    article h1,
    article h2,
    article h3,
    article h4,
    article h5,
    article h6 {
      margin: var(--space-sm) 0 0;
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
    }
    article h1 {
      font-size: var(--text-heading);
    }
    article h2 {
      font-size: var(--text-subtitle);
    }
    article h3,
    article h4,
    article h5,
    article h6 {
      font-size: var(--text-body);
    }
    article ul,
    article ol {
      padding-left: var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    article blockquote {
      padding-left: var(--space-sm);
      border-left: var(--border-width) solid var(--color-border-strong);
      color: var(--color-body);
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    article pre {
      padding: var(--space-sm);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      overflow-wrap: normal;
    }
    article pre code {
      font-family: inherit;
    }
    article code {
      font-family: var(--font-mono);
      font-size: var(--text-sm);
    }
    article p code,
    article li code,
    article td code,
    article th code,
    article h1 code,
    article h2 code,
    article h3 code {
      padding: 0 var(--space-2xs);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
    }
    article hr {
      border: 0;
      border-top: var(--border-width) solid var(--color-border);
    }
    .table {
      overflow-x: auto;
    }
    table {
      border-collapse: collapse;
      font-size: var(--text-sm);
    }
    th,
    td {
      border: var(--border-width) solid var(--color-border);
      padding: var(--space-xs) var(--space-sm);
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--color-canvas-soft);
      font-weight: var(--weight-semibold);
    }
    /* A commented fragment: the marker yellow books use (7.4). The one being written
       carries the accent underline; one in its undo window fades. */
    mark {
      background: var(--color-highlight);
      color: inherit;
      border-radius: var(--radius-sm);
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
      cursor: pointer;
    }
    mark.open {
      box-shadow: inset 0 calc(var(--border-width) * -2) 0 var(--color-accent);
    }
    mark.removing {
      opacity: 0.4;
    }
    /* The comment box: under the fragment's last line, placed by --bx/--by set in JS. */
    .popover {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--bx, 0) var(--by, 0);
      z-index: 1;
      box-sizing: border-box;
      width: calc(var(--space-2xl) * 5);
      max-width: 100%;
      display: flex;
      align-items: flex-start;
      gap: var(--space-2xs);
      padding: var(--space-xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
    }
    /* Commenting is for a mouse (the Redline app is a desk tool); a phone reads. */
    @media (pointer: coarse) {
      .popover {
        display: none;
      }
    }
    /* One line to start, growing with what is typed (#fit sets --h). */
    .popover textarea {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      height: var(--h, auto);
      overflow: hidden;
      resize: none;
      border: 0;
      outline: none;
      background: transparent;
      font: inherit;
      font-size: var(--text-sm);
      line-height: var(--leading-normal);
      color: var(--color-ink);
      padding: var(--space-2xs) var(--space-xs);
    }
    /* The empty page: one box that takes the paste. */
    .empty {
      box-sizing: border-box;
      max-width: calc(var(--space-2xl) * 14);
      margin: 0 auto;
      padding: var(--space-xl) var(--space-lg);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-sm);
      text-align: center;
    }
    .drop {
      box-sizing: border-box;
      width: 100%;
      height: calc(var(--space-2xl) * 3);
      resize: none;
      border: var(--border-width) dashed var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-canvas-soft);
      color: var(--color-body);
      font: inherit;
      padding: var(--space-md);
      text-align: center;
      caret-color: transparent;
    }
    .drop::placeholder {
      color: var(--color-body-mid);
    }
    .drop:focus-visible {
      outline: var(--focus-ring);
    }
    .notice {
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .notice.refused {
      color: var(--color-danger);
    }
    /* The bar over the text: what to do with the whole of it. At the top, so the
       window's fixed bottom controls (the phone preview switch) never cover it. */
    .bar {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-md);
      border-bottom: var(--border-width) solid var(--color-border);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .bar .spacer {
      flex: 1;
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
      outline: var(--focus-ring);
    }
    button.quiet {
      border-color: transparent;
      background: transparent;
      color: var(--color-body);
    }
    button.quiet:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    button.primary {
      background: var(--color-ink);
      border-color: var(--color-ink);
      color: var(--color-canvas);
    }
    button.undo {
      border-color: transparent;
      background: transparent;
      color: var(--color-accent);
    }
    button.remove {
      display: inline-flex;
      border-color: transparent;
      background: transparent;
      color: var(--color-mute);
      padding: var(--space-2xs);
    }
    button.remove:hover {
      color: var(--color-danger);
    }
  `;

  #actor = new ActorController(this);
  #pointer = null;
  #focused = null;
  #copied = null;
  #copiedTimer;
  #source = null;
  #blocks = [];

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#copiedTimer);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("marking")) return this.#marking(snapshot);
    return this.#empty(snapshot);
  }

  // --- The empty page ---------------------------------------------------------------

  #empty(snapshot) {
    const clearing = snapshot.matches("clearing");
    const refused = snapshot.matches({ empty: "refused" });
    return html`
      <div class="page">
        <div class="empty">
          <textarea
            class="drop"
            aria-label="Paste a text to review"
            placeholder="Paste a text to review: ⌘V here, or the Paste button"
            @beforeinput=${(e) => {
              // The box only takes a paste or a drop; typing in it does nothing.
              if (e.inputType !== "insertFromPaste" && e.inputType !== "insertFromDrop") e.preventDefault();
            }}
            @paste=${(e) => {
              e.preventDefault();
              this.#actor.send({ type: "_pasted", text: e.clipboardData?.getData("text/plain") ?? "" });
            }}
            @input=${(e) => {
              const text = e.currentTarget.value;
              e.currentTarget.value = "";
              this.#actor.send({ type: "_pasted", text });
            }}
          ></textarea>
          <button @click=${() => this.#paste()}>Paste</button>
          ${refused ? html`<div class="notice refused" role="status">The browser did not allow it. Press ⌘V in the box instead.</div>` : nothing}
          ${clearing
            ? html`<div class="notice" role="status">Text cleared. <button class="undo" @click=${() => this.#actor.send({ type: "_undoClear" })}>Undo</button></div>`
            : nothing}
        </div>
      </div>
    `;
  }

  // The Paste button reads the clipboard in the click itself; a refusal is said.
  #paste() {
    const read = navigator.clipboard?.readText?.();
    if (!read) {
      this.#actor.send({ type: "_pasteRefused" });
      return;
    }
    read.then(
      (text) => this.#actor.send({ type: "_pasted", text }),
      () => this.#actor.send({ type: "_pasteRefused" }),
    );
  }

  // --- The text under review ----------------------------------------------------------

  #marking(snapshot) {
    const { context } = snapshot;
    // Parsed once per text, not per keystroke in the comment box.
    if (context.redline.text !== this.#source) {
      this.#source = context.redline.text;
      this.#blocks = parseMarkdown(this.#source);
    }
    this.#marks = marks(context);
    this.#context = context;
    const count = context.redline.comments.length;
    const removing = [...context.discarding].at(-1);
    const draft = snapshot.matches({ marking: "commenting" }) ? context.draft : null;
    return html`
      <div class="bar">
        <button class="quiet" @click=${() => this.#actor.send({ type: "_clear" })}>New text</button>
        ${removing
          ? html`<span>Comment removed.</span><button class="undo" @click=${() => this.#actor.send({ type: "_undo", id: removing })}>Undo</button>`
          : nothing}
        <span class="spacer"></span>
        <span class="count">${count === 1 ? "1 comment" : `${count} comments`}</span>
        <button class="primary copy" @click=${() => this.#copy()}>${this.#copied ?? "Copy with comments"}</button>
      </div>
      <div
        class="page"
        tabindex="0"
        @pointerdown=${(e) => (this.#pointer = e.pointerType)}
        @pointerup=${(e) => this.#pointerup(e)}
        @keydown=${(e) => this.#keydown(e)}
      >
        <div class="sheet">
          <article>${this.#blocks.map((b) => this.#block(b))}</article>
          ${draft ? this.#popover(draft, context) : nothing}
        </div>
      </div>
    `;
  }

  #marks = [];
  #context = null;

  #popover(draft, context) {
    const saved = context.redline.comments.some((c) => c.id === draft.id);
    return html`
      <div class="popover" @mousedown=${(e) => e.target.localName !== "textarea" && e.preventDefault()}>
        <textarea
          rows="1"
          aria-label="Comment"
          placeholder="What should change here?"
          .value=${draft.text}
          @input=${(e) => {
            this.#fit(e.currentTarget);
            this.#actor.send({ type: "_typed", text: e.currentTarget.value });
          }}
          @keydown=${(e) => {
            e.stopPropagation();
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
              e.preventDefault();
              this.#close();
            }
          }}
        ></textarea>
        <button
            class="remove"
            aria-label="Remove comment"
            title="Remove comment"
            @click=${() => {
              this.#actor.send({ type: saved ? "_remove" : "_closed", id: draft.id });
              this.#focusPage();
            }}
          >
            ${icon("trash-simple")}
          </button>
      </div>
    `;
  }

  #block(block) {
    switch (block.type) {
      case "heading":
        return this.#heading(block);
      case "list": {
        const items = block.items.map((item) => html`<li>${item.blocks.map((b) => this.#block(b))}</li>`);
        return block.ordered ? html`<ol start=${block.start}>${items}</ol>` : html`<ul>${items}</ul>`;
      }
      case "quote":
        return html`<blockquote>${block.blocks.map((b) => this.#block(b))}</blockquote>`;
      case "code":
        return html`<pre><code>${block.lines.map((l, k) => [k ? "\n" : "", this.#run(l.value, l.s)])}</code></pre>`;
      case "rule":
        return html`<hr />`;
      case "table":
        return html`<div class="table">
          <table>
            <thead><tr>${block.head.map((cell) => html`<th>${this.#inline(cell)}</th>`)}</tr></thead>
            <tbody>${block.rows.map((row) => html`<tr>${row.map((cell) => html`<td>${this.#inline(cell)}</td>`)}</tr>`)}</tbody>
          </table>
        </div>`;
      default:
        return html`<p>${this.#inline(block.inline)}</p>`;
    }
  }

  #heading(block) {
    const inner = this.#inline(block.inline);
    switch (block.level) {
      case 1:
        return html`<h1>${inner}</h1>`;
      case 2:
        return html`<h2>${inner}</h2>`;
      case 3:
        return html`<h3>${inner}</h3>`;
      case 4:
        return html`<h4>${inner}</h4>`;
      case 5:
        return html`<h5>${inner}</h5>`;
      default:
        return html`<h6>${inner}</h6>`;
    }
  }

  #inline(nodes) {
    return nodes.map((node) => {
      switch (node.type) {
        case "break":
          return html`<br />`;
        case "code":
          return html`<code>${this.#run(node.value, node.s)}</code>`;
        case "strong":
          return html`<strong>${this.#inline(node.inline)}</strong>`;
        case "em":
          return html`<em>${this.#inline(node.inline)}</em>`;
        default:
          return this.#run(node.value, node.s);
      }
    });
  }

  // One text run: a span per piece carrying its source offset, a commented piece inside
  // its mark. Every run is an escaped Lit text node; nothing pasted becomes HTML.
  #run(value, s) {
    const draftId = this.#context.draft?.id;
    return pieces(value, s, this.#marks).map((p) => {
      const span = html`<span data-s=${p.s}>${p.text}</span>`;
      if (!p.id) return span;
      const cls = p.id === draftId ? "open" : this.#context.discarding.has(p.id) ? "removing" : "";
      return html`<mark data-id=${p.id} class=${cls}>${span}</mark>`;
    });
  }

  // --- Gestures -------------------------------------------------------------------------

  #pointerup(e) {
    if (this.#pointer !== "mouse") return;
    if (e.composedPath().some((el) => el.classList?.contains("popover"))) return;
    if (this.#sendSelection()) return;
    const mark = e.composedPath().find((el) => el.localName === "mark");
    if (mark) {
      this.#actor.send({ type: "_opened", id: mark.dataset.id });
      return;
    }
    this.#close();
  }

  // A key typed over a selection starts its comment with that key; Escape closes.
  #keydown(e) {
    if (e.key === "Escape") {
      this.#close();
      return;
    }
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (this.#sendSelection(e.key)) e.preventDefault();
  }

  #close() {
    this.#actor.send({ type: "_closed" });
    this.#focusPage();
  }

  #focusPage() {
    this.renderRoot.querySelector(".page")?.focus({ preventScroll: true });
  }

  // The selection as source offsets, sent as _selected; false when there is none. The
  // machine decides whether it may become a comment (white space, overlap).
  #sendSelection(text) {
    const range = this.#selectionRange();
    if (!range) return false;
    const start = this.#offsetOf(range, "start");
    const end = this.#offsetOf(range, "end");
    if (start == null || end == null || end <= start) return false;
    this.#clearSelection();
    this.#actor.send({ type: "_selected", start, end, ...(text ? { text } : {}) });
    return true;
  }

  // A boundary of the range as an offset into the source. Inside a text run it is
  // exact; on an element (a line break, a list item, a cell edge) it is the edge of the
  // first or last run the range touches.
  #offsetOf(range, edge) {
    const node = edge === "start" ? range.startContainer : range.endContainer;
    const offset = edge === "start" ? range.startOffset : range.endOffset;
    const span = node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
    if (span?.dataset?.s != null) return Number(span.dataset.s) + offset;
    const spans = [...this.renderRoot.querySelectorAll("article [data-s]")].filter((el) => range.intersectsNode(el));
    if (!spans.length) return null;
    if (edge === "start") return Number(spans[0].dataset.s);
    const last = spans[spans.length - 1];
    return Number(last.dataset.s) + last.textContent.length;
  }

  // The current selection inside the text as a DOM range, or null. getComposedRanges
  // reaches across the shadow boundary (WebKit); a scoped getSelection is the fallback
  // (Chromium). A collapsed range is no selection.
  #selectionRange() {
    const doc = document.getSelection();
    if (doc && typeof doc.getComposedRanges === "function") {
      const [range] = doc.getComposedRanges({ shadowRoots: [this.renderRoot] });
      if (range && !(range.startContainer === range.endContainer && range.startOffset === range.endOffset)) return this.#live(range);
    }
    const scoped = this.renderRoot.getSelection?.();
    if (scoped && !scoped.isCollapsed && scoped.rangeCount) return scoped.getRangeAt(0);
    return null;
  }

  // A StaticRange as a Range, for intersectsNode.
  #live(range) {
    if (typeof range.intersectsNode === "function") return range;
    const live = document.createRange();
    live.setStart(range.startContainer, range.startOffset);
    live.setEnd(range.endContainer, range.endOffset);
    return live;
  }

  #clearSelection() {
    document.getSelection()?.removeAllRanges?.();
    this.renderRoot.getSelection?.()?.removeAllRanges?.();
  }

  #copy() {
    const { redline } = this.#context;
    const flash = (label) => {
      this.#copied = label;
      this.requestUpdate();
      clearTimeout(this.#copiedTimer);
      this.#copiedTimer = setTimeout(() => {
        this.#copied = null;
        this.requestUpdate();
      }, COPIED_MS);
    };
    const write = navigator.clipboard?.writeText?.(toCriticMarkup(redline.text, marks(this.#context)));
    if (!write) {
      flash("Could not copy");
      return;
    }
    write.then(
      () => flash("Copied"),
      () => flash("Could not copy"),
    );
  }

  // --- After each render ------------------------------------------------------------------

  firstUpdated() {
    this.#focusPage();
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    if (snapshot?.matches("empty") || snapshot?.matches("clearing")) {
      const drop = this.renderRoot.querySelector(".drop");
      if (drop && this.#focused !== "drop" && this.renderRoot.activeElement == null) {
        drop.focus({ preventScroll: true });
      }
      this.#focused = "drop";
      return;
    }
    const draft = snapshot?.matches({ marking: "commenting" }) ? snapshot.context.draft : null;
    if (!draft) {
      if (this.#focused !== null && this.#focused !== "drop") this.#focused = null;
      if (this.#focused === "drop") {
        this.#focused = null;
        this.#focusPage();
      }
      return;
    }
    this.#positionPopover(draft.id);
    // A newly opened comment takes the keys, its caret at the end of what it holds.
    if (this.#focused !== draft.id) {
      this.#focused = draft.id;
      const box = this.renderRoot.querySelector(".popover textarea");
      if (box) {
        this.#fit(box);
        box.focus({ preventScroll: true });
        box.setSelectionRange(box.value.length, box.value.length);
      }
    }
  }

  // The comment box as tall as what it holds; set as a custom property (7.4).
  #fit(box) {
    box.style.setProperty("--h", "auto");
    box.style.setProperty("--h", `${box.scrollHeight}px`);
  }

  // Under the fragment's last line, aligned with that line's start, clamped inside the
  // sheet; placed with custom properties so no length is a literal style (7.4).
  #positionPopover(id) {
    const popover = this.renderRoot.querySelector(".popover");
    const sheet = this.renderRoot.querySelector(".sheet");
    const pieces = this.renderRoot.querySelectorAll(`mark[data-id="${id}"]`);
    if (!popover || !sheet || !pieces.length) return;
    const last = pieces[pieces.length - 1];
    const rects = last.getClientRects();
    const line = rects[rects.length - 1] ?? last.getBoundingClientRect();
    const box = sheet.getBoundingClientRect();
    const width = popover.offsetWidth;
    let x = line.left - box.left;
    x = Math.max(0, Math.min(Math.max(0, box.width - width), x));
    const y = line.bottom - box.top + POPOVER_GAP;
    popover.style.setProperty("--bx", `${Math.round(x)}px`);
    popover.style.setProperty("--by", `${Math.round(y)}px`);
  }
}

customElements.define("redline-editor", RedlineEditor);
