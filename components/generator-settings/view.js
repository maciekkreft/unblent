import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { EditorState, Annotation } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { baseExtensions, setVim, paragraphs } from "editor";
import { machine, IDS, RUN, shown, modelsFor, keySet } from "./machine.js";
import edited from "./events/generator.edited.json" with { type: "json" };
import requested from "./events/generation.requested.json" with { type: "json" };

// "Ask the model" is a CodeMirror box, so it takes Vim's keys when the "Vim keys"
// preference (12) is on and writes in paragraphs like every editor; the setup, the Vim
// switch and the paragraph rule are the editor kit's (10).

// The box grows with what is written, from three lines; its frame is drawn around it by
// .box, so the theme draws none.
const boxTheme = EditorView.theme({
  ".cm-content": { padding: "var(--space-xs) var(--space-sm)", minHeight: "calc(var(--text-sm) * var(--leading-normal) * 3)" },
  ".cm-line": { fontSize: "var(--text-sm)" },
});

// A box's text set from the fact rather than typed, which is not sent back as an edit.
const fromFact = Annotation.define();

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "generator.edited": edited, "generation.requested": requested },
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

class GeneratorSettings extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
      color: var(--color-body);
    }
    .note {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .note.key {
      margin-bottom: var(--space-md);
    }
    .generator {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .generator + .generator {
      margin-top: var(--space-xl);
      padding-top: var(--space-lg);
      border-top: var(--border-width) solid var(--color-border);
    }
    .head {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      cursor: pointer;
    }
    .on {
      flex: none;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    input[type="checkbox"] {
      margin: 0;
      accent-color: var(--color-accent);
    }
    input[type="checkbox"]:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The name reads as the generator's title and is edited in place. */
    input.name {
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
    input.name:hover {
      border-color: var(--color-border);
    }
    input.name:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* A generator switched off is greyed, still editable: the tick brings it back. */
    .generator.off input.name,
    .generator.off .caption {
      color: var(--color-mute);
    }
    .field {
      display: grid;
      grid-template-columns: 2fr 3fr;
      column-gap: var(--space-md);
      cursor: default;
    }
    .field select {
      justify-self: start;
      max-width: 100%;
      min-width: 0;
    }
    select {
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-xs);
      cursor: pointer;
    }
    select:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .ask {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .caption {
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    /* CodeMirror owns everything inside .box; the frame is drawn here, around it. */
    .box {
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      overflow: hidden;
      cursor: text;
    }
    .box:focus-within {
      box-shadow: var(--focus-ring);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    .run {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
    }
    button {
      font: inherit;
      font-weight: var(--weight-semibold);
      color: var(--color-accent-text);
      background: var(--color-accent);
      border: var(--border-width) solid var(--color-accent);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-md);
      cursor: pointer;
    }
    button:hover {
      background: var(--color-accent-hover);
    }
    /* Pressed: Run looks held down while the line under it says what was asked for. */
    button:active,
    button.asked {
      background: var(--color-accent-active);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .asked-line {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .asked-line:empty {
      display: none;
    }
  `;

  #actor = new ActorController(this);
  // The prompt editors by generator id: { region, view }.
  #boxes = new Map();

  #send(event) {
    this.#actor.send(event);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { context } = snapshot;
    if (context.signedIn === null) return nothing;
    if (!context.signedIn) return html`<p class="note">Sign in to use generators.</p>`;
    if (context.failed) return html`<p class="note">Generators unavailable.</p>`;
    if (!context.generators) return nothing;
    return html`
      ${keySet(context.llm) === false
        ? html`<p class="note key">Generators run on your Anthropic key. Add it in the Settings tab, under Your account.</p>`
        : nothing}
      ${IDS.map((id) => shown(context, id))
        .filter(Boolean)
        .map((g) => this.#generator(g, context))}
    `;
  }

  #generator(g, context) {
    const run = RUN[g.id];
    const name = g.name.trim() || "Generator";
    return html`
      <section class="generator ${g.on ? "" : "off"}" data-id=${g.id} aria-label=${name} @focusout=${() => this.#send({ type: "_blur" })}>
        <div class="head">
          <label class="on">
            <input type="checkbox" .checked=${g.on} @change=${(e) => this.#send({ type: "_switch", id: g.id, on: e.target.checked })} />
            On
          </label>
          <input
            class="name"
            type="text"
            aria-label="Name"
            .value=${g.name}
            @input=${(e) => this.#send({ type: "_type", id: g.id, field: "name", value: e.target.value })}
          />
        </div>
        <label class="field">
          <span>Model</span>
          <select @change=${(e) => this.#send({ type: "_model", id: g.id, model: e.target.value })}>
            ${modelsFor(context.llm, g.model).map((m) => html`<option value=${m.id} ?selected=${m.id === g.model}>${m.label}</option>`)}
          </select>
        </label>
        <div class="ask">
          <span class="caption" @click=${() => this.#boxes.get(g.id)?.view.focus()}>Ask the model</span>
          <div class="box" data-key=${g.id}></div>
        </div>
        <div class="run">
          <span>${run.label}</span>
          <button type="button" class=${context.asked === g.id ? "asked" : ""} @click=${() => this.#send({ type: "_run", id: g.id })}>Run</button>
        </div>
        <p class="asked-line" role="status">${context.asked === g.id ? run.asked : ""}</p>
      </section>
    `;
  }

  // Each prompt box is made once its region is drawn, made again when the region is a
  // new element (after signing in), and follows the prompt shown and the Vim preference.
  updated() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return;
    const { context } = snapshot;
    const vimOn = context.vimKeys === true;
    const regions = new Map([...this.renderRoot.querySelectorAll(".box[data-key]")].map((r) => [r.dataset.key, r]));
    for (const [key, box] of this.#boxes) {
      if (regions.get(key) === box.region && box.view.dom.parentNode === box.region) continue;
      box.view.destroy();
      this.#boxes.delete(key);
    }
    for (const [key, region] of regions) {
      const g = shown(context, key);
      if (!g) continue;
      const box = this.#boxes.get(key);
      if (!box) {
        region.replaceChildren();
        const view = new EditorView({
          parent: region,
          // Shadow DOM: CodeMirror reads the selection through the root and mounts its
          // stylesheet there, so it must know the shadow root.
          root: this.renderRoot,
          state: EditorState.create({ doc: g.prompt, extensions: this.#extensions(key, g.name, vimOn) }),
        });
        this.#boxes.set(key, { region, view });
        continue;
      }
      setVim(box.view, vimOn);
      const doc = box.view.state.doc.toString();
      if (doc !== g.prompt) {
        box.view.dispatch({ changes: { from: 0, to: doc.length, insert: g.prompt }, annotations: fromFact.of(true) });
      }
    }
  }

  #extensions(key, name, vimOn) {
    return [
      baseExtensions({ vim: vimOn }),
      paragraphs(),
      boxTheme,
      EditorView.contentAttributes.of({ "aria-label": `Ask the model, ${name}` }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.every((t) => t.annotation(fromFact))) return;
        this.#send({ type: "_type", id: key, field: "prompt", value: update.state.doc.toString() });
      }),
    ];
  }

  disconnectedCallback() {
    for (const box of this.#boxes.values()) box.view.destroy();
    this.#boxes.clear();
    super.disconnectedCallback();
  }
}

customElements.define("generator-settings", GeneratorSettings);
