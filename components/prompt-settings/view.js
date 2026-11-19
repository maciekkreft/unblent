import { LitElement, html, css, nothing } from "lit";
import { icon } from "icons";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { machine, shownOf, besideOf, stopKey, moveKey } from "./machine.js";
import saved from "./events/prompt-set.saved.json" with { type: "json" };

// Every box holds one line of text, a name, an occasion, a book or one question, so Enter
// never breaks it. It is a text area that wraps and grows with what is written, so a long
// question shows whole on a phone; it grows by a hidden copy of its text in the same grid
// cell, which needs no length set from code.

// What takes the keyboard on the tab's path, top to bottom. The move buttons are left off
// it, since Alt+Up and Alt+Down move a prompt from its box; Tab still reaches them.
const STOPS = "button:not(.move), textarea";

const FOLDED_KEY = "prompt-settings:folded";

// A line break pasted into a box becomes a space, so the text stays one line.
const oneLine = (box) => {
  if (!box.value.includes("\n")) return box.value;
  const at = box.selectionStart;
  box.value = box.value.replace(/\r?\n/g, " ");
  box.setSelectionRange(at, at);
  return box.value;
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // Which sets are folded or open, kept in this browser (3.1) under the component's name.
    let folds = {};
    try {
      const kept = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "{}");
      if (kept && typeof kept === "object" && !Array.isArray(kept)) {
        folds = Object.fromEntries(Object.entries(kept).filter(([, v]) => typeof v === "boolean"));
      }
    } catch {
      // No storage, or something unreadable in it: every set starts folded.
    }
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, folds },
      events: { "prompt-set.saved": saved },
    });
    let keptFolds = this.actor.getSnapshot().context.folds;
    this.subscription = this.actor.subscribe((snapshot) => {
      if (snapshot.context.folds !== keptFolds) {
        keptFolds = snapshot.context.folds;
        try {
          localStorage.setItem(FOLDED_KEY, JSON.stringify(keptFolds));
        } catch {
          // No storage: the folds last for this page.
        }
      }
      this.host.requestUpdate();
    });
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

class PromptSettings extends LitElement {
  static styles = css`
    /* The same column as the other tabs of the sheet (generator-settings). */
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
      color: var(--color-body);
    }
    .top {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-md);
      margin-bottom: var(--space-md);
    }
    .note {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .sets {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    /* An open set stands apart from the folded names under it by a rule, as in the design. */
    .set.open {
      padding-bottom: var(--space-md);
      margin-bottom: var(--space-xs);
      border-bottom: var(--border-width) solid var(--color-border);
    }
    /* The heading folds its set: a caret that points right while folded and down while
       open, so the state is seen (Don Norman: visible signifiers). */
    .heading {
      margin: 0;
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    .set.open .heading {
      font-size: var(--text-subtitle);
    }
    /* The caret in a column of its own, so a name and its line that wrap stay beside it. */
    button.fold {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: baseline;
      column-gap: var(--space-xs);
      width: 100%;
      padding: var(--space-2xs) 0;
      border-color: transparent;
      background: transparent;
      font-weight: inherit;
      font-size: inherit;
      text-align: left;
      color: var(--color-ink);
    }
    button.fold:hover {
      background: transparent;
      color: var(--color-accent-hover);
    }
    .what {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      column-gap: var(--space-xs);
    }
    .caret {
      display: inline-flex;
      align-items: center;
      align-self: start;
      height: calc(var(--text-body) * var(--leading-tight));
      font-size: var(--text-body);
      color: var(--color-mute);
      transition: transform var(--duration-fast) var(--ease);
    }
    /* The caret stands in the middle of the name's first line. */
    .set.open .caret {
      height: calc(var(--text-subtitle) * var(--leading-tight));
    }
    button.fold[aria-expanded="true"] .caret {
      transform: rotate(90deg);
    }
    .beside {
      font-size: var(--text-sm);
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding-top: var(--space-sm);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      margin: 0;
      min-width: 0;
    }
    .caption {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .grow {
      display: grid;
      flex: 1;
      min-width: 0;
    }
    .grow::after {
      content: attr(data-text) " ";
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      visibility: hidden;
    }
    .grow::after,
    textarea {
      grid-area: 1 / 1;
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      font: inherit;
      line-height: var(--leading-normal);
      padding: var(--space-2xs) var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    textarea {
      margin: 0;
      resize: none;
      overflow: hidden;
      overflow-wrap: anywhere;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
    }
    textarea::placeholder {
      color: var(--color-mute);
    }
    textarea:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    .prompts {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2xs);
    }
    /* The move buttons show while the pointer or the keyboard is on the row, and always
       where there is no pointer to hover with, as on the Values sheet. Hidden, they stay
       focusable, so the keyboard can follow a prompt as it moves. */
    .order {
      display: flex;
      opacity: 0;
    }
    .row:hover .order,
    .row:focus-within .order,
    :host([phone]) .order {
      opacity: 1;
    }
    @media (hover: none) {
      .order {
        opacity: 1;
      }
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
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: default;
      color: var(--color-mute);
      background: transparent;
    }
    button.icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-xs);
      border-color: transparent;
      background: transparent;
      color: var(--color-mute);
    }
    button.icon:hover:not(:disabled) {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    button.icon svg {
      display: block;
    }
    button.new {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }
    /* New prompt reads as a place for the next prompt: a dashed box in the column of the
       prompts' boxes. */
    button.add {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      border-style: dashed;
      color: var(--color-body-mid);
      text-align: left;
    }
    button.delete {
      align-self: flex-start;
      border-color: transparent;
      background: transparent;
      padding-inline: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    button.delete:hover {
      background: transparent;
      text-decoration: underline;
    }
  `;

