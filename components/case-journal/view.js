import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { machine, pieces, onTools, rows, blocked, errorText } from "./machine.js";
import saved from "./events/case.saved.json" with { type: "json" };
import selected from "./events/case.selected.json" with { type: "json" };
import requested from "./events/passages.requested.json" with { type: "json" };

// Sentences or Paragraphs is UI state worth keeping across a reload; it follows the
// browser, under a key beginning with the view's name (3.1).
const MODE_KEY = "case-journal.mode";

const storedMode = () => {
  try {
    return localStorage.getItem(MODE_KEY);
  } catch {
    return null;
  }
};

const keepMode = (mode) => {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Storage refused (a private window): the switch still works for this page.
  }
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, mode: storedMode() },
      events: { "case.saved": saved, "case.selected": selected, "passages.requested": requested },
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

const MODES = [
  { value: "sentences", label: "Sentences" },
  { value: "paragraphs", label: "Paragraphs" },
];

class CaseJournal extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // in the case's text.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .page {
      box-sizing: border-box;
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    .switch {
      align-self: flex-start;
      display: inline-flex;
      padding: var(--space-2xs);
      gap: var(--space-2xs);
      border-radius: var(--radius-sm);
      background: var(--color-surface-active);
    }
    .switch button {
      border-color: transparent;
      background: transparent;
      color: var(--color-body-mid);
    }
    .switch button:hover {
      color: var(--color-ink);
    }
    .switch button[aria-pressed="true"] {
      background: var(--color-canvas);
      color: var(--color-ink);
      box-shadow: var(--shadow-card);
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      min-width: 0;
    }
    .caption {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    textarea {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      resize: vertical;
      field-sizing: content;
      min-height: calc(var(--text-body) * var(--leading-normal) * 3 + var(--space-sm) * 2);
      padding: var(--space-sm);
      line-height: var(--leading-normal);
    }
    textarea::placeholder {
      color: var(--color-mute);
    }
    textarea:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
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
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button.dark {
      padding: var(--space-xs) var(--space-md);
      border-color: var(--color-ink);
      background: var(--color-ink);
      color: var(--color-canvas);
    }
    button.big {
      align-self: flex-start;
      font-size: var(--text-subtitle);
      padding: var(--space-sm) var(--space-lg);
      border-radius: var(--radius-md);
    }
    .line {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .error {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .pieces {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
      box-shadow: var(--shadow-card);
    }
    .piece {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding: var(--space-sm) var(--space-md);
      min-width: 0;
    }
    .piece + .piece {
      border-top: var(--border-width) solid var(--color-border);
    }
    .piece .text {
      margin: 0;
      color: var(--color-ink);
      line-height: var(--leading-normal);
      overflow-wrap: anywhere;
    }
    .piece.unfinished .text {
      color: var(--color-mute);
    }
    .tool {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2xs) var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .tool b {
      color: var(--color-body);
      font-weight: var(--weight-semibold);
    }
    .pick {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    .sure,
    .pct {
      font-variant-numeric: tabular-nums;
    }
    .yn .pct.yes {
      color: var(--color-success);
    }
    .yn .pct.no {
      color: var(--color-danger);
    }
    .note {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  #send(event) {
    this.#actor.send(event);
  }

  // New case puts the keyboard in the text of the case it opens, once it shows.
  #focusText = false;

  #new() {
    this.#focusText = true;
    this.#send({ type: "_new" });
  }

  #mode(mode) {
    keepMode(mode);
    this.#send({ type: "_mode", mode });
  }

  updated() {
    const text = this.renderRoot.querySelector("textarea.text");
    if (this.#focusText && text) {
      this.#focusText = false;
      text.focus();
    }
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty page">Cases unavailable.</p>`;
    const { context } = snapshot;
    const { draft, current, cases, rubrics, passages, mode, editing } = context;
    if (!draft) return this.#none(cases.some((c) => c.project === current && !c.removing));
    const why = blocked(context);
    const shown = rows(pieces(draft.text, mode, editing), onTools(rubrics, current), passages);
    return html`
      <div class="scroll">
        <div class="page">
          <div class="switch" role="group" aria-label="Judge by">
            ${MODES.map(
              (m) => html`<button type="button" class=${m.value} aria-pressed=${mode === m.value ? "true" : "false"} @click=${() => this.#mode(m.value)}>
                ${m.label}
              </button>`,
            )}
          </div>
          <label class="field">
            <span class="caption">Text</span>
            <textarea
              class="text"
              placeholder="Write the text to judge, a sentence at a time"
              .value=${draft.text}
              @input=${(e) => this.#send({ type: "_edit", text: e.target.value })}
              @blur=${() => this.#send({ type: "_blur" })}
            ></textarea>
          </label>
          ${why && why !== "Write the text to judge."
            ? html`<p class="line reason">${why}</p>`
            : passages.error
              ? html`<p class="error" role="status">${errorText(passages.error)}</p>`
              : nothing}
          ${shown.length ? html`<ol class="pieces">${shown.map((r) => this.#piece(r, why === null))}</ol>` : nothing}
        </div>
      </div>
    `;
  }

  #none(hasCases) {
    return html`
      <div class="scroll">
        <div class="page">
          <p class="empty">
            ${hasCases
              ? "Pick a case in Cases, or make a new one."
              : "No cases yet. A case is a piece of text you want judged, with the answer you expect."}
          </p>
          <button type="button" class="dark big new" @click=${() => this.#new()}>New case</button>
        </div>
      </div>
    `;
  }

  // A row with nothing to say under it when nothing can be judged: the reason line
  // above already says why.
  #piece(r, can) {
    if (!r.finished) return html`<li class="piece unfinished"><p class="text">${r.text}</p></li>`;
    let under = nothing;
    if (r.waiting) under = html`<span class="note" role="status">Judging…</span>`;
    else if (r.judged) under = r.tools.map((t) => this.#tool(t));
    else if (can) under = html`<span class="note">Not judged yet.</span>`;
    return html`<li class="piece"><p class="text">${r.text}</p>${under}</li>`;
  }

  #tool(t) {
    return html`
      <div class="tool" data-id=${t.id}>
        <b>${t.name}</b>
        ${t.entries.length
          ? t.entries.map((e) =>
              e.kind === "pick"
                ? html`<span><span class="pick">${e.pick}</span> <span class="sure">${e.sure}% sure</span></span>`
                : html`<span class="yn">${e.text} <span class="pct ${e.tone}">${e.pct}% yes</span></span>`,
            )
          : html`<span>Not judged</span>`}
      </div>
    `;
  }
}

customElements.define("case-journal", CaseJournal);
