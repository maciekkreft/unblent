import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, rows, subtitle, hint, projectOf, NEW_NAME, UNTITLED, UNTITLED_DETECTOR } from "./machine.js";
import selected from "./events/detector.selected.json" with { type: "json" };
import switched from "./events/detector.switched.json" with { type: "json" };
import saved from "./events/detector-project.saved.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };

// Which project was shown, kept per browser under the view's name (3.1); losing it loses
// nothing but the place.
const KEY = "detector-list:project";
const recall = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const remember = (id) => {
  try {
    localStorage.setItem(KEY, id);
  } catch {}
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, project: recall(), remember },
      events: {
        "detector.selected": selected,
        "detector.switched": switched,
        "detector-project.saved": saved,
        "removal.started": started,
      },
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

class DetectorList extends LitElement {
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };

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
    /* The row's name is its open button: the whole text area opens the detector, the
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
    .hint,
    .empty {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .hint {
      padding: 0 var(--space-sm) var(--space-md);
    }
    .empty {
      padding: var(--space-xs) var(--space-sm);
      font-size: var(--text-sm);
    }
    /* The project itself, above its detectors: its name is written in place, and the
       bin beside it deletes it. */
    .head {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-sm) var(--space-sm) var(--space-2xs);
    }
    .head input {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      font: inherit;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
      background: transparent;
      border: var(--border-width) solid transparent;
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-xs);
    }
    .head input:hover {
      border-color: var(--color-border);
    }
    .head input:focus-visible {
      outline: none;
      background: var(--color-canvas-soft);
      border-color: var(--color-border);
      box-shadow: var(--focus-ring);
    }
    .head input::placeholder {
      color: var(--color-mute);
    }
    .head button {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font: inherit;
      color: var(--color-body);
      background: none;
      border: 0;
      border-radius: var(--radius-sm);
      padding: var(--space-xs);
      cursor: pointer;
    }
    .head button:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    .head button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
  `;

  #actor = new ActorController(this);
  // The project pick whose New project name was last offered for writing.
  #namedPick = 0;

  // A panel's focus lands in what it shows (list-then-item, dock-desk): the first row,
  // so Up and Down walk the detectors; the name field above them is a Tab away.
  focus(options) {
    const first = this.renderRoot.querySelector(".open");
    if (first) first.focus(options);
    else super.focus(options);
  }

  #rename(field) {
    this.#actor.send({ type: "_rename", name: field.value });
  }

  // A click anywhere on a row opens it, except on its tick box, which only switches.
  #rowClick(event, id) {
    if (event.target.closest?.('input[type="checkbox"]')) return;
    this.#actor.send({ type: "_pick", id });
  }

  // Up and Down move between the rows' open buttons, as in the other lists.
  #keydown(event) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [...this.renderRoot.querySelectorAll(".open")];
    const at = buttons.findIndex((b) => b === this.renderRoot.activeElement || b.parentElement.contains(this.renderRoot.activeElement));
    const next = buttons[at + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  // Enter keeps the name; Escape keeps it too, then leaves for the projects through
  // list-then-item, which hears the same key.
  #nameKeydown(event) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.#rename(event.target);
      event.target.blur();
    } else if (event.key === "Escape") {
      this.#rename(event.target);
    }
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty">Detectors unavailable.</p>`;
    const { draft, open, detectors } = snapshot.context;
    const project = projectOf(snapshot.context);
    if (!project) return html`<p class="empty">Pick a project.</p>`;
    if (project.removing) return html`<p class="empty">This project was deleted.</p>`;
    const shown = rows(detectors, project.id);
    return html`
      <div class="head">
        <input
          type="text"
          aria-label="Project name"
          placeholder="Name the project"
          .value=${project.name}
          @change=${(e) => this.#rename(e.target)}
          @keydown=${(e) => this.#nameKeydown(e)}
        />
        <button type="button" title="Delete this project" aria-label="Delete this project" @click=${() => this.#actor.send({ type: "_delete" })}>
          ${icon("trash-simple")}
        </button>
      </div>
      <ul class="list" aria-label="Detectors" @keydown=${(e) => this.#keydown(e)}>
        <li class="row new" @click=${(e) => this.#rowClick(e, draft)}>
          <button class="open" type="button">
            <span class="name draft">${icon("plus")}New detector</span>
          </button>
        </li>
        ${shown.map((d) => this.#row(d, open))}
      </ul>
      ${shown.length
        ? html`<p class="hint">${hint(project)}</p>`
        : html`<p class="empty">No detectors yet. Use New detector to write the questions Jev should answer.</p>`}
    `;
  }

  #row(d, open) {
    const name = d.name.trim();
    return html`
      <li class="row ${d.id === open ? "current" : ""}" data-id=${d.id} @click=${(e) => this.#rowClick(e, d.id)}>
        <input
          type="checkbox"
          .checked=${d.on}
          aria-label="${name || UNTITLED_DETECTOR} reads your writing"
          @change=${(e) => this.#actor.send({ type: "_switch", id: d.id, on: e.target.checked })}
        />
        <button class="open" type="button" aria-current=${d.id === open ? "true" : nothing}>
          <span class="name ${name ? (d.on ? "" : "off") : "untitled"}">${name || UNTITLED_DETECTOR}</span>
          <span class="sub">${subtitle(d)}</span>
        </button>
      </li>
    `;
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    const project = snapshot && projectOf(snapshot.context);
    if (!project) return;
    // list-then-item names its Back bar after its list's `label` (6.4): this list names
    // itself after the project it shows, so the editor's Back bar reads "‹ <project>".
    // Written on this element only.
    const label = project.name.trim() || UNTITLED;
    if (this.getAttribute("label") !== label) this.setAttribute("label", label);
    // A project just made by New project opens with its name selected, ready to write,
    // once per pick; a reload or a pick of a named project leaves the keyboard alone.
    const { picks } = snapshot.context;
    if (picks !== this.#namedPick && !project.removing) {
      this.#namedPick = picks;
      if (project.name === NEW_NAME) {
        // After the frame, when list-then-item has slotted this list in.
        requestAnimationFrame(() => {
          const field = this.renderRoot.querySelector(".head input");
          field?.focus();
          field?.select();
        });
      }
    }
  }
}

customElements.define("detector-list", DetectorList);
