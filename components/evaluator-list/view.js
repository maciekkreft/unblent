import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, rows, subtitle, UNTITLED } from "./machine.js";
import selected from "./events/evaluator.selected.json" with { type: "json" };
import switched from "./events/evaluator.switched.json" with { type: "json" };

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
        following: this.host.subject,
      },
      events: { "evaluator.selected": selected, "evaluator.switched": switched },
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

class EvaluatorList extends LitElement {
  // Follow the book open on the stage. Reflected so a page's bare `subject` reads as true.
  static properties = { subject: { type: Boolean, reflect: true } };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: var(--space-2xs);
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      user-select: none;
      -webkit-user-select: none;
    }
    .row:hover {
      background: var(--color-surface-hover);
    }
    .row:has(.open:focus-visible) {
      box-shadow: var(--focus-ring);
    }
    .row.current {
      background: var(--color-accent-subtle);
    }
    input[type="checkbox"] {
      flex: none;
      width: calc(var(--space-md) + var(--space-2xs));
      height: calc(var(--space-md) + var(--space-2xs));
      margin: 0;
      accent-color: var(--color-accent);
      cursor: pointer;
    }
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The row's name is its open button: the whole text area opens the evaluator, the
       tick box beside it only switches it. */
    .open {
      flex: 1;
      min-width: 0;
      display: block;
      font: inherit;
      text-align: left;
      color: inherit;
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
    }
    .open:focus-visible {
      outline: none;
    }
    .name {
      display: block;
      color: var(--color-body);
      font-weight: var(--weight-semibold);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name.off {
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .name.untitled {
      color: var(--color-mute);
      font-weight: var(--weight-normal);
    }
    .name.draft {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .name.draft svg {
      font-size: var(--text-body);
    }
    .sub {
      display: block;
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-body-mid);
    }
    .empty {
      margin: 0;
      padding: var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  // Which row holds the roving tab stop: the one the keyboard moved to, else the open
  // one, else New evaluator. Ephemeral UI focus, not a fact.
  #focusId = null;

  #focusRow(ids, open) {
    if (this.#focusId && ids.includes(this.#focusId)) return this.#focusId;
    if (open && ids.includes(open)) return open;
    return ids[0] ?? null;
  }

  // A panel's focus lands in what it shows (list-then-item, dock-desk): the roving row.
  focus(options) {
    const target = this.renderRoot?.querySelector('.open[tabindex="0"]') ?? this.renderRoot?.querySelector(".open");
    if (target) target.focus(options);
    else super.focus(options);
  }

  // A click anywhere on a row opens it, except on its tick box, which only switches.
  #rowClick(event, id) {
    if (event.target.closest?.('input[type="checkbox"]')) return;
    this.#actor.send({ type: "_pick", id });
  }

  // Vim letters (12, "Vim keys"), as in the other lists: only while the preference is on,
  // never with a modifier held (those belong to the browser and the desk), and never in a
  // field, where a letter is typed text. gg is two presses, so a first g waits a moment.
  #gAt = 0;
  #vim(event) {
    if (this.#actor.snapshot?.context.vimKeys !== true) return null;
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    const target = event.composedPath()[0];
    if (target?.isContentEditable || target?.tagName === "TEXTAREA" || (target?.tagName === "INPUT" && target.type !== "checkbox")) return null;
    const second = event.key === "g" && Date.now() - this.#gAt < 1000;
    this.#gAt = event.key === "g" && !second ? Date.now() : 0;
    if (second) return "first";
    return { j: "down", k: "up", G: "last", g: "prefix" }[event.key] ?? null;
  }

  #keydown(event, ids) {
    const vim = this.#vim(event);
    // Every Vim letter the list owns is spent here, even with nowhere to move: an
    // uncancelled letter is typed wherever WebKit still keeps a selection.
    if (vim) event.preventDefault();
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? { down: 1, up: -1 }[vim];
    if (!step && vim !== "first" && vim !== "last") return;
    const current = this.#focusRow(ids, this.#actor.snapshot.context.open);
    const at = ids.indexOf(current);
    const to = vim === "first" ? 0 : vim === "last" ? ids.length - 1 : at + step;
    const next = ids[Math.min(ids.length - 1, Math.max(0, to))];
    if (!next || next === current) return;
    event.preventDefault();
    this.#focusId = next;
    this.requestUpdate();
    // The row moved to is scrolled into view by whichever box scrolls around the list.
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector(`.row[data-id="${next}"] .open`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  }

  // Rows are drawn by position (lit-core has no keyed repeat), so a row removed above the
  // focused one would leave the focus on whatever now fills its element: the keyboard
  // follows the roving row, which is keyed by id, instead.
  updated() {
    const active = this.renderRoot.activeElement;
    if (!active?.matches(".open")) return;
    const roving = this.renderRoot.querySelector('.open[tabindex="0"]');
    if (roving && roving !== active) roving.focus({ preventScroll: true });
  }

  // A row reached by a click or Tab becomes the keyboard's row.
  #focusin(event) {
    const id = event.composedPath()[0]?.closest?.(".row")?.dataset.id;
    if (id && id !== this.#focusId) {
      this.#focusId = id;
      this.requestUpdate();
    }
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("idle")) return html`<p class="empty">Open a book to see its evaluators.</p>`;
    if (snapshot.matches("failed")) return html`<p class="empty">Evaluators unavailable.</p>`;
    const { draft, open, evaluators } = snapshot.context;
    const shown = rows(evaluators);
    const ids = [draft, ...shown.map((e) => e.id)];
    const focusId = this.#focusRow(ids, open);
    return html`
      <ul class="list" aria-label="Evaluators" @keydown=${(e) => this.#keydown(e, ids)} @focusin=${(e) => this.#focusin(e)}>
        <li class="row new" data-id=${draft} @click=${(e) => this.#rowClick(e, draft)}>
          <button class="open" type="button" tabindex=${draft === focusId ? 0 : -1}>
            <span class="name draft">${icon("plus")}New evaluator</span>
          </button>
        </li>
        ${shown.map((e) => this.#row(e, open, focusId))}
      </ul>
    `;
  }

  #row(e, open, focusId) {
    const tab = e.id === focusId ? 0 : -1;
    const name = e.name.trim();
    return html`
      <li class="row ${e.id === open ? "current" : ""}" data-id=${e.id} @click=${(event) => this.#rowClick(event, e.id)}>
        <input
          type="checkbox"
          tabindex=${tab}
          .checked=${e.on}
          aria-label="${name || UNTITLED} is on"
          @change=${(event) => this.#actor.send({ type: "_switch", id: e.id, on: event.target.checked })}
        />
        <button class="open" type="button" tabindex=${tab} aria-current=${e.id === open ? "true" : nothing}>
          <span class="name ${name ? (e.on ? "" : "off") : "untitled"}">${name || UNTITLED}</span>
          <span class="sub">${subtitle(e)}</span>
        </button>
      </li>
    `;
  }
}

customElements.define("evaluator-list", EvaluatorList);
