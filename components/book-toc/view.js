import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, markedChapter, chapterCounts, choiceLabel, markedSummary, showing } from "./machine.js";
import selected from "./events/chapter.selected.json" with { type: "json" };

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
        // A try page (8) shows the contents signed out.
        tryPage: location.pathname.startsWith("/try/"),
      },
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
      outline: none;
      box-shadow: var(--focus-ring);
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
    /* A day's count of choice points, the journal only: quieter than the date, so the
       title stays what the row is, the way the Days list shows it. */
    .choices {
      font-size: var(--text-caption);
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
    }
    /* The marked day's summary, the journal only: as quiet as the count, under the row
       and on its lit rail, so it reads as part of the marked day. */
    .summary {
      margin: 0;
      border-inline-start: calc(var(--border-width) * 2) solid var(--color-accent);
      padding: 0 var(--space-md) var(--space-xs);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
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
      .summary {
        padding-inline-end: var(--space-sm);
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
    return { j: "down", k: "up", G: "last", g: "prefix" }[event.key] ?? null;
  }

  #keydown(event, rows, marked) {
    const vim = this.#vim(event);
    // Every Vim letter the list owns is spent here, even with nowhere to move (j on the
    // last row): an uncancelled letter is typed wherever the browser still keeps a
    // selection, and that may be a hidden editor (WebKit).
    if (vim) event.preventDefault();
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? { down: 1, up: -1 }[vim];
    const at = this.#focusRow(rows, marked) ?? 0;
    if (step || vim === "first" || vim === "last") {
      const to = vim === "first" ? 0 : vim === "last" ? rows.length - 1 : at + step;
      const next = Math.min(rows.length - 1, Math.max(0, to));
      if (next === at) return;
      event.preventDefault();
      this.#focusIndex = next;
      this.requestUpdate();
      // The row the keyboard moved to is scrolled into view by whichever box scrolls around
      // the list (its own, a panel's or the dock's), at once, so it is never left out of
      // sight below the fold.
      this.updateComplete.then(() => {
        const el = this.renderRoot.querySelector(`.entry[data-at="${next}"]`);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest", behavior: "instant" });
      });
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
    // Signed out nothing of the account shows (machine.js: showing).
    const account = showing(snapshot.context);
    if (account === "wait") return nothing;
    if (account === "sign-in") return html`<div class="empty"><p>Sign in to see your books.</p></div>`;
    const book = snapshot.context.book;
    const rows = this.#rows();
    if (!book || !rows.length) return html`<div class="empty"><p>Choose a book</p></div>`;

    const marked = markedChapter(book.toc, snapshot.context.jump ?? book.chapter);
    const focusAt = this.#focusRow(rows, marked);
    const perChapter = chapterCounts(book, snapshot.context.choicePoints);
    const summary = markedSummary(book, snapshot.context.summaries, marked);
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
                  aria-describedby=${summary && r.chapter === marked ? "summary" : nothing}
                  style="padding-inline-start: calc(var(--space-md) + var(--space-md) * ${r.depth})"
                  @click=${() => this.#select(r, at)}
                >
                  ${r.title}
                  ${perChapter[r.chapter] ? html`<span class="choices">· ${choiceLabel(perChapter[r.chapter])}</span>` : nothing}
                </button>
                ${summary && r.chapter === marked ? html`<p class="summary" id="summary">${summary}</p>` : nothing}
              </li>
            `,
          )}
        </ul>
      </div>
    `;
  }
}

customElements.define("book-toc", BookToc);
