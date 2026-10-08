import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine } from "./machine.js";
import picked from "./events/book.picked.json" with { type: "json" };
import selected from "./events/book.selected.json" with { type: "json" };
import discarded from "./events/book.discarded.json" with { type: "json" };
import renamed from "./events/book.renamed.json" with { type: "json" };

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo
// window; the token is the one clock, shared with the bar's animation. Duplicated
// from note-list rather than shared: a component may not import another.
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
    // The undo window comes from --duration-undo, read off the host so a stylesheet
    // or a test can set it; the machine only ever sees the number (importable in Node).
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        undoMs,
      },
      events: { "book.picked": picked, "book.selected": selected, "book.discarded": discarded, "book.renamed": renamed },
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

// An epub file the browser can pass to `books`: a minted id, its name and size, and a
// tab-local object URL the fact fetches once and revokes. The machine never sees a
// File or a URL (it stays importable in Node); the view makes them here.
const asPicked = (file) => ({ id: ulid(), name: file.name, size: file.size, url: URL.createObjectURL(file) });

class BookShelf extends LitElement {
  // The one attribute the tag understands (D11): present means a book's title can be
  // edited in place. Reflected so a page's bare `renames` reads as true and the
  // manifest attribute is visible. Off leaves the shelf exactly as it was.
  static properties = {
    renames: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    /* The whole shelf is the drop target; a drag over it lifts the ground so the
       affordance is unmistakable (Norman: visible signifier, immediate feedback). */
    .shelf {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-md);
    }
    .shelf.dragover {
      background: var(--color-accent-subtle);
      outline: var(--border-width) dashed var(--color-accent);
      outline-offset: calc(-1 * var(--space-xs));
    }
    /* The one standing action: add a book. A labelled button, not a bare icon, so it
       reads as what it does. */
    .head {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      margin-bottom: var(--space-md);
    }
    .add {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      appearance: none;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      color: var(--color-body);
      font: inherit;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      padding: var(--space-xs) var(--space-md);
      cursor: pointer;
    }
    .add:hover {
      background: var(--color-surface-hover);
    }
    .add:focus-visible {
      outline: var(--focus-ring);
    }
    .add svg {
      display: block;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-2xl) * 2), 1fr));
      gap: var(--space-md);
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .tile {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      cursor: pointer;
      border-radius: var(--radius-sm);
      user-select: none;
      -webkit-user-select: none;
    }
    .tile:focus-visible {
      outline: var(--focus-ring);
      outline-offset: var(--space-2xs);
    }
    /* The cover: a 2:3 card, the image cropped to it, a titled placeholder when a
       book has none so a tile is never a blank rectangle. */
    .cover {
      position: relative;
      aspect-ratio: 2 / 3;
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card);
      background: var(--color-canvas-soft);
      overflow: hidden;
    }
    .cover img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    /* The placeholder cover names the book, centred, so it still says what it is. */
    .placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: var(--space-sm);
      text-align: center;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* The open book carries the one visible selection: a solid accent ring, thick
       enough to read at a glance against a cover or a placeholder (Norman: visible
       signifier). --color-accent-selection is a text-selection tint, too faint here. */
    .tile[aria-selected="true"] .cover {
      outline: var(--space-2xs) solid var(--color-accent);
      outline-offset: var(--space-2xs);
    }
    .title {
      font-size: var(--text-sm);
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .author {
      font-size: var(--text-caption);
      color: var(--color-mute);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .progress {
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    /* The per-tile tools (edit, trash) sit on the cover, signifiers shown on hover or
       focus; on a coarse pointer (no hover) they stand, since there is nothing to
       hover with. */
    .actions {
      position: absolute;
      inset-block-start: var(--space-2xs);
      inset-inline-end: var(--space-2xs);
      display: flex;
      gap: var(--space-2xs);
      visibility: hidden;
    }
    .tool {
      display: inline-flex;
      appearance: none;
      border: 0;
      padding: var(--space-2xs);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      color: var(--color-body-mid);
      cursor: pointer;
      font: inherit;
      box-shadow: var(--shadow-card);
    }
    .tool svg {
      display: block;
    }
    .tile:hover .actions,
    .tile:focus-within .actions {
      visibility: visible;
    }
    .edit:hover {
      color: var(--color-accent);
    }
    .bin:hover {
      color: var(--color-danger);
    }
    @media (hover: none) {
      .actions {
        visibility: visible;
      }
    }
    /* Editing a title in place: the field takes the title's row, holding the current
       text, selected, so the whole model is edit-here (Norman: one conceptual model,
       forgiveness — Escape or an empty save restores). */
    .title-input {
      font: inherit;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-accent);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs);
      width: 100%;
      box-sizing: border-box;
    }
    .title-input:focus-visible {
      outline: var(--focus-ring);
    }
    /* A book counting down to its delete: the cover dims under an Undo, with a bar
       draining the window, both reading --duration-undo so they cannot disagree. */
    .discarding .over {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-xs);
      background: var(--color-canvas);
      color: var(--color-body);
      font-size: var(--text-sm);
    }
    .undo {
      appearance: none;
      border: 0;
      background: none;
      font: inherit;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-accent);
      cursor: pointer;
    }
    .bar {
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
    /* An import in flight: the cover names the file and says it is being added, so the
       gesture has immediate feedback before the server answers. */
    .adding .cover {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-xs);
      padding: var(--space-sm);
      text-align: center;
    }
    .adding .cover .spinner {
      width: var(--space-lg);
      height: var(--space-lg);
      border-radius: 50%;
      border: var(--border-width) solid var(--color-border);
      border-top-color: var(--color-accent);
      animation: spin var(--duration-slide) linear infinite;
    }
    .adding .cover .label {
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    @keyframes spin {
      to {
        transform: rotate(1turn);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .adding .cover .spinner {
        animation: none;
      }
    }
    .empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-2xl) var(--space-md);
      text-align: center;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
  `;

  #actor = new ActorController(this);
  // Which tile holds the roving tabindex and focus. Ephemeral UI focus, not a fact:
  // null falls back to the open tile, then the first.
  #focusId = null;
  // Which tile's title is being edited in place (D11). Ephemeral view state, nothing a
  // reload should keep: null means no field is open. The draft lives in the input.
  #editingId = null;

  #tiles(snapshot) {
    return snapshot.context.books;
  }

  #focusTile(tiles, selected) {
    const has = (id) => tiles.some((t) => t.id === id);
    if (this.#focusId && has(this.#focusId)) return this.#focusId;
    if (selected && has(selected)) return selected;
    return tiles[0]?.id ?? null;
  }

  // Vim letters (12, "Vim keys"): only while the preference is on, never with a modifier
  // held (those belong to the browser and the desk), and never inside a field, where a
  // letter is typed text. gg is two presses, so a first g waits a moment for the second.
  #gAt = 0;
  #vim(event) {
    if (this.#actor.snapshot?.context.vimKeys !== true) return null;
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    const target = event.composedPath()[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName)) return null;
    const second = event.key === "g" && Date.now() - this.#gAt < 1000;
    this.#gAt = event.key === "g" && !second ? Date.now() : 0;
    if (second) return "first";
    return { j: "down", k: "up", G: "last", g: "prefix" }[event.key] ?? null;
  }

  #keydown(event, tiles) {
    const vim = this.#vim(event);
    // Every Vim letter the list owns is spent here, even with nowhere to move (j on the
    // last row): an uncancelled letter is typed wherever the browser still keeps a
    // selection, and that may be a hidden editor (WebKit).
    if (vim) event.preventDefault();
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key] ?? { down: 1, up: -1 }[vim];
    const current = this.#focusTile(tiles, this.#actor.snapshot.context.selected);
    if (step || vim === "first" || vim === "last") {
      const at = tiles.findIndex((t) => t.id === current);
      const to = vim === "first" ? 0 : vim === "last" ? tiles.length - 1 : at + step;
      const next = tiles[Math.min(tiles.length - 1, Math.max(0, to))];
      if (!next || next.id === current) return;
      event.preventDefault();
      this.#focusId = next.id;
      this.requestUpdate();
      // The row the keyboard moved to is scrolled into view by whichever box scrolls around
      // the list (its own, a panel's or the dock's), at once, so it is never left out of
      // sight below the fold.
      this.updateComplete.then(() => {
        const el = this.renderRoot.querySelector(`.tile[data-id="${next.id}"]`);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest", behavior: "instant" });
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.#activate(current);
    }
  }

  // A click or Enter on a tile opens it — or, if it is counting down, is the one-step
  // undo, the whole tile being the target so there is nothing small to hit.
  #activate(id) {
    if (!id) return;
    if (this.#actor.snapshot.context.discarding.has(id)) this.#actor.send({ type: "_undo", id });
    else this.#select(id);
  }

  #select(id) {
    this.#focusId = id;
    this.#actor.send({ type: "_select", id });
  }

  #discard(event, id) {
    event.stopPropagation();
    this.#actor.send({ type: "_discard", id });
  }

  // Turn a tile's title into a field holding the current text, selected, so a rename
  // starts from what is there and one keystroke can replace it (D11). The click does
  // not open the book: the edit tool is its own target.
  #startEdit(event, id) {
    event.stopPropagation();
    this.#editingId = id;
    this.requestUpdate();
    this.updateComplete.then(() => {
      const input = this.renderRoot.querySelector(".title-input");
      if (!input) return;
      // Set the current title imperatively (not a value binding), so a re-render from
      // another book's book.changed never clobbers the text being typed.
      const tile = this.#actor.snapshot?.context.books.find((b) => b.id === id);
      input.value = tile?.title ?? "";
      input.focus();
      input.select();
    });
  }

  // Enter or blur saves, Escape cancels (D11); the machine ignores unchanged text and
  // reads an empty string as "restore the file's title". Save clears the field first so
  // the blur a programmatic close would fire finds nothing to save again.
  #commitEdit(id, value) {
    if (this.#editingId !== id) return;
    this.#editingId = null;
    this.#actor.send({ type: "_rename", id, title: value });
    this.requestUpdate();
  }

  #cancelEdit() {
    this.#editingId = null;
    this.requestUpdate();
  }

  #editKeydown(event, id) {
    // Keep every keystroke inside the field: it must not reach the grid's keydown, or
    // Enter would open the book (a book.selected the "Contents" tab follows) and the
    // arrow keys would move the tile focus instead of the cursor.
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      this.#commitEdit(id, event.target.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.#cancelEdit();
    }
  }

  // The file picker and drops both arrive here: build the object URLs and hand the
  // machine only what rides book.picked.
  #pick(files) {
    const epubs = [...files].filter((f) => f.name.toLowerCase().endsWith(".epub") || f.type === "application/epub+zip");
    if (!epubs.length) return;
    this.#actor.send({ type: "_picked", files: epubs.map(asPicked) });
  }

  #openPicker() {
    this.renderRoot.querySelector("input[type=file]").click();
  }

  #onInput(event) {
    this.#pick(event.target.files);
    event.target.value = ""; // let the same file be picked again
  }

  #onDragover(event) {
    event.preventDefault();
    this.#dragover = true;
    this.requestUpdate();
  }

  #onDragleave() {
    this.#dragover = false;
    this.requestUpdate();
  }

  #onDrop(event) {
    event.preventDefault();
    this.#dragover = false;
    this.requestUpdate();
    this.#pick(event.dataTransfer?.files ?? []);
  }

  #dragover = false;

  // Rows are drawn by position (lit-core has no keyed repeat), so a reorder (an edited
  // note moving to the top) would leave the focus on whatever now fills the focused
  // element: the keyboard follows the roving row, which is keyed by id, instead.
  updated() {
    const active = this.renderRoot.activeElement;
    if (!active?.matches('[data-id][tabindex]')) return;
    const roving = this.renderRoot.querySelector('[data-id][tabindex="0"]');
    if (roving && roving !== active) roving.focus({ preventScroll: true });
  }

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on the roving row,
  // or the first button while there is no row.
  focus(options) {
    const target = this.renderRoot?.querySelector('[tabindex="0"]') ?? this.renderRoot?.querySelector("button");
    if (target) target.focus(options);
    else super.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { importing, selected, discarding, signedIn } = snapshot.context;
    const tiles = this.#tiles(snapshot);
    const focusId = this.#focusTile(tiles, selected);
    const empty = !tiles.length && !importing.length;

    return html`
      <input type="file" accept=".epub,application/epub+zip" multiple hidden @change=${(e) => this.#onInput(e)} />
      <div
        class="shelf ${this.#dragover ? "dragover" : ""}"
        @dragover=${(e) => this.#onDragover(e)}
        @dragleave=${() => this.#onDragleave()}
        @drop=${(e) => this.#onDrop(e)}
      >
        <div class="head">
          <button class="add" type="button" @click=${() => this.#openPicker()}>
            ${icon("upload-simple")}<span>Add a book</span>
          </button>
        </div>
        ${empty
          ? html`<div class="empty">
              <p>
                ${signedIn === false
                  ? "Sign in to add books"
                  : "Drop an epub here or Add a book"}
              </p>
            </div>`
          : html`
              <ul class="grid" role="listbox" aria-label="Books" @keydown=${(e) => this.#keydown(e, tiles)}>
                ${importing.map((p) => this.#adding(p))}
                ${tiles.map((t) => this.#tile(t, selected, focusId, discarding))}
              </ul>
            `}
      </div>
    `;
  }

  #adding(p) {
    return html`
      <li class="tile adding" aria-disabled="true">
        <div class="cover">
          <span class="spinner"></span>
          <span class="label">Adding…</span>
        </div>
        <span class="title">${p.name}</span>
      </li>
    `;
  }

  #tile(t, selected, focusId, discarding) {
    const isDiscarding = discarding.has(t.id);
    const cover = t.cover
      ? html`<img src=${t.cover} alt=${`Cover of ${t.title}`} />`
      : html`<div class="placeholder">${t.title}</div>`;
    return html`
      <li
        class="tile ${isDiscarding ? "discarding" : ""}"
        role="option"
        data-id=${t.id}
        aria-selected=${t.id === selected}
        tabindex=${t.id === focusId ? 0 : -1}
        @click=${() => this.#activate(t.id)}
      >
        <div class="cover">
          ${cover}
          <div class="actions">
            ${this.renames
              ? html`<button
                  class="tool edit"
                  type="button"
                  tabindex="-1"
                  aria-label="Rename book"
                  @click=${(e) => this.#startEdit(e, t.id)}
                >
                  ${icon("pencil-simple")}
                </button>`
              : nothing}
            <button class="tool bin" type="button" tabindex="-1" aria-label="Delete book" @click=${(e) => this.#discard(e, t.id)}>
              ${icon("trash-simple")}
            </button>
          </div>
          ${isDiscarding
            ? html`<div class="over">
                  <span>Deleted</span>
                  <button class="undo" type="button" aria-label="Undo delete">Undo</button>
                  <span class="bar"></span>
                </div>`
            : nothing}
        </div>
        ${this.#editingId === t.id
          ? html`<input
              class="title-input"
              placeholder="Empty restores the original title"
              aria-label="Book title"
              @click=${(e) => e.stopPropagation()}
              @keydown=${(e) => this.#editKeydown(e, t.id)}
              @blur=${(e) => this.#commitEdit(t.id, e.target.value)}
            />`
          : html`<span class="title">${t.title}</span>`}
        <span class="author">${t.author || " "}</span>
        <span class="progress">Chapter ${t.position.chapter + 1} of ${t.chapterCount}</span>
      </li>
    `;
  }
}

customElements.define("book-shelf", BookShelf);
