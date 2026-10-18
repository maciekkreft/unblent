import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, rows, subtitle, askable, lines, UNTITLED, freeStop, notice, STOPS, evaluateLabel, foldLine, foldedAtStart } from "./machine.js";
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
        drafts,
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

// The Run box's text, one entry per book, kept across reloads (3.1): the view's own UI
// state under a key named for the component, so it follows the browser, not the account,
// and losing it loses nothing. A browser refusing storage reads nothing and drops the write.
const KEY = "evaluator-list.drafts";
const readAll = () => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
};
const drafts = {
  read(book) {
    const text = readAll()[book];
    return typeof text === "string" ? text : "";
  },
  write(book, text) {
    try {
      const all = readAll();
      if (text) all[book] = text;
      else delete all[book];
      if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all));
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the text lives only for this page.
    }
  },
};

// Whether the user last hid the list of evaluators, kept in this browser (3.1) as "true" or
// "false"; it wins over the page's `folded`. A browser refusing storage reads nothing.
const FOLD_KEY = "evaluator-list.folded";
const readFold = () => {
  try {
    return localStorage.getItem(FOLD_KEY);
  } catch {
    return null;
  }
};
const writeFold = (folded) => {
  try {
    localStorage.setItem(FOLD_KEY, String(folded));
  } catch {
    // No persistence available; the fold lives only for this page.
  }
};

// The glyphs an answer may start with, as literals so the icon check can read them (7.6):
// the icons an evaluator may give an option, and the check and warning of an expected answer.
const GLYPHS = {
  footprints: () => icon("footprints"),
  "person-simple-walk": () => icon("person-simple-walk"),
  brain: () => icon("brain"),
  heart: () => icon("heart"),
  trophy: () => icon("trophy"),
  "hand-palm": () => icon("hand-palm"),
  question: () => icon("question"),
  check: () => icon("check"),
  warning: () => icon("warning"),
};

const ERRORS = {
  "signed-out": "Sign in to run evaluators.",
  key: "Add a Jev key in Settings.",
  "used-up": "You have used all your free use.",
  paused: "Free trials are paused for now.",
  blocked: "This trial has ended.",
  busy: "Jev is busy. Try again in a moment.",
  failed: "Jev could not answer. Try again.",
};

