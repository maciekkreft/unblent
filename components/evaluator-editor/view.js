import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, duplicateNames } from "./machine.js";
import saved from "./events/evaluator.saved.json" with { type: "json" };
import started from "./events/removal.started.json" with { type: "json" };

// Which evaluator was open, and its book, kept per browser under the view's name (3.1);
// losing it loses nothing but the place.
const KEY = "evaluator-editor:open";
const recall = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
};
const remember = (pick) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(pick));
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
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, open: recall(), remember },
      events: { "evaluator.saved": saved, "removal.started": started },
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

class EvaluatorEditor extends LitElement {
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
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .field {
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
    .mute {
      color: var(--color-mute);
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
      min-height: calc(var(--text-body) * var(--leading-normal) * 2 + var(--space-xs) * 2);
      line-height: var(--leading-normal);
    }
    input::placeholder,
    textarea::placeholder {
      color: var(--color-mute);
    }
    input:focus-visible,
    textarea:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    input.title {
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
    }
    .questions {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    .question {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .qhead {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
    }
    /* The two kinds as one two-part switch: radio buttons, so arrow keys move between
       them and the chosen part looks pressed. */
    .kind {
      display: inline-flex;
      align-self: flex-start;
      gap: var(--space-2xs);
      padding: var(--space-2xs);
      margin: 0;
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
    }
    .kind label {
      position: relative;
      font-size: var(--text-sm);
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--color-body);
    }
    .kind input {
      position: absolute;
      inset: 0;
      margin: 0;
      opacity: 0;
      cursor: pointer;
    }
    .kind label:has(input:checked) {
      background: var(--color-canvas);
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      box-shadow: var(--shadow-card);
      outline: var(--border-width) solid var(--color-border-strong);
    }
    .kind label:has(input:focus-visible) {
      box-shadow: var(--focus-ring);
    }
    .options {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .option {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "name rm" "desc desc";
      gap: var(--space-xs);
      align-items: center;
      padding-bottom: var(--space-xs);
    }
    .option input {
      grid-area: name;
      font-weight: var(--weight-semibold);
    }
    .option textarea {
      grid-area: desc;
      font-size: var(--text-sm);
    }
    .option button {
      grid-area: rm;
    }
    .warn {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
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
      outline: none;
      box-shadow: var(--focus-ring);
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
    button.icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: var(--space-xs);
    }
  `;

  #actor = new ActorController(this);

  // A panel's focus lands in what it shows (list-then-item, dock-desk): the evaluator's
  // name. The shadow root does not delegate focus, because Safari does not focus a
  // pressed button, so a delegating root would hand a press on any button to the name,
  // scroll it into view and lose the click.
  focus(options) {
    const name = this.renderRoot.querySelector("input.title");
    if (name) name.focus(options);
    else super.focus(options);
  }

  #send(event) {
    this.#actor.send(event);
  }

  // Adding a question or an option puts the keyboard in its first field.
  async #add(event, selector) {
    this.#send(event);
    await this.updateComplete;
    const fields = this.renderRoot.querySelectorAll(selector);
    fields[fields.length - 1]?.focus();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("starting") || snapshot.matches("fetching")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="note">Evaluators unavailable.</p>`;
    if (snapshot.matches({ ready: "choosing" })) return html`<p class="note">Pick an evaluator, or New evaluator.</p>`;
    const { draft, evaluators } = snapshot.context;
    if (draft.removing) return html`<p class="note">This evaluator was deleted.</p>`;
    const stored = evaluators.some((r) => r.id === draft.id);
    const questions = draft.questions.filter((q) => !q.removing);
    return html`
      <div class="page">
        <form @submit=${(e) => e.preventDefault()} @focusout=${() => this.#send({ type: "_blur" })}>
          <label class="field">
            <span class="caption">Name</span>
            <input
              class="title"
              type="text"
              placeholder="Name the evaluator"
              .value=${draft.name}
              @input=${(e) => this.#send({ type: "_edit", patch: { name: e.target.value } })}
            />
          </label>
          <fieldset class="field">
            <legend>Questions</legend>
            <div class="questions">${questions.map((q, i) => this.#question(q, i))}</div>
          </fieldset>
          <div class="actions">
            <button type="button" @click=${() => this.#add({ type: "_addQuestion" }, ".question .text")}>Add a question</button>
          </div>
          ${stored
            ? html`<div class="actions">
                <button type="button" class="quiet" @click=${() => this.#send({ type: "_delete" })}>Delete evaluator</button>
              </div>`
            : nothing}
        </form>
      </div>
    `;
  }

  #question(q, i) {
    const n = i + 1;
    const edit = (patch) => this.#send({ type: "_editQuestion", id: q.id, patch });
    const kind = (k) => this.#send({ type: "_kind", id: q.id, kind: k });
    return html`
      <div class="question" data-id=${q.id}>
        <div class="qhead">
          <span class="caption">Question ${n}</span>
          <button type="button" class="quiet" aria-label="Remove question ${n}" @click=${() => this.#send({ type: "_removeQuestion", id: q.id })}>
            Remove
          </button>
        </div>
        <div class="kind" role="radiogroup" aria-label="Kind of answer for question ${n}">
          <label><input type="radio" name="kind-${q.id}" value="yesno" .checked=${q.kind === "yesno"} @change=${() => kind("yesno")} />Yes / no</label>
          <label><input type="radio" name="kind-${q.id}" value="pick" .checked=${q.kind === "pick"} @change=${() => kind("pick")} />Pick one</label>
        </div>
        <textarea
          class="text"
          aria-label="Question ${n}"
          placeholder="Write the question"
          .value=${q.text}
          @input=${(e) => edit({ text: e.target.value })}
        ></textarea>
        ${q.kind === "yesno" ? this.#yesno(q, edit) : this.#options(q)}
      </div>
    `;
  }

  #yesno(q, edit) {
    return html`
      <label class="field">
        <span class="caption">Yes means <span class="mute">(optional)</span></span>
        <textarea class="yes" .value=${q.yes} @input=${(e) => edit({ yes: e.target.value })}></textarea>
      </label>
      <label class="field">
        <span class="caption">No means <span class="mute">(optional)</span></span>
        <textarea class="no" .value=${q.no} @input=${(e) => edit({ no: e.target.value })}></textarea>
      </label>
    `;
  }

  #options(q) {
    const options = q.options.filter((o) => !o.removing);
    const edit = (o, patch) => this.#send({ type: "_editOption", question: q.id, id: o.id, patch });
    return html`
      <div class="field">
        <span class="caption">Options</span>
        <div class="options">
          ${options.map(
            (o) => html`
              <div class="option" data-id=${o.id}>
                <input
                  type="text"
                  aria-label="Option name"
                  placeholder="Option"
                  .value=${o.name}
                  @input=${(e) => edit(o, { name: e.target.value })}
                />
                <textarea
                  aria-label="What ${o.name.trim() || "this option"} means"
                  placeholder="What it means (optional)"
                  .value=${o.description}
                  @input=${(e) => edit(o, { description: e.target.value })}
                ></textarea>
                <button
                  type="button"
                  class="quiet icon"
                  title="Remove option"
                  aria-label="Remove option ${o.name.trim()}"
                  @click=${() => this.#send({ type: "_removeOption", question: q.id, id: o.id })}
                >
                  ${icon("x")}
                </button>
              </div>
            `,
          )}
        </div>
        ${duplicateNames(q) ? html`<p class="warn" role="status">Two options have the same name.</p>` : nothing}
      </div>
      <div>
        <button type="button" @click=${() => this.#add({ type: "_addOption", question: q.id }, `.question[data-id="${q.id}"] .option input`)}>
          Add an option
        </button>
      </div>
    `;
  }
}

customElements.define("evaluator-editor", EvaluatorEditor);
