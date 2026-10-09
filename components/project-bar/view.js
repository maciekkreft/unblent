import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, shown, summary, canDelete, UNTITLED } from "./machine.js";
import selected from "./events/project.selected.json" with { type: "json" };
import saved from "./events/project.saved.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid },
      events: { "project.selected": selected, "project.saved": saved, "removal.started": started },
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

class ProjectBar extends LitElement {
  static styles = css`
    /* Above the dock desk and its phone drawers, so the open menu lies over them. */
    :host {
      flex: none;
      display: block;
      position: relative;
      z-index: 2;
      container-type: inline-size;
    }
    .bar {
      box-sizing: border-box;
      height: var(--space-xl);
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: 0 var(--space-sm);
      border-bottom: var(--border-width) solid var(--color-border);
      background: var(--color-canvas);
      font-size: var(--text-sm);
    }
    .label {
      color: var(--color-body-mid);
    }
    .open {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      min-width: 0;
      max-width: 100%;
      font: inherit;
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-sm);
      cursor: pointer;
    }
    .open:hover {
      background: var(--color-surface-hover);
    }
    .open:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .open .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .open svg {
      flex: none;
      display: block;
      color: var(--color-body-mid);
    }
    .kept {
      margin-left: auto;
      color: var(--color-body-mid);
      font-size: var(--text-caption);
      white-space: nowrap;
    }
    .menu {
      position: absolute;
      top: calc(var(--space-xl) - var(--space-2xs));
      left: var(--space-sm);
      box-sizing: border-box;
      width: min(calc(var(--space-2xl) * 5.5), calc(100% - var(--space-md)));
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding: var(--space-xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
      font-size: var(--text-body);
    }
    .item {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      font: inherit;
      color: var(--color-body);
      background: none;
      border: 0;
      border-radius: var(--radius-sm);
      padding: var(--space-xs) var(--space-sm);
      cursor: pointer;
    }
    .item:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    .item:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .item:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .item > svg {
      flex: none;
      color: var(--color-body-mid);
    }
    .item:disabled > svg {
      color: var(--color-mute);
    }
    .tick {
      flex: none;
      display: inline-flex;
      color: var(--color-accent);
    }
    /* Every row keeps the tick's place, so the names line up. */
    .item[aria-checked="false"] .tick {
      visibility: hidden;
    }
    .text {
      flex: 1;
      min-width: 0;
    }
    .item .pname {
      display: block;
      color: var(--color-ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .item[aria-checked="true"] .pname {
      font-weight: var(--weight-semibold);
    }
    .sub {
      display: block;
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      color: var(--color-body-mid);
    }
    hr {
      border: 0;
      border-top: var(--border-width) solid var(--color-border);
      margin: var(--space-2xs) 0;
    }
    form {
      display: flex;
      gap: var(--space-xs);
      margin: 0;
      padding: var(--space-xs);
    }
    input {
      flex: 1;
      min-width: 0;
      font: inherit;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-sm);
    }
    input:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .done {
      font: inherit;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-canvas);
      background: var(--color-ink);
      border: 0;
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-md);
      cursor: pointer;
    }
    .done:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .foot {
      margin: 0;
      padding: var(--space-xs) var(--space-sm);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    /* The phone's width (dock-desk's breakpoint): the line moves into the menu's foot. */
    @container (width < 45rem) {
      .kept {
        display: none;
      }
    }
  `;

