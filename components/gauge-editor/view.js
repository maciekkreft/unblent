import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { machine } from "./machine.js";
import saved from "./events/gauge.saved.json" with { type: "json" };
import discarded from "./events/gauge.discarded.json" with { type: "json" };

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo windows;
// the token is the one clock.
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

const RULES = [
  { id: "adds", name: "Each question adds", help: "The score is the average of the answers. One weak answer lowers it a little." },
  { id: "holds", name: "Every question must hold", help: "The score is the geometric mean. One answer near zero sinks it." },
];

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, undoMs },
      events: { "gauge.saved": saved, "gauge.discarded": discarded },
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

class GaugeEditor extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    .page {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    form {
      box-sizing: border-box;
      max-width: var(--width-form);
      padding: var(--space-md);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    .note {
      margin: 0;
      padding: var(--space-md);
      color: var(--color-body-mid);
    }
    label.field,
    fieldset {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      margin: 0;
      padding: 0;
      border: 0;
      min-width: 0;
    }
    .caption,
    legend {
      padding: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    input[type="text"],
    textarea {
      box-sizing: border-box;
      width: 100%;
      font: inherit;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-xs) var(--space-sm);
    }
    textarea {
      resize: vertical;
      field-sizing: content;
      min-height: calc(var(--text-body) * var(--leading-normal) + var(--space-sm) * 2);
      line-height: var(--leading-normal);
    }
    input:focus-visible,
    textarea:focus-visible {
      outline: var(--focus-ring);
    }
    input.title {
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    .rule {
      display: grid;
      grid-template-columns: auto 1fr;
      column-gap: var(--space-sm);
      align-items: baseline;
      cursor: pointer;
      padding: var(--space-xs) 0;
    }
    .rule input {
      margin: 0;
      accent-color: var(--color-accent);
    }
    .rule .name {
      color: var(--color-ink);
    }
    .rule .help {
      grid-column: 2;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .questions {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .question {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .question.removing {
      opacity: 0.5;
    }
    .question .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
    }
    .help {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
      justify-content: space-between;
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
      outline: var(--focus-ring);
    }
    button.quiet {
      border-color: transparent;
      background: transparent;
      color: var(--color-body);
    }
    button.quiet:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    button.undo {
      border-color: transparent;
      background: transparent;
      color: var(--color-accent);
    }
  `;

  #actor = new ActorController(this);

  #send(event) {
    this.#actor.send(event);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("idle")) return html`<p class="note">Pick a tool, or New tool.</p>`;
    if (snapshot.matches("deleted")) return html`<p class="note">This tool was deleted.</p>`;
    const { draft, removing, deleting } = snapshot.context;
    const edit = (patch) => this.#send({ type: "_edit", patch });
    return html`
      <div class="page">
        <form @submit=${(e) => e.preventDefault()} @focusout=${() => this.#send({ type: "_blur" })}>
          <label class="field">
            <span class="caption">Name</span>
            <input class="title" type="text" .value=${draft.name} @input=${(e) => edit({ name: e.target.value })} />
          </label>
          <label class="field">
            <span class="caption">The question this tool answers</span>
            <textarea .value=${draft.question} @input=${(e) => edit({ question: e.target.value })}></textarea>
          </label>
          <label class="field">
            <span class="caption">Yes when</span>
            <textarea .value=${draft.yes} @input=${(e) => edit({ yes: e.target.value })}></textarea>
          </label>
          <label class="field">
            <span class="caption">No when</span>
            <textarea .value=${draft.no} @input=${(e) => edit({ no: e.target.value })}></textarea>
          </label>
          <fieldset>
            <legend>Rule</legend>
            ${RULES.map(
              (r) => html`
                <label class="rule">
                  <input
                    type="radio"
                    name="rule"
                    .checked=${draft.rule === r.id}
                    @change=${() => {
                      edit({ rule: r.id });
                      this.#send({ type: "_blur" });
                    }}
                  />
                  <span class="name">${r.name}</span>
                  <span class="help">${r.help}</span>
                </label>
              `,
            )}
          </fieldset>
          <fieldset>
            <legend>Questions</legend>
            <div class="questions">${draft.questions.map((q, i) => this.#question(q, i, removing.has(q.id)))}</div>
          </fieldset>
          <div class="actions">
            <button type="button" @click=${() => this.#send({ type: "_addQuestion" })}>Add a question</button>
          </div>
          <p class="help">
            Score on the stage runs every tool on the post. The question above is asked directly and shown beside
            the score; it is not part of the score.
          </p>
          <div class="actions">
            ${deleting
              ? html`<button type="button" class="undo" @click=${() => this.#send({ type: "_undoDelete" })}>Deleted · Undo</button>`
              : html`<button type="button" class="quiet" @click=${() => this.#send({ type: "_delete" })}>Delete tool</button>`}
          </div>
        </form>
      </div>
    `;
  }

  #question(q, i, removing) {
    const edit = (patch) => this.#send({ type: "_editQuestion", id: q.id, patch });
    return html`
      <div class="question ${removing ? "removing" : ""}" data-id=${q.id}>
        <div class="head">
          <span class="caption">Question ${i + 1}</span>
          ${removing
            ? html`<button type="button" class="undo" @click=${() => this.#send({ type: "_undoRemove", id: q.id })}>Removed · Undo</button>`
            : html`<button type="button" class="quiet" @click=${() => this.#send({ type: "_removeQuestion", id: q.id })}>Remove</button>`}
        </div>
        <textarea aria-label="Question ${i + 1}" .value=${q.text} @input=${(e) => edit({ text: e.target.value })}></textarea>
        <label class="field">
          <span class="caption">Short name</span>
          <input type="text" .value=${q.label ?? ""} @input=${(e) => edit({ label: e.target.value })} />
        </label>
        <label class="field">
          <span class="caption">Yes when</span>
          <textarea .value=${q.yes} @input=${(e) => edit({ yes: e.target.value })}></textarea>
        </label>
        <label class="field">
          <span class="caption">No when</span>
          <textarea .value=${q.no} @input=${(e) => edit({ no: e.target.value })}></textarea>
        </label>
      </div>
    `;
  }
}

customElements.define("gauge-editor", GaugeEditor);
