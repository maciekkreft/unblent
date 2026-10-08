import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, markedChapter } from "./machine.js";
import selected from "./events/chapter.selected.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "chapter.selected": selected },
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

// The toc tree flattened depth-first into rows, each carrying its nesting depth, so one
// roving tabindex walks the whole outline and a row indents by its depth. Entries
// keep their tree order (spine order from the importer); the flattening is only for the
// keyboard and the paint.
const flatten = (entries, depth = 0, out = []) => {
  for (const e of entries) {
    out.push({ title: e.title, chapter: e.chapter, depth });
    if (e.children?.length) flatten(e.children, depth + 1, out);
  }
  return out;
};

class BookToc extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .toc {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--space-sm) 0;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    /* One line per entry: a left accent rail (transparent until current), the title
       indented by its depth. The whole row is the target so there is nothing small to
       hit (Norman: a generous, visible affordance). */
    .entry {
      display: block;
      width: 100%;
      box-sizing: border-box;
      appearance: none;
      border: 0;
      border-inline-start: calc(var(--border-width) * 2) solid transparent;
      background: none;
      font: inherit;
      font-size: var(--text-sm);
      color: var(--color-body);
      text-align: start;
      cursor: pointer;
      padding: var(--space-2xs) var(--space-md);
    }
    .entry:hover {
      background: var(--color-surface-hover);
    }
    .entry:focus-visible {
      outline: var(--focus-ring);
      outline-offset: calc(-1 * var(--border-width));
    }
    /* The entry the reader is inside: named in ink, weighted, with the accent rail lit,
       so the reader's place in the book is visible at a glance (immediate feedback as the
       page turns move it). A publisher's contents skips pieces (a dedication, an
       illustration), so this is the entry at or before the current chapter, not only its
       exact match (markedChapter). */
    .entry.current {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      border-inline-start-color: var(--color-accent);
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      padding: var(--space-2xl) var(--space-md);
      text-align: center;
      color: var(--color-mute);
      font-size: var(--text-sm);
    }
    /* Tighter gutters in the phone drawer, the dock-desk container-query convention. */
    @container (max-width: 45rem) {
      .entry {
        padding-inline: var(--space-sm);
      }
    }
  `;

  #actor = new ActorController(this);
  // Which row holds the roving tabindex; null falls back to the marked chapter, then
  // the first row. Ephemeral focus, not a fact.
  #focusIndex = null;

  #rows() {
    const book = this.#actor.snapshot?.context.book;
    return book ? flatten(book.toc) : [];
  }

  #focusRow(rows, marked) {
    if (this.#focusIndex != null && this.#focusIndex < rows.length) return this.#focusIndex;
    const at = rows.findIndex((r) => r.chapter === marked);
    return at >= 0 ? at : rows.length ? 0 : null;
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
    return { j: "down", k: "up", G: "last" }[event.key] ?? null;
  }

  #keydown(event, rows, marked) {
    const vim = this.#vim(event);
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? { down: 1, up: -1 }[vim];
    const at = this.#focusRow(rows, marked) ?? 0;
    if (step || vim === "first" || vim === "last") {
      const to = vim === "first" ? 0 : vim === "last" ? rows.length - 1 : at + step;
      const next = Math.min(rows.length - 1, Math.max(0, to));
      if (next === at) return;
      event.preventDefault();
      this.#focusIndex = next;
      this.requestUpdate();
      this.updateComplete.then(() => this.renderRoot.querySelector(`.entry[data-at="${next}"]`)?.focus());
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.#select(rows[at], at);
    }
  }

  #select(row, at) {
    if (!row) return;
    this.#focusIndex = at;
    const id = this.#actor.snapshot?.context.book?.id;
    if (id) this.#actor.send({ type: "_select", id, chapter: row.chapter });
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const book = snapshot.context.book;
    const rows = this.#rows();
    if (!book || !rows.length) return html`<div class="empty"><p>Choose a book</p></div>`;

    const marked = markedChapter(book.toc, snapshot.context.jump ?? book.chapter);
    const focusAt = this.#focusRow(rows, marked);
    return html`
      <div class="toc">
        <ul role="tree" aria-label="Contents" @keydown=${(e) => this.#keydown(e, rows, marked)}>
          ${rows.map(
            (r, at) => html`
              <li role="treeitem" aria-level=${r.depth + 1} aria-selected=${r.chapter === marked}>
                <button
                  class="entry ${r.chapter === marked ? "current" : ""}"
                  type="button"
                  data-at=${at}
                  tabindex=${at === focusAt ? 0 : -1}
                  style="padding-inline-start: calc(var(--space-md) + var(--space-md) * ${r.depth})"
                  @click=${() => this.#select(r, at)}
                >
                  ${r.title}
                </button>
              </li>
            `,
          )}
        </ul>
      </div>
    `;
  }
}

customElements.define("book-toc", BookToc);
