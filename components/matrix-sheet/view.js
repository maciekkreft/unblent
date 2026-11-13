import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask, send } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, PLACES, writable, shownMatrix, shownPlace, ordered, tagOf, cardOf, copiedLabel, taskKey, pathTarget } from "./machine.js";
import saved from "./events/matrix.saved.json" with { type: "json" };
import add from "./commands/add.json" with { type: "json" };

// The view sits in journal-entry's slot, under the day's text inside its scrolling page, so it
// scrolls with the day it is about. It is drawn like wheel-sheet: the same section, card,
// sheet and buttons.

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
        mint: ulid,
        now: () => Date.now(),
      },
      events: { "matrix.saved": saved },
      commands: { add },
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

class MatrixSheet extends LitElement {
  static styles = css`
    :host {
      display: block;
      container-type: inline-size;
      color: var(--color-body);
    }
    /* The page around spaces what it holds with a gap, so a day without a matrix must take
       no place in it at all to look unchanged. */
    :host([idle]) {
      display: none;
    }
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
    h3,
    .cap {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--color-body-mid);
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
    button:focus-visible,
    input:focus-visible,
    .txt:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    svg {
      display: block;
    }
    .sheet {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      box-sizing: border-box;
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
    }
    .add {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    input {
      font: inherit;
      color: var(--color-ink);
      width: 100%;
      box-sizing: border-box;
      padding: var(--space-sm);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    input::placeholder {
      color: var(--color-mute);
    }
    .add small,
    .caption {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .tray {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm);
      border: var(--border-width) dashed var(--color-border-strong);
      border-radius: var(--radius-sm);
    }
    .matrix {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
      gap: var(--space-sm);
    }
    .axis {
      text-align: center;
    }
    .axis.side {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
    }
    .quad {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      min-width: 0;
      min-height: calc(var(--space-2xl) + var(--space-xl));
      padding: var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .quad.do {
      background: var(--color-accent-subtle);
      border-color: var(--color-accent);
    }
    .quad.drop {
      background: var(--color-canvas-soft);
    }
    .qhead {
      display: flex;
      align-items: baseline;
      gap: var(--space-sm);
      flex-wrap: wrap;
      padding: 0 var(--space-xs);
    }
    .qhead b {
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .qhead span {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .qhead .where {
      display: none;
    }
    .none {
      font-size: var(--text-sm);
      color: var(--color-mute);
      padding: 0 var(--space-xs);
    }
    .task {
      display: flex;
      flex-direction: column;
      border-radius: var(--radius-sm);
    }
    .task.placing,
    .task:focus-within {
      background: var(--color-surface-hover);
    }
    .quad.do .task.placing,
    .quad.drop .task.placing,
    .quad.do .task:focus-within,
    .quad.drop .task:focus-within {
      background: var(--color-surface-active);
    }
    .row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto auto;
      align-items: start;
    }
    .tick,
    .txt,
    .bin {
      border-color: transparent;
      background: transparent;
      border-radius: var(--radius-sm);
    }
    .tick {
      display: grid;
      place-items: center;
      padding: 0;
      font-size: var(--text-body);
      width: calc(var(--text-body) * var(--leading-normal) + var(--space-xs));
      height: calc(var(--text-body) * var(--leading-normal) + var(--space-xs));
      color: var(--color-body-mid);
    }
    button.tick:hover {
      color: var(--color-ink);
    }
    .txt {
      display: block;
      text-align: left;
      font-size: var(--text-body);
      line-height: var(--leading-normal);
      color: var(--color-ink);
      padding: var(--space-2xs) var(--space-xs);
      overflow-wrap: anywhere;
    }
    .txt:focus {
      outline: none;
    }
    .row input {
      padding: var(--space-2xs) var(--space-xs);
    }
    .task.done .txt {
      color: var(--color-body-mid);
      text-decoration: line-through;
    }
    .task.done .tick {
      color: var(--color-accent);
    }
    .tag {
      align-self: center;
      margin: 0 var(--space-xs);
      font-size: var(--text-caption);
      color: var(--color-body-mid);
      padding: 0 var(--space-xs);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-full);
      user-select: none;
      -webkit-user-select: none;
      white-space: nowrap;
    }
    .tag.unsure {
      border-style: dashed;
      color: var(--color-mute);
    }
    /* The place button draws the matrix, the task's own place filled. */
    .placebtn {
      grid-column: 4;
      align-self: center;
      display: inline-grid;
      grid-template-columns: repeat(2, calc(var(--space-xs) + var(--space-2xs)));
      gap: var(--space-2xs);
      padding: var(--space-xs);
      margin: 0 var(--space-xs);
      border-radius: var(--radius-sm);
    }
    .placebtn:hover {
      background: var(--color-surface-active);
    }
    .placebtn[aria-expanded="true"] {
      box-shadow: var(--focus-ring);
    }
    .placebtn i {
      width: calc(var(--space-xs) + var(--space-2xs));
      height: calc(var(--space-xs) + var(--space-2xs));
      border-radius: var(--border-width);
      background: var(--color-mute);
    }
    .placebtn i.on {
      background: var(--color-accent);
    }
    .place {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-xs) var(--space-sm);
    }
    .seg {
      display: grid;
      grid-template-columns: 1fr 1fr;
      flex: 1;
      min-width: 0;
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: var(--color-canvas);
    }
    .seg button {
      border: 0;
      border-radius: 0;
      padding: var(--space-xs) var(--space-sm);
      font-size: var(--text-caption);
      color: var(--color-body);
      box-shadow: 0 0 0 var(--border-width) var(--color-border);
    }
    .seg button:hover {
      background: var(--color-surface-hover);
    }
    .seg button[aria-pressed="true"] {
      background: var(--color-accent);
      color: var(--color-accent-text);
      font-weight: var(--weight-semibold);
    }
    .seg button:focus-visible {
      box-shadow: inset 0 0 0 var(--space-2xs) var(--color-accent);
    }
    .bin {
      display: grid;
      place-items: center;
      padding: var(--space-sm);
      color: var(--color-body-mid);
      font-size: var(--text-body);
    }
    .bin:hover {
      background: var(--color-surface-active);
      color: var(--color-ink);
    }
    .foot {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }
    .buttons {
      display: flex;
      gap: var(--space-sm);
      margin-left: auto;
    }
    .buttons button {
      padding: var(--space-xs) var(--space-md);
      border-radius: var(--radius-md);
    }
    .buttons button:hover {
      background: var(--color-surface-hover);
    }
    .buttons .done {
      background: var(--color-accent);
      border-color: var(--color-accent);
      color: var(--color-accent-text);
    }
    .buttons .done:hover {
      background: var(--color-accent-hover);
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      width: 100%;
      box-sizing: border-box;
      text-align: left;
      padding: var(--space-sm) var(--space-md);
      border-color: var(--color-border);
      border-radius: var(--radius-md);
      color: var(--color-body);
      overflow-wrap: anywhere;
    }
    .card:hover {
      border-color: var(--color-border-strong);
      background: var(--color-surface-hover);
    }
    .card span {
      display: block;
    }
    .item {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .line {
      font-size: var(--text-body);
      color: var(--color-ink);
    }
    .rest {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .card .cap {
      color: var(--color-accent-active);
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* A narrow page, such as a phone: the places stand under each other, Do first, each saying
       what it means, with larger targets for a finger. */
    @container (width < 30rem) {
      .matrix {
        grid-template-columns: minmax(0, 1fr);
      }
      .axis {
        display: none;
      }
      .qhead .where {
        display: inline;
      }
      .quad {
        min-height: 0;
      }
      .tick {
        width: var(--space-xl);
        height: var(--space-xl);
      }
      .txt {
        padding-block: var(--space-sm);
      }
      .placebtn {
        padding: var(--space-sm);
      }
      .seg button {
        padding-block: var(--space-sm);
      }
    }
  `;