  #actor = new ActorController(this);
  // UI state, not a fact: whether the menu is open, and whether its name field is.
  #open = false;
  #renaming = false;
  #outside = (event) => {
    if (!event.composedPath().includes(this)) this.#close(false);
  };

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("pointerdown", this.#outside, true);
  }

  #setOpen(open, { renaming = false } = {}) {
    this.#open = open;
    this.#renaming = open && renaming;
    if (open) document.addEventListener("pointerdown", this.#outside, true);
    else document.removeEventListener("pointerdown", this.#outside, true);
    this.requestUpdate();
  }

  #close(focusButton = true) {
    if (!this.#open) return;
    this.#setOpen(false);
    if (focusButton) this.updateComplete.then(() => this.renderRoot.querySelector(".open")?.focus());
  }

  // Opening puts the keyboard on the ticked project; the name field takes it while open.
  async #toggle(event) {
    if (this.#open) return this.#close();
    this.#setOpen(true);
    await this.updateComplete;
    if (event?.detail === 0) this.renderRoot.querySelector('.item[aria-checked="true"]')?.focus();
  }

  async #focusName() {
    await this.updateComplete;
    const field = this.renderRoot.querySelector("input");
    field?.focus();
    field?.select();
  }

  #pick(id) {
    this.#actor.send({ type: "_pick", id });
    this.#close();
  }

  #new() {
    this.#actor.send({ type: "_new" });
    this.#setOpen(true, { renaming: true });
    this.#focusName();
  }

  #startRename() {
    this.#setOpen(true, { renaming: true });
    this.#focusName();
  }

  #rename(event) {
    event.preventDefault();
    this.#actor.send({ type: "_rename", name: this.renderRoot.querySelector("input").value });
    this.#close();
  }

  #delete() {
    this.#actor.send({ type: "_delete" });
    this.#close();
  }

  // Arrow keys walk the menu's items; Escape closes it and gives the button back.
  #keydown(event) {
    if (!this.#open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return this.#close();
    }
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step || event.target.localName === "input") return;
    const items = [...this.renderRoot.querySelectorAll(".item:not(:disabled), input")];
    const at = items.indexOf(this.renderRoot.activeElement);
    const next = items[(at + step + items.length) % items.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<div class="bar"><span class="label">Projects unavailable.</span></div>`;
    const { projects, current, rubrics, cases } = snapshot.context;
    const project = projects.find((p) => p.id === current);
    return html`
      <div class="bar" @keydown=${(e) => this.#keydown(e)}>
        <span class="label" id="label">Project</span>
        <button
          type="button"
          class="open"
          aria-haspopup="menu"
          aria-expanded=${this.#open}
          aria-controls="menu"
          aria-labelledby="label name"
          @click=${(e) => this.#toggle(e)}
        >
          <span class="name" id="name">${project?.name || UNTITLED}</span>${icon("caret-down")}
        </button>
        <span class="kept">Projects are kept on this device.</span>
        ${this.#open ? this.#menu(projects, current, rubrics, cases, project) : nothing}
      </div>
    `;
  }

  #menu(projects, current, rubrics, cases, project) {
    const deletable = canDelete(projects);
    return html`
      <div class="menu" id="menu" role="menu" aria-label="Projects">
        ${shown(projects).map(
          (p) => html`
            <button
              type="button"
              class="item"
              role="menuitemradio"
              aria-checked=${p.id === current}
              data-id=${p.id}
              @click=${() => this.#pick(p.id)}
            >
              <span class="tick"></span>
              <span class="text">
                <span class="pname">${p.name || UNTITLED}</span>
                <span class="sub">${summary(p.id, rubrics, cases)}</span>
              </span>
            </button>
          `,
        )}
        <hr />
        <button type="button" class="item" role="menuitem" @click=${() => this.#new()}>
          ${icon("plus")}<span class="text">New project</span>
        </button>
        ${this.#renaming
          ? html`<form @submit=${(e) => this.#rename(e)}>
              <input type="text" aria-label="Project name" placeholder="Name the project" .value=${project?.name ?? ""} />
              <button type="submit" class="done">Done</button>
            </form>`
          : html`<button type="button" class="item" role="menuitem" @click=${() => this.#startRename()}>
              ${icon("pencil-simple")}<span class="text">Rename this project</span>
            </button>`}
        <button
          type="button"
          class="item"
          role="menuitem"
          ?disabled=${!deletable}
          title=${deletable ? nothing : "Keep at least one project"}
          @click=${() => this.#delete()}
        >
          ${icon("trash-simple")}<span class="text">Delete this project</span>
        </button>
        <hr />
        <p class="foot">Projects are kept on this device. Each project has its own tools, cases and results.</p>
      </div>
    `;
  }
}

customElements.define("project-bar", ProjectBar);
