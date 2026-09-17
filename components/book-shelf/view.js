import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine } from "./machine.js";
import picked from "./events/book.picked.json" with { type: "json" };
import selected from "./events/book.selected.json" with { type: "json" };
import discarded from "./events/book.discarded.json" with { type: "json" };

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
      events: { "book.picked": picked, "book.selected": selected, "book.discarded": discarded },
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
    /* The open book carries the one visible selection. */
    .tile[aria-selected="true"] .cover {
      outline: var(--border-width) solid var(--color-accent-selection);
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
    /* The trash sits on the cover, a signifier shown on hover or focus; on a coarse
       pointer (no hover) it stands, since there is nothing to hover with. */
    .bin {
      position: absolute;
      inset-block-start: var(--space-2xs);
      inset-inline-end: var(--space-2xs);
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
      visibility: hidden;
    }
    .bin svg {
      display: block;
    }
    .tile:hover .bin,
    .tile:focus-within .bin {
      visibility: visible;
    }
    .bin:hover {
      color: var(--color-danger);
    }
    @media (hover: none) {
      .bin {
        visibility: visible;
      }
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

  #tiles(snapshot) {
    return snapshot.context.books;
  }

  #focusTile(tiles, selected) {
    const has = (id) => tiles.some((t) => t.id === id);
    if (this.#focusId && has(this.#focusId)) return this.#focusId;
    if (selected && has(selected)) return selected;
    return tiles[0]?.id ?? null;
  }

  #keydown(event, tiles) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const current = this.#focusTile(tiles, this.#actor.snapshot.context.selected);
    if (step) {
      const at = tiles.findIndex((t) => t.id === current);
      const next = tiles[Math.min(tiles.length - 1, Math.max(0, at + step))];
      if (!next || next.id === current) return;
      event.preventDefault();
      this.#focusId = next.id;
      this.requestUpdate();
      this.updateComplete.then(() => this.renderRoot.querySelector(`.tile[data-id="${next.id}"]`)?.focus());
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
          <button class="bin" type="button" tabindex="-1" aria-label="Delete book" @click=${(e) => this.#discard(e, t.id)}>
            ${icon("trash-simple")}
          </button>
          ${isDiscarding
            ? html`<div class="over">
                  <span>Deleted</span>
                  <button class="undo" type="button" aria-label="Undo delete">Undo</button>
                  <span class="bar"></span>
                </div>`
            : nothing}
        </div>
        <span class="title">${t.title}</span>
        <span class="author">${t.author || " "}</span>
        <span class="progress">Chapter ${t.position.chapter + 1} of ${t.chapterCount}</span>
      </li>
    `;
  }
}

customElements.define("book-shelf", BookShelf);