  #actor = new ActorController(this);

  // Where the keyboard goes once the next render lands, as a selector. Kept here because the
  // elements exist only after render. Rows are drawn by position, so a task that moved to
  // another place is found again by its id.
  #focusNext = null;
  #landed = 0;
  // Whether the keyboard was inside before this render, and whether the last thing the user
  // did here was a press: after a press nothing moves.
  #holding = false;
  #byPress = false;
  // The key pressed just before and when, for gg and dd.
  #last = { key: null, at: 0 };

  #send(event, focus) {
    this.#focusNext = focus ?? null;
    this.#actor.send(event);
    this.requestUpdate();
  }

  #context() {
    return this.#actor.snapshot?.context;
  }

  // The tasks as the keyboard walks them.
  #tasks() {
    const context = this.#context();
    const m = context && shownMatrix(context);
    return m ? ordered(m.tasks) : [];
  }

  willUpdate() {
    this.#holding = this.matches(":focus-within");
    const snapshot = this.#actor.snapshot;
    const shows = snapshot && (snapshot.matches("failed") || Boolean(shownMatrix(snapshot.context)));
    this.toggleAttribute("idle", !shows);
  }

  updated() {
    const context = this.#context();
    if (context && context.landing !== this.#landed) {
      this.#landed = context.landing;
      this.#focusNext = ".add input";
    }
    if (this.#focusNext) {
      const el = this.renderRoot.querySelector(this.#focusNext);
      el?.focus();
      if (el?.classList.contains("words")) el.setSelectionRange(el.value.length, el.value.length);
      this.#focusNext = null;
    }
    if (this.matches(":focus-within")) return;
    // What held the keyboard went (the last task deleted, an Undo, a new matrix not kept).
    if (this.#holding && !this.#byPress) this.#actor.send({ type: "_handBack" });
  }

  #focusTask(id) {
    this.renderRoot.querySelector(`.txt[data-id="${id}"]`)?.focus();
  }

  // Where a move on the sheet's path landed (pathTarget).
  #focusAt(to, tasks) {
    if (to === "add") return this.renderRoot.querySelector(".add input")?.focus();
    if (to === "done") return this.renderRoot.querySelector(".buttons button")?.focus();
    return this.#focusTask(tasks[to].id);
  }

  // journal-entry hands the keyboard by the host: the first task, or Done from below. A folded
  // card takes it itself.
  focus(options) {
    const card = this.renderRoot?.querySelector(".card");
    if (card) return card.focus(options);
    if (!this.renderRoot?.querySelector(".sheet")) return;
    const tasks = this.#tasks();
    this.#focusAt(options?.from === "below" || !tasks.length ? "done" : 0, tasks);
  }

  #take(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  #key = (event) => {
    this.#byPress = false;
    if (event.defaultPrevented || event.isComposing) return;
    const target = event.composedPath()[0];
    const context = this.#context();
    const write = writable(context);
    const tasks = this.#tasks();
    if (target.classList?.contains("words")) return this.#wordsKey(event, target);
    if (target.matches?.(".add input")) return this.#addKey(event, target, tasks);
    const onTask = target.classList?.contains("txt");
    const onDone = target.matches?.(".buttons button");
    const id = target.closest?.(".task")?.dataset.id ?? null;
    if (event.key === "Escape" && context.open) {
      this.#take(event);
      const placing = context.placing;
      return this.#send({ type: "_escape" }, placing ? `.txt[data-id="${placing}"]` : ".card");
    }
    if (!onTask && !onDone) return;
    const after = Date.now() - this.#last.at < 1000 ? this.#last.key : null;
    const key = taskKey(event, context.vimKeys === true, after);
    this.#last = { key: key?.wait ?? null, at: key?.wait ? Date.now() : 0 };
    if (!key) return;
    if (key.wait) return event.preventDefault();
    if (key.go) {
      const at = onDone ? "done" : tasks.findIndex((t) => t.id === id);
      const to = pathTarget(key.go, at, tasks.length, { arrow: key.arrow === true, write });
      // Past either end the key is not used here, so it bubbles on to the page around.
      if (to === "leave") return;
      this.#take(event);
      return this.#focusAt(to, tasks);
    }
    if (key.add && write) {
      this.#take(event);
      return this.renderRoot.querySelector(".add input")?.focus();
    }
    if (!onTask || !write) return;
    if (key.move) {
      this.#take(event);
      return this.#send({ type: "_move", id, dir: key.move }, `.txt[data-id="${id}"]`);
    }
    if (key.tick) {
      this.#take(event);
      return this.#send({ type: "_tick", id }, `.txt[data-id="${id}"]`);
    }
    if (key.edit) {
      this.#take(event);
      return this.#send({ type: "_edit", id }, ".words");
    }
    if (key.remove) {
      this.#take(event);
      return this.#delete(id);
    }
  };

  // The keyboard moves on to the next task, or the one before; with none to the Add a task line.
  #delete(id) {
    const tasks = this.#tasks();
    const at = tasks.findIndex((t) => t.id === id);
    const next = tasks[at + 1] ?? tasks[at - 1];
    this.#send({ type: "_delete", id }, next ? `.txt[data-id="${next.id}"]` : ".add input");
  }

  // Enter keeps the new words and Escape gives the old ones back; either goes back to the task.
  #wordsKey(event, input) {
    const id = input.dataset.id;
    if (event.key === "Enter") {
      this.#take(event);
      this.#send({ type: "_words", id, text: input.value }, `.txt[data-id="${id}"]`);
    } else if (event.key === "Escape") {
      this.#take(event);
      this.#send({ type: "_unedit" }, `.txt[data-id="${id}"]`);
    }
  }

  #addKey(event, input, tasks) {
    if (event.key === "Enter") {
      this.#take(event);
      if (input.value.trim()) this.#send({ type: "_add", text: input.value }, ".add input");
    } else if (event.key === "ArrowDown") {
      this.#take(event);
      this.#focusAt(pathTarget("down", "add", tasks.length), tasks);
    } else if (event.key === "Escape") {
      this.#take(event);
      this.#send({ type: "_escape" }, ".card");
    }
  }

  // A text input drops the line breaks of what is pasted, so several lines are added here as
  // one task each.
  #paste = (event) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!/\r?\n/.test(text.trim())) return;
    event.preventDefault();
    this.#send({ type: "_add", text, pasted: true }, ".add input");
  };

  #press = () => {
    this.#byPress = true;
  };

  #card(context, m) {
    const { doing, rest } = cardOf(m);
    const write = writable(context);
    const none = write ? "Nothing urgent and important is left." : "Nothing urgent and important was left.";
    return html`<button type="button" class="card" data-id=${m.id} aria-label="Eisenhower Matrix, press to open" @click=${() => this.#send({ type: "_open" }, write ? ".add input" : ".txt")}>
      <span class="item">
        <span class="cap">${write ? "Do today" : "Do"}</span>
        ${doing.length ? doing.map((text) => html`<span class="line">${text}</span>`) : html`<span class="line">${none}</span>`}
      </span>
      <span class="rest">${rest}</span>
    </button>`;
  }

  #task(context, task, write) {
    const placing = context.placing === task.id;
    const editing = context.editing === task.id;
    const tag = tagOf(task);
    const at = shownPlace(task);
    const label = PLACES.find((p) => p.id === at)?.name ?? "To sort";
    return html`<div class="task ${task.done ? "done" : ""} ${placing ? "placing" : ""}" data-id=${task.id}>
      <div class="row">
        ${write
          ? html`<button type="button" class="tick" tabindex="-1" aria-pressed=${task.done ? "true" : "false"} aria-label="Done: ${task.text}" @click=${() => this.#send({ type: "_tick", id: task.id })}>
              ${icon(task.done ? "check-square" : "square")}
            </button>`
          : html`<span class="tick" aria-label=${task.done ? "Done" : "Not done"}>${icon(task.done ? "check-square" : "square")}</span>`}
        ${editing
          ? html`<input
              class="words"
              data-id=${task.id}
              aria-label="The task's words"
              value=${task.text}
              autocomplete="off"
              @blur=${(e) => this.#actor.send({ type: "_words", id: task.id, text: e.target.value })}
            />`
          : write
            ? html`<button type="button" class="txt" data-id=${task.id} aria-label="${task.text}, in ${label}" @click=${() => this.#send({ type: "_edit", id: task.id }, ".words")}>${task.text}</button>`
            : html`<span class="txt" tabindex="0" data-id=${task.id} aria-label="${task.text}, in ${label}">${task.text}</span>`}
        ${tag ? html`<span class="tag ${tag.sure ? "" : "unsure"}" title=${tag.title}>${tag.label}</span>` : nothing}
        ${write
          ? html`<button
              type="button"
              class="placebtn"
              tabindex="-1"
              aria-expanded=${placing ? "true" : "false"}
              aria-label="Place: ${label}"
              @click=${() => this.#send({ type: "_placing", id: task.id })}
            >
              ${PLACES.map((p) => html`<i class=${p.id === at ? "on" : ""}></i>`)}
            </button>`
          : nothing}
      </div>
      ${placing
        ? html`<div class="place">
            <div class="seg" role="group" aria-label="Where this task goes">
              ${PLACES.map(
                (p) =>
                  html`<button type="button" data-place=${p.id} aria-pressed=${p.id === at ? "true" : "false"} @click=${() => this.#send({ type: "_place", id: task.id, place: p.id }, `.txt[data-id="${task.id}"]`)}>
                    ${p.name}
                  </button>`,
              )}
            </div>
            <button type="button" class="bin" aria-label="Delete this task" @click=${() => this.#delete(task.id)}>${icon("trash-simple")}</button>
          </div>`
        : nothing}
    </div>`;
  }

  #quad(context, tasks, p, write) {
    const list = tasks.filter((t) => shownPlace(t) === p.id);
    return html`<div class="quad ${p.id}" role="group" aria-label=${p.name}>
      <div class="qhead"><b>${p.name}</b><span>${p.hint}</span><span class="where">· ${p.where}</span></div>
      ${list.length ? list.map((t) => this.#task(context, t, write)) : html`<span class="none">Nothing here</span>`}
    </div>`;
  }

  #sheet(context, m) {
    const write = writable(context);
    const toSort = m.tasks.filter((t) => shownPlace(t) === null);
    const [doing, schedule, delegate, drop] = PLACES;
    const copied = copiedLabel(context, m);
    return html`<div class="sheet ${write ? "" : "read"}" data-id=${m.id} role="group" aria-label="Eisenhower Matrix">
      ${write
        ? html`<div class="add">
            <input
              type="text"
              placeholder="Add a task"
              aria-label="Add a task"
              autocomplete="off"
              .value=${context.adding}
              @input=${(e) => this.#actor.send({ type: "_draft", text: e.target.value })}
              @paste=${this.#paste}
            />
            <small>Enter adds it. A place is suggested, and you can change it.</small>
          </div>`
        : nothing}
      ${toSort.length
        ? html`<div class="tray" role="group" aria-label="To sort">
            <span class="cap">To sort</span>
            ${toSort.map((t) => this.#task(context, t, write))}
          </div>`
        : nothing}
      <div class="matrix">
        <span></span><span class="cap axis">Urgent</span><span class="cap axis">Not urgent</span>
        <span class="cap axis side">Important</span>${this.#quad(context, m.tasks, doing, write)}${this.#quad(context, m.tasks, schedule, write)}
        <span class="cap axis side">Not important</span>${this.#quad(context, m.tasks, delegate, write)}${this.#quad(context, m.tasks, drop, write)}
      </div>
      ${copied ? html`<p class="caption copied">${copied}</p>` : nothing}
      <div class="foot">
        <div class="buttons">
          ${write
            ? html`<button type="button" class="done" @click=${() => this.#send({ type: "_fold" }, ".card")}>Done</button>`
            : html`<button type="button" class="close" @click=${() => this.#send({ type: "_fold" }, ".card")}>Close</button>`}
        </div>
      </div>
    </div>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    const failed = snapshot.matches("failed");
    const m = shownMatrix(context);
    if (!failed && !m) return nothing;
    return html`<section tabindex="-1" aria-label="Eisenhower Matrix" @keydown=${this.#key} @pointerdown=${this.#press}>
      <h3>Eisenhower Matrix</h3>
      ${failed ? html`<p class="empty">The Eisenhower Matrix is unavailable.</p>` : context.open ? this.#sheet(context, m) : this.#card(context, m)}
    </section>`;
  }
}

customElements.define("matrix-sheet", MatrixSheet);
