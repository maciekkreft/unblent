import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine } from "./machine.js";
import selected from "./events/note.selected.json" with { type: "json" };

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
      },
      events: { "note.selected": selected },
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

// The note's time, absolute and formatted once (no clock, no timer): a note from
// today reads as a time of day, an older one as a short date. `new Date()` is read
// at render, not on an interval, so nothing re-renders to keep it current — the row
// changes only when note.changed brings a new updatedAt.
const timeOfDay = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
const when = (at) => {
  const d = new Date(at);
  const now = new Date();
  const today =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? timeOfDay.format(d) : shortDate.format(d);
};

class NoteList extends LitElement {
  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .head {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md);
      border-bottom: var(--border-width) solid var(--color-border);
    }
    .title {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    /* Always visible, never hover-only, so it works by touch and is discoverable. */
    .new {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font: inherit;
      font-size: var(--text-subtitle);
      color: var(--color-body-mid);
      background: none;
      border: 0;
      padding: var(--space-2xs);
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .new:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    .new:focus-visible {
      outline: var(--focus-ring);
    }
    .new svg {
      display: block;
    }
    /* The list scrolls inside its own box, so a docked list never grows the desk. */
    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      list-style: none;
      margin: 0;
      padding: var(--space-2xs);
    }
    .row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
    }
    .row:hover {
      background: var(--color-surface-hover);
    }
    .row:focus-visible {
      outline: var(--focus-ring);
    }
    /* The open row (the note the editor shows) is the one visible selection. */
    .row[aria-selected="true"] {
      background: var(--color-accent-subtle);
    }
    .row[aria-selected="true"] .name {
      color: var(--color-ink);
    }
    .name {
      color: var(--color-body);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name.untitled {
      color: var(--color-mute);
    }
    .time {
      flex: none;
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .empty {
      margin: 0;
      padding: var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);
  // Which row holds the roving tabindex and focus. Ephemeral UI focus, not a fact:
  // null falls back to the open row, then the first.
  #focusId = null;

  #rows(snapshot) {
    const { notes, draft } = snapshot.context;
    return draft ? [{ id: draft, draft: true }, ...notes] : notes;
  }

  #focusRow(rows, open) {
    const has = (id) => rows.some((r) => r.id === id);
    if (this.#focusId && has(this.#focusId)) return this.#focusId;
    if (open && has(open)) return open;
    return rows[0]?.id ?? null;
  }

  #keydown(event, rows) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const current = this.#focusRow(rows, this.#actor.snapshot.context.open);
    if (step) {
      const at = rows.findIndex((r) => r.id === current);
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + step))];
      if (!next || next.id === current) return;
      event.preventDefault();
      this.#focusId = next.id;
      this.requestUpdate();
      this.updateComplete.then(() =>
        this.renderRoot.querySelector(`.row[data-id="${next.id}"]`)?.focus(),
      );
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.#pick(current);
    }
  }

  #pick(id) {
    if (!id) return;
    this.#focusId = id;
    this.#actor.send({ type: "_pick", id });
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { open } = snapshot.context;
    const rows = this.#rows(snapshot);
    const focusId = this.#focusRow(rows, open);
    return html`
      <div class="head">
        <span class="title">Notes</span>
        <button class="new" aria-label="New note" title="New note" @click=${() => this.#actor.send({ type: "_new" })}>
          ${icon("plus")}
        </button>
      </div>
      ${snapshot.matches("failed")
        ? html`<p class="empty">Notes unavailable.</p>`
        : rows.length === 0
          ? html`<p class="empty">No notes yet.</p>`
          : html`
              <ul class="list" role="listbox" aria-label="Notes" @keydown=${(e) => this.#keydown(e, rows)}>
                ${rows.map((r) => this.#row(r, open, focusId))}
              </ul>
            `}
    `;
  }

  #row(r, open, focusId) {
    const title = r.draft ? "New note" : r.title;
    const untitled = !r.draft && !title;
    return html`
      <li
        class="row"
        role="option"
        data-id=${r.id}
        aria-selected=${r.id === open}
        tabindex=${r.id === focusId ? 0 : -1}
        @click=${() => this.#pick(r.id)}
      >
        <span class="name ${untitled ? "untitled" : ""}">${untitled ? "Untitled" : title}</span>
        ${r.draft ? nothing : html`<span class="time">${when(r.updatedAt)}</span>`}
      </li>
    `;
  }
}

customElements.define("note-list", NoteList);
