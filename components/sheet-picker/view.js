import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask, send } from "bus";
import { icon } from "icons";
import { machine, listed, listOpen, cursorOf, writable, listKey, listTarget } from "./machine.js";
import focus from "./commands/focus.json" with { type: "json" };

// The view sits last in journal-entry's slot, inside the day's scrolling page. Section and row
// are drawn as the sheets' own sections and rows are.

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
        send: (target, name, payload) => send(machine, target, name, payload),
        now: () => Date.now(),
      },
      commands: { focus },
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

class SheetPicker extends LitElement {
  static styles = css`
    :host {
      display: block;
      container-type: inline-size;
      color: var(--color-body);
    }
    /* The page around spaces what it holds with a gap, so a day with no row must take no
       place in it at all. */
    :host([idle]) {
      display: none;
    }
    /* Focusable only by script and by a press, so a press on the section's own text lands
       here rather than being handed to the journal's text by its delegated focus. */
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding-top: var(--space-md);
      border-top: var(--border-width) solid var(--color-border);
    }
    section:focus {
      outline: none;
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
    .plus svg {
      display: block;
    }
    .sheets {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding: var(--space-xs);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
    }
    .pick {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 0 var(--space-md);
      align-items: baseline;
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: var(--space-xs) var(--space-sm);
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
    }
    .pick:hover,
    .pick.cur {
      background: var(--color-surface-hover);
    }
    .nm {
      font-size: var(--text-body);
      color: var(--color-ink);
    }
    .cat {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .what {
      grid-column: 1 / -1;
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    /* A narrow page (a phone, or a narrow stage): large enough for a finger. */
    @container (width < 28rem) {
      .pick {
        min-height: calc(var(--space-xl) + var(--space-xs));
      }
    }
  `;

  #actor = new ActorController(this);

  // The last focus command the keyboard was given for, and whether the list just opened and
  // takes the keyboard once it is drawn. Kept here because the elements exist only after render.
  #landed = 0;
  #landInList = false;

  #row() {
    return this.renderRoot?.querySelector(".new") ?? null;
  }

  #picks() {
    return [...(this.renderRoot?.querySelectorAll(".pick") ?? [])];
  }

  willUpdate() {
    const context = this.#actor.snapshot?.context;
    this.toggleAttribute("idle", !context || !listed(context).length);
  }

  updated() {
    const context = this.#actor.snapshot?.context;
    if (!context) return;
    if (this.#landInList) {
      this.#landInList = false;
      this.#picks()[cursorOf(context)]?.focus({ preventScroll: true });
      // The whole list comes into sight, not only its first entry: the row is the page's last.
      this.renderRoot.querySelector(".sheets")?.scrollIntoView({ block: "nearest" });
    }
    if (context.landing !== this.#landed) this.#land(context);
  }

  // A sheet that went while holding the keyboard asked for it to land here. The row may be
  // about to come back, when the sheet that went was the last thing to list, so the landing
  // waits for it; by then the user may have gone elsewhere, and then it is dropped. A day that
  // cannot be written will have no row, so the keyboard goes to the page around.
  #land(context) {
    const row = this.#row();
    if (row) {
      this.#landed = context.landing;
      if (!this.parentElement?.matches(":focus-within")) row.focus();
    } else if (!writable(context)) {
      this.#landed = context.landing;
      this.parentElement?.focus();
    }
  }

  // journal-entry hands the keyboard by the host. With no row it stays where it was, so the
  // entry passes this view over.
  focus(options) {
    this.#row()?.focus(options);
  }

  #toggle() {
    const wasOpen = listOpen(this.#actor.snapshot.context);
    this.#actor.send({ type: "_toggle" });
    if (wasOpen) this.#row()?.focus();
    else this.#landInList = true;
  }

  #gAt = 0;
  #key = (event) => {
    if (event.defaultPrevented) return;
    const { context } = this.#actor.snapshot;
    // Closed, the keys are left to the page around (journal-entry moves on from there).
    if (!listOpen(context)) return;
    const take = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (event.key === "Escape") {
      take();
      this.#actor.send({ type: "_close" });
      return this.#row()?.focus();
    }
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const key = listKey(event, context.vimKeys === true, afterG);
    this.#gAt = key?.wait ? Date.now() : 0;
    if (!key) return;
    take();
    if (key.wait) return;
    // On the row with the list open, a move first goes to the entry the keys are on.
    const onEntry = event.composedPath()[0]?.classList?.contains("pick") === true;
    const at = cursorOf(context);
    this.#picks()[onEntry ? listTarget(key.move, at, listed(context).length) : at]?.focus();
  };

  render() {
    const context = this.#actor.snapshot?.context;
    if (!context) return nothing;
    const sheets = listed(context);
    if (!sheets.length) return nothing;
    const open = listOpen(context);
    const cursor = cursorOf(context);
    return html`<section tabindex="-1" aria-label="Add a sheet" @keydown=${this.#key}>
      <button type="button" class="new" aria-expanded=${open ? "true" : "false"} @click=${() => this.#toggle()}><span class="plus">${icon("plus")}</span>Add sheet</button>
      ${open
        ? html`<div class="sheets">
            ${sheets.map(
              (s, i) =>
                html`<button
                  type="button"
                  class="pick ${i === cursor ? "cur" : ""}"
                  data-id=${s.id}
                  @focus=${() => this.#actor.send({ type: "_cursor", to: i })}
                  @click=${() => this.#actor.send({ type: "_pick", id: s.id })}
                >
                  <span class="nm">${s.name}</span>
                  <span class="cat">${s.category}</span>
                  <span class="what">${s.what}</span>
                </button>`,
            )}
          </div>`
        : nothing}
    </section>`;
  }
}

customElements.define("sheet-picker", SheetPicker);