  #actor = new ActorController(this);
  // The stop that last held the keyboard in this tab.
  #last = null;
  // Where the keyboard goes once the next render lands: a selector, and a caret to keep.
  #after = null;

  constructor() {
    super();
    this.addEventListener("keydown", (e) => this.#key(e));
  }

  #send(event) {
    this.#actor.send(event);
  }

  // Views only read the document (7.5): the move buttons always show in the phone preview.
  #viewport = new MutationObserver(() => this.#frame());

  #frame() {
    this.toggleAttribute("phone", document.documentElement.getAttribute("data-viewport") === "phone");
  }

  connectedCallback() {
    super.connectedCallback();
    this.#frame();
    this.#viewport.observe(document.documentElement, { attributes: true, attributeFilter: ["data-viewport"] });
  }

  disconnectedCallback() {
    this.#viewport.disconnect();
    super.disconnectedCallback();
  }

  // The sheet hands the keyboard to the tab by its host (dock-desk): back to the stop last
  // used, else the first one.
  focus(options) {
    const target = this.#last?.isConnected && this.renderRoot.contains(this.#last) ? this.#last : this.#stops()[0];
    if (target) target.focus(options);
    else super.focus(options);
  }

  // Safari does not focus a pressed button, so the press would drop the keyboard on the
  // page. The press focuses what it pressed instead, without scrolling, and the click still
  // lands on it.
  #pressed(event) {
    const control = event.composedPath()[0]?.closest?.("button");
    if (!control || !this.renderRoot.contains(control) || control.disabled) return;
    event.preventDefault();
    control.focus({ preventScroll: true });
  }

  // --- The keyboard path (12, "Vim keys") --------------------------------------------

  #stops() {
    return [...this.renderRoot.querySelectorAll(STOPS)].filter((el) => !el.disabled);
  }

  // From one stop to the one `step` gives: down, up, first or last. Past either end the
  // keyboard stays, so the move is not lost to the page around.
  #move(from, step) {
    const stops = this.#stops();
    const at = stops.indexOf(from);
    const to = { down: at + 1, up: at - 1, first: 0, last: stops.length - 1 }[step];
    if (to == null || to < 0 || to >= stops.length || to === at) return false;
    stops[to].focus();
    return true;
  }

  // gg is two presses, so a first g waits a moment for the second, as in the lists.
  #gAt = 0;
  #key(event) {
    if (event.defaultPrevented) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element) || !this.renderRoot.contains(target)) return;
    const typing = target.tagName === "TEXTAREA";
    const by = typing && target.classList.contains("prompt") ? moveKey(event) : null;
    if (by) {
      event.preventDefault();
      return this.#movePrompt(target, by);
    }
    if (typing && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      return this.#next(target);
    }
    if (typing && !this.#atEdge(target, event.key)) return;
    const vim = this.#actor.snapshot?.context.vimKeys === true;
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const action = stopKey(event, { typing, vim, afterG });
    this.#gAt = action === "g" ? Date.now() : 0;
    if (!action) return;
    if (action === "g") return event.preventDefault();
    if (this.#move(target, action)) event.preventDefault();
  }

  // A box that wraps onto more lines keeps the up and down arrows for its own lines: the
  // up arrow leaves it from the very start of its text and the down arrow from the very
  // end. A box of one line is left at once.
  #atEdge(box, key) {
    if (key !== "ArrowUp" && key !== "ArrowDown") return true;
    const style = getComputedStyle(box);
    const lines = Math.round((box.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight));
    if (lines <= 1) return true;
    if (box.selectionStart !== box.selectionEnd) return false;
    return key === "ArrowUp" ? box.selectionStart === 0 : box.selectionEnd === box.value.length;
  }

  // Enter in a box goes to the next box of its set, and after the last prompt to New prompt.
  #next(box) {
    const section = box.closest(".set");
    const boxes = [...section.querySelectorAll("textarea")];
    (boxes[boxes.indexOf(box) + 1] ?? section.querySelector("button.add"))?.focus();
  }

  // Alt+Up or Alt+Down: the prompt moves, and the keyboard goes with it, the caret kept.
  #movePrompt(box, by) {
    const id = box.closest(".set").dataset.id;
    const index = Number(box.dataset.index);
    const caret = box.selectionStart;
    this.#shift(id, index, by, caret);
  }

  #shift(id, index, by, caret = null) {
    const prompts = this.#actor.snapshot && shownOf(this.#actor.snapshot.context).find((s) => s.id === id)?.prompts;
    if (!prompts || index + by < 0 || index + by >= prompts.length) return;
    this.#after = { selector: `.set[data-id="${id}"] textarea.prompt[data-index="${index + by}"]`, caret };
    this.#send({ type: "_movePrompt", id, index, by });
  }

  // --- Acting --------------------------------------------------------------------------

  #new() {
    this.#after = { selector: ".set textarea.name" };
    this.#send({ type: "_new" });
  }

  #addPrompt(id) {
    this.#after = { selector: `.set[data-id="${id}"] textarea.prompt`, last: true };
    this.#send({ type: "_addPrompt", id });
  }

  // The keyboard takes the prompt that stands where the removed one stood, else New prompt.
  #removePrompt(id, index) {
    this.#after = { selector: `.set[data-id="${id}"] textarea.prompt[data-index="${index}"]`, or: `.set[data-id="${id}"] button.add` };
    this.#send({ type: "_removePrompt", id, index });
  }

  // The keyboard takes the heading of the set that stands where the deleted one stood,
  // else the one above, else New set.
  #delete(id) {
    const headings = [...this.renderRoot.querySelectorAll(".set")].map((s) => s.dataset.id);
    const at = headings.indexOf(id);
    const next = headings[at + 1] ?? headings[at - 1];
    this.#after = { selector: next ? `.set[data-id="${next}"] button.fold` : "button.new" };
    this.#send({ type: "_delete", id });
  }

  updated() {
    const after = this.#after;
    if (!after) return;
    this.#after = null;
    const found = after.last ? [...this.renderRoot.querySelectorAll(after.selector)].pop() : this.renderRoot.querySelector(after.selector);
    const el = found ?? (after.or ? this.renderRoot.querySelector(after.or) : null);
    if (!el) return;
    el.focus();
    if (after.caret != null && el.setSelectionRange) el.setSelectionRange(after.caret, after.caret);
  }

  // --- Drawing -------------------------------------------------------------------------

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    if (context.failed) return html`<p class="note">Prompt sets unavailable.</p>`;
    if (!context.sets) return nothing;
    return html`
      <div class="top" @focusin=${(e) => (this.#last = e.composedPath()[0])}>
        <p class="note">
          Sets of questions you answer in the journal, from + Add sheet › Journal prompts. Every set is yours to change; those based on a
          book came with the app.
        </p>
        <button type="button" class="new" @mousedown=${(e) => this.#pressed(e)} @click=${() => this.#new()}>${icon("plus")}New set</button>
      </div>
      <div class="sets">${shownOf(context).map((s) => this.#set(s))}</div>
    `;
  }

  #set(s) {
    const name = s.name.trim() || "New set";
    const beside = besideOf(s);
    return html`
      <section
        class="set ${s.folded ? "" : "open"}"
        data-id=${s.id}
        aria-label=${name}
        @mousedown=${(e) => this.#pressed(e)}
        @focusin=${(e) => (this.#last = e.composedPath()[0])}
      >
        <h2 class="heading">
          <button type="button" class="fold" aria-expanded=${s.folded ? "false" : "true"} @click=${() => this.#send({ type: "_fold", id: s.id })}>
            <span class="caret">${icon("caret-right")}</span
            ><span class="what"><span>${name}</span>${s.folded && beside ? html`<span class="beside">${beside}</span>` : nothing}</span>
          </button>
        </h2>
        ${s.folded ? nothing : this.#body(s, name)}
      </section>
    `;
  }

  #text(s, field, label, placeholder, cls = "") {
    return html`
      <label class="field">
        <span class="caption">${label}</span>
        <span class="grow" data-text=${s[field]}>
          <textarea
            rows="1"
            class=${cls}
            placeholder=${placeholder}
            .value=${s[field]}
            @input=${(e) => this.#send({ type: "_edit", id: s.id, field, value: oneLine(e.target) })}
            @blur=${() => this.#send({ type: "_blur" })}
          ></textarea>
        </span>
      </label>
    `;
  }

  #body(s, name) {
    const last = s.prompts.length - 1;
    return html`
      <div class="body">
        ${this.#text(s, "name", "Name", "Name the set", "name")}
        ${this.#text(s, "occasion", "Occasion", "Such as Morning, Evening or Hard moment")}
        ${this.#text(s, "basedOn", "Based on", "A book and its author, if any")}
        <div class="field">
          <span class="caption" id="prompts-${s.id}">Prompts</span>
          <ol class="prompts" aria-labelledby="prompts-${s.id}">
            ${s.prompts.map(
              (p, i) => html`
                <li class="row">
                  <span class="grow" data-text=${p}>
                    <textarea
                      rows="1"
                      class="prompt"
                      data-index=${i}
                      aria-label="Prompt ${i + 1}"
                      placeholder="Write a question"
                      .value=${p}
                      @input=${(e) => this.#send({ type: "_editPrompt", id: s.id, index: i, value: oneLine(e.target) })}
                      @blur=${() => this.#send({ type: "_blur" })}
                    ></textarea>
                  </span>
                  <span class="order">
                    <button type="button" class="icon move" ?disabled=${i === 0} aria-label="Move prompt ${i + 1} up" title="Move up" @click=${() => this.#shift(s.id, i, -1)}>
                      ${icon("arrow-up")}
                    </button>
                    <button
                      type="button"
                      class="icon move"
                      ?disabled=${i === last}
                      aria-label="Move prompt ${i + 1} down"
                      title="Move down"
                      @click=${() => this.#shift(s.id, i, 1)}
                    >
                      ${icon("arrow-down")}
                    </button>
                  </span>
                  <button type="button" class="icon remove" aria-label="Remove prompt ${i + 1}" title="Remove prompt" @click=${() => this.#removePrompt(s.id, i)}>
                    ${icon("x")}
                  </button>
                </li>
              `,
            )}
          </ol>
          <button type="button" class="add" @click=${() => this.#addPrompt(s.id)}>${icon("plus")}New prompt</button>
        </div>
        <button type="button" class="delete" @click=${() => this.#delete(s.id)}>Delete set</button>
      </div>
    `;
  }
}

customElements.define("prompt-settings", PromptSettings);