class EvaluatorList extends LitElement {
  // Follow the book open on the stage. Reflected so a page's bare `subject` reads as true.
  // `folded`: the list of evaluators starts hidden under the Evaluate box.
  static properties = { subject: { type: Boolean, reflect: true }, folded: { type: Boolean } };

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
    /* The Evaluate box sits above the list, outside it, so its keys never reach the list's. */
    .run {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md) var(--space-md) var(--space-sm);
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
    /* The fold line and the buttons; on a narrow panel the buttons wrap under the fold line.
       Every target is at least 44px tall, for a finger. */
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-sm);
    }
    .actions button {
      font: inherit;
      font-size: var(--text-sm);
      min-height: calc(var(--space-xl) + var(--space-xs));
      border-radius: var(--radius-md);
      cursor: pointer;
    }
    .actions button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .fold {
      flex: 0 1 auto;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: 0 var(--space-xs);
      margin-left: calc(var(--space-xs) * -1);
      text-align: left;
      color: var(--color-body);
      background: none;
      border: 0;
    }
    .fold:hover {
      background: var(--color-surface-hover);
    }
    .fold svg {
      flex: none;
      transition: transform var(--duration-slide) ease;
    }
    .fold[aria-expanded="true"] svg {
      transform: rotate(90deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .fold svg {
        transition: none;
      }
    }
    .fold b {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .buttons {
      flex: none;
      display: flex;
      gap: var(--space-sm);
      margin-left: auto;
    }
    .buttons button {
      padding: var(--space-sm) var(--space-md);
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
    /* The list of evaluators, when shown, between the box and the results. */
    .list {
      border-top: var(--border-width) solid var(--color-border);
      border-bottom: var(--border-width) solid var(--color-border);
    }
    .out {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-sm) var(--space-md) var(--space-md);
    }
    .out:empty {
      display: none;
    }
    /* The free-use message (try-links screen 2): danger when this guest is out, warning
       while trials are paused for everyone. */
    .notice {
      margin: 0;
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-sm);
      font-size: var(--text-sm);
      color: var(--color-ink);
      background: var(--color-warning-subtle);
    }
    .notice.used-up,
    .notice.blocked {
      background: var(--color-danger-subtle);
    }
    .error {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    /* The results, one block per line of the text, in the order of the text. */
    .lines {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .line {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding-top: var(--space-sm);
      border-top: var(--border-width) solid var(--color-border);
    }
    .line:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .said {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      margin: 0;
      font-size: var(--text-body);
      line-height: var(--leading-tight);
      color: var(--color-ink);
      overflow-wrap: anywhere;
    }
    /* The line being asked: the same pulsing dot as a choice point's pending check. */
    .dot {
      flex: none;
      width: calc(var(--space-xs) * 1.5);
      height: calc(var(--space-xs) * 1.5);
      border-radius: var(--radius-full);
      background: var(--color-mute);
      animation: pulse calc(var(--duration-slide) * 4) ease-in-out infinite;
    }
    @keyframes pulse {
      50% {
        opacity: 0.3;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot {
        animation: none;
      }
    }
    .verdict {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .by {
      margin: var(--space-2xs) 0 0;
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .answers {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .answer {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      column-gap: var(--space-sm);
      font-size: var(--text-sm);
      line-height: var(--leading-normal);
    }
    .question {
      color: var(--color-body-mid);
    }
    .words {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    /* The answer's glyph, coloured as a choice point's marks: green when it is the answer
       expected, red when not, plain when nothing is expected. */
    .glyph {
      flex: none;
      align-self: center;
      display: inline-grid;
      place-items: center;
      width: calc(var(--text-sm) + var(--space-xs) * 2);
      height: calc(var(--text-sm) + var(--space-xs) * 2);
      border-radius: var(--radius-sm);
      color: var(--color-body-mid);
    }
    .glyph svg {
      display: block;
    }
    .glyph.right {
      color: var(--color-success);
      background: var(--color-success-subtle);
    }
    .glyph.wrong {
      color: var(--color-danger);
      background: var(--color-danger-subtle);
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
    // With the list hidden, the fold line that shows it.
    const target =
      this.renderRoot?.querySelector('.open[tabindex="0"]') ?? this.renderRoot?.querySelector(".open") ?? this.renderRoot?.querySelector(".fold");
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

  // Whether the list of evaluators is hidden: read once, from this browser's last fold or
  // else the page's `folded`, then the user's own.
  #folded = null;

  #isFolded() {
    if (this.#folded == null) this.#folded = foldedAtStart(this.folded, readFold());
    return this.#folded;
  }

  #toggleFold() {
    this.#folded = !this.#isFolded();
    writeFold(this.#folded);
    this.requestUpdate();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("idle")) return html`<p class="empty">Open a book to see its evaluators.</p>`;
    if (snapshot.matches("failed")) return html`<p class="empty">Evaluators unavailable.</p>`;
    const { draft, open, evaluators, book, titles, runs } = snapshot.context;
    const shown = rows(evaluators);
    const ids = [draft, ...shown.map((e) => e.id)];
    const focusId = this.#focusRow(ids, open);
    const stop = notice(snapshot.context);
    return html`
      ${this.#header(snapshot)}
      ${this.#runBox(snapshot)}
      ${this.#isFolded()
        ? nothing
        : html`<ul class="list" id="evaluators" aria-label="Evaluators" @keydown=${(e) => this.#keydown(e, ids)} @focusin=${(e) => this.#focusin(e)}>
            <li class="row new" data-id=${draft} @click=${(e) => this.#rowClick(e, draft)}>
              <button class="open" type="button" tabindex=${draft === focusId ? 0 : -1}>
                <span class="name draft">${icon("plus")}New evaluator</span>
              </button>
            </li>
            ${shown.map((e) => this.#row(e, open, focusId, e.book === book ? null : (titles[e.book] ?? "Another book")))}
          </ul>`}
      <div class="out">${stop ? html`<p class="notice ${stop}" role="status">${ERRORS[stop]}</p>` : nothing}${this.#lines(runs, evaluators)}</div>
    `;
  }

  // Only while following the stage: the book the list shows (12).
  #header(snapshot) {
    const { following, book, titles } = snapshot.context;
    const title = following ? titles[book] : null;
    return title ? html`<p class="about">About: ${title}</p>` : nothing;
  }

  #runBox(snapshot) {
    const { text, evaluators, runs, running, freeUse } = snapshot.context;
    const asked = askable(evaluators);
    const names = asked.map((a) => evaluators.find((e) => e.id === a.id)?.name.trim() || UNTITLED);
    const folded = this.#isFolded();
    const parts = foldLine(names, rows(evaluators).some((e) => e.on));
    return html`
      <div class="run">
        <label for="text">Write one sentence per line</label>
        <textarea
          id="text"
          rows="3"
          placeholder="Write or paste your text. Each line is evaluated on its own."
          .value=${text}
          @input=${(event) => this.#actor.send({ type: "_type", text: event.target.value })}
        ></textarea>
        <div class="actions">
          <button class="fold" type="button" aria-expanded=${folded ? "false" : "true"} aria-controls="evaluators" @click=${() => this.#toggleFold()}>
            ${icon("caret-right")}<span>${parts.map(([part, bold]) => (bold ? html`<b>${part}</b>` : part))}</span>
          </button>
          <span class="buttons">
            ${runs.length > 0 ? html`<button class="clear" type="button" @click=${() => this.#actor.send({ type: "_clear" })}>Clear</button>` : nothing}
            <button
              class="go"
              type="button"
              ?disabled=${running || asked.length === 0 || text.trim() === "" || freeStop(freeUse) != null}
              @click=${() => this.#actor.send({ type: "_run" })}
            >
              ${evaluateLabel(lines(text).length, running)}
            </button>
          </span>
        </div>
      </div>
    `;
  }

  // A line not asked yet shows nothing, so the blocks appear one after another as Jev
  // answers, and a failure leaves only what was answered and the reason.
  #lines(runs, evaluators) {
    const shown = runs.filter((r) => r.status !== "waiting");
    if (shown.length === 0) return nothing;
    const names = new Map(rows(evaluators).map((e) => [e.id, e.name.trim() || UNTITLED]));
    return html`<ol class="lines" aria-label="Results by line">
      ${shown.map((r) => {
        const verdicts = Object.entries(r.results);
        // One glyph on the line keeps a glyph's room on every answer, so they line up.
        const room = verdicts.some(([, v]) => v.questions.some((q) => q.glyph));
        return html`<li class="line ${r.status}" data-at=${r.at}>
          <p class="said">
            ${r.status === "asking" ? html`<i class="dot" role="img" aria-label="Asking Jev"></i>` : nothing}<span>${r.line}</span>
          </p>
          ${r.status === "failed" && !STOPS.includes(r.error) ? html`<p class="error" role="alert">${ERRORS[r.error]}</p>` : nothing}
          ${verdicts.map(([id, result]) => this.#verdict(names.get(id) ?? UNTITLED, result, verdicts.length > 1, room))}
        </li>`;
      })}
    </ol>`;
  }

  // One evaluator's answers for one line, under its name when more than one evaluated.
  #verdict(name, result, named, room) {
    return html`<div class="verdict">
      ${named ? html`<p class="by">${name}</p>` : nothing}
      <ul class="answers" aria-label="Answers from ${name}">
        ${result.questions.map((q) => this.#answer(q, room))}
      </ul>
    </div>`;
  }

  #answer(q, room) {
    const tone = q.tone ?? "";
    const said = q.tone === "right" ? "As expected" : q.tone === "wrong" ? "Not as expected" : nothing;
    return html`<li class="answer ${tone}">
      ${q.glyph
        ? html`<span class="glyph ${tone}" role="img" aria-label=${said}>${GLYPHS[q.glyph]?.()}</span>`
        : room
          ? html`<span class="glyph" aria-hidden="true"></span>`
          : nothing}
      ${q.question ? html`<span class="question">${q.question}</span>` : nothing}
      <span class="words">${q.words}</span>
    </li>`;
  }

  // from: the title of the book a row shown in the journal is kept with, or null.
  #row(e, open, focusId, from) {
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
            <span class="sub">${subtitle(e, from)}</span>
          </button>
      </li>
    `;
  }
}

customElements.define("evaluator-list", EvaluatorList);
