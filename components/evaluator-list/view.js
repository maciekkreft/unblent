import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, rows, subtitle, askable, UNTITLED } from "./machine.js";
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

const ERRORS = {
  "signed-out": "Sign in to run evaluators.",
  key: "Add a Jev key in Settings.",
  busy: "Jev is busy. Try again in a moment.",
  failed: "Jev could not answer. Try again.",
};

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
    /* The book the list shows, so a list kept on a pinned book says which one; the same
       caption as the note editor's About line. */
    .about {
      margin: 0;
      padding: var(--space-xs) var(--space-md) 0;
      font-size: var(--text-caption);
      color: var(--color-mute);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
    /* The Run box sits above the list, outside it, so its keys never reach the list's. */
    .run {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md) var(--space-md) var(--space-sm);
      border-bottom: var(--border-width) solid var(--color-border);
    }
    .run label {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      font-size: var(--text-body);
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-sm);
      resize: vertical;
    }
    textarea::placeholder {
      color: var(--color-body-mid);
    }
    textarea:focus {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }
    .cost {
      flex: 1;
      min-width: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .actions button {
      flex: none;
      font: inherit;
      font-size: var(--text-sm);
      min-height: var(--space-xl);
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .actions button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .clear {
      color: var(--color-body);
      background: none;
      border: var(--border-width) solid var(--color-border);
    }
    .clear:hover {
      background: var(--color-surface-hover);
    }
    .go {
      font-weight: var(--weight-semibold);
      color: var(--color-accent-text);
      background: var(--color-accent);
      border: 0;
    }
    .go:hover:not(:disabled) {
      background: var(--color-accent-hover);
    }
    .go:disabled {
      color: var(--color-mute);
      background: var(--color-border);
      cursor: default;
    }
    .error {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    /* A row with results stacks its answers under its name. */
    .item {
      display: flex;
      flex-direction: column;
    }
    .score {
      flex: none;
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      background: var(--color-surface-hover);
      border-radius: var(--radius-full);
      padding: var(--space-2xs) var(--space-sm);
    }
    .not-run {
      flex: none;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    /* Indented past the tick box, so the answers sit under the name. */
    .answers {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      margin: 0;
      padding: var(--space-2xs) var(--space-sm) var(--space-sm) calc(var(--space-md) + var(--space-2xs) + var(--space-sm) * 2);
      list-style: none;
    }
    .answer {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .question {
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-body);
    }
    .meter {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }
    .track {
      flex: 1;
      height: calc(var(--space-xs) + var(--space-2xs));
      background: var(--color-surface-active);
      border-radius: var(--radius-full);
      overflow: hidden;
    }
    .fill {
      display: block;
      height: 100%;
      border-radius: var(--radius-full);
      background: var(--color-success);
    }
    .fill.low {
      background: var(--color-warning);
    }
    .label {
      flex: none;
      min-width: calc(var(--space-2xl) + var(--space-lg));
      text-align: right;
      font-size: var(--text-caption);
      color: var(--color-ink);
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

  // When the editor opens another evaluator, by a pick or by itself, the keyboard starts
  // again from that row rather than from where it last moved.
  #seenOpen = null;

  #focusRow(ids, open) {
    if (open !== this.#seenOpen) {
      this.#seenOpen = open;
      this.#focusId = null;
    }
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
    const { draft, open, evaluators, results, book, titles } = snapshot.context;
    const shown = rows(evaluators);
    const ids = [draft, ...shown.map((e) => e.id)];
    const focusId = this.#focusRow(ids, open);
    const ran = Object.keys(results).length > 0;
    return html`
      ${this.#header(snapshot)}
      ${this.#runBox(snapshot, ran)}
      <ul class="list" aria-label="Evaluators" @keydown=${(e) => this.#keydown(e, ids)} @focusin=${(e) => this.#focusin(e)}>
        <li class="row new" data-id=${draft} @click=${(e) => this.#rowClick(e, draft)}>
          <button class="open" type="button" tabindex=${draft === focusId ? 0 : -1}>
            <span class="name draft">${icon("plus")}New evaluator</span>
          </button>
        </li>
        ${shown.map((e) =>
          this.#row(e, open, focusId, ran ? (results[e.id] ?? "not run") : null, e.book === book ? null : (titles[e.book] ?? "Another book")),
        )}
      </ul>
    `;
  }

  // Only while following the stage: the book the list shows (12).
  #header(snapshot) {
    const { following, book, titles } = snapshot.context;
    const title = following ? titles[book] : null;
    return title ? html`<p class="about">About: ${title}</p>` : nothing;
  }

  #runBox(snapshot, ran) {
    const { text, evaluators, error, running } = snapshot.context;
    const n = askable(evaluators).length;
    const cost =
      n > 0
        ? `Runs the ${n} switched-on evaluator${n === 1 ? "" : "s"} · 1 request`
        : rows(evaluators).some((e) => e.on)
          ? "Write a question in a switched-on evaluator to run it."
          : "Switch an evaluator on to run it.";
    return html`
      <div class="run">
        <label for="text">Try on a text</label>
        <textarea
          id="text"
          rows="3"
          placeholder="Type or paste a text to judge…"
          .value=${text}
          @input=${(event) => this.#actor.send({ type: "_type", text: event.target.value })}
        ></textarea>
        <div class="actions">
          <span class="cost">${cost}</span>
          ${ran ? html`<button class="clear" type="button" @click=${() => this.#actor.send({ type: "_clear" })}>Clear</button>` : nothing}
          <button class="go" type="button" ?disabled=${running || n === 0 || text.trim() === ""} @click=${() => this.#actor.send({ type: "_run" })}>
            ${running ? "Running…" : "Run"}
          </button>
        </div>
        ${error ? html`<p class="error" role="alert">${ERRORS[error]}</p>` : nothing}
      </div>
    `;
  }

  // result: null before any run, "not run", or the evaluator's answers and score.
  // from: the title of the book a row shown in the journal is kept with, or null.
  #row(e, open, focusId, result, from) {
    const tab = e.id === focusId ? 0 : -1;
    const name = e.name.trim();
    return html`
      <li class="item">
        <div class="row ${e.id === open ? "current" : ""}" data-id=${e.id} @click=${(event) => this.#rowClick(event, e.id)}>
          <input
            type="checkbox"
            tabindex=${tab}
            .checked=${e.on}
            aria-label="${name || UNTITLED} is on"
            @change=${(event) => this.#actor.send({ type: "_switch", id: e.id, on: event.target.checked })}
          />
          <button class="open" type="button" tabindex=${tab} aria-current=${e.id === open ? "true" : nothing}>
            <span class="name ${name ? (e.on ? "" : "off") : "untitled"}">${name || UNTITLED}</span>
            <span class="sub">${subtitle(e, from)}</span>
          </button>
          ${result === "not run"
            ? html`<span class="not-run">not run</span>`
            : result?.score != null
              ? html`<span class="score">${result.score.toFixed(2)}</span>`
              : nothing}
        </div>
        ${result && result !== "not run"
          ? html`<ul class="answers" aria-label="Answers">
              ${result.questions.map(
                (q) => html`<li class="answer">
                  <span class="question">${q.text}</span>
                  <span class="meter">
                    <span class="track"><span class="fill ${q.p < 0.5 ? "low" : ""}" style="width: ${Math.round(q.p * 100)}%"></span></span>
                    <span class="label">${q.label} ${q.p.toFixed(2)}</span>
                  </span>
                </li>`,
              )}
            </ul>`
          : nothing}
      </li>
    `;
  }
}

customElements.define("evaluator-list", EvaluatorList);
