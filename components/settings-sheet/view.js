import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine, merge } from "./machine.js";
import edited from "./events/settings.edited.json" with { type: "json" };
import llmEdited from "./events/llm.edited.json" with { type: "json" };
import toolsEdited from "./events/tools.edited.json" with { type: "json" };

// The account's thinking effort and cache lifetime shown in plain words (7.7). The
// effort choices come from `llm: read`; an unknown one falls back to its own name. The
// two cache lifetimes are the fixed product options; a longer one caches for longer and
// pays off over more questions on the same context.
const EFFORT_LABELS = {
  default: "Provider default",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};
const TTLS = ["5m", "1h"];
const TTL_LABELS = { "5m": "5 minutes", "1h": "1 hour" };
const TTL_NOTE = "1 hour costs more to start and pays off from the third question within the hour.";

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      // Reading `location` is a read of the document, allowed to a view; the
      // machine only ever receives the value, so it stays importable in Node.
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        current: location.pathname,
        // The `account` attribute (7.7): read from the host's light DOM, so the
        // machine learns it through input and stays importable in Node.
        account: this.host.hasAttribute("account"),
      },
      events: { "settings.edited": edited, "llm.edited": llmEdited, "tools.edited": toolsEdited },
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

class SettingsSheet extends LitElement {
  // `account` (7.7): reflected so the page's bare attribute reads as true and the
  // manifest is visible. `tidy` (section 9) is the one-column look, reflected the same
  // way. `keyDraft` holds what the user typed in the key box until they save it, and is
  // cleared after, so the key never lingers in the field. `replacingKey` is true while
  // the box is open over a key already saved.
  static properties = {
    account: { type: Boolean, reflect: true },
    tidy: { type: Boolean, reflect: true },
    keyDraft: { state: true },
    replacingKey: { state: true },
  };

  constructor() {
    super();
    this.keyDraft = "";
    this.replacingKey = false;
  }

  static styles = css`
    :host {
      display: block;
      padding: var(--space-md);
    }
    h2 {
      margin: 0 0 var(--space-sm);
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    /* A section heading over each group when the account section is shown (7.7). */
    h3 {
      margin: 0 0 var(--space-sm);
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .account {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .tools {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .tools .group {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    label.tool {
      display: flex;
      align-items: flex-start;
      gap: var(--space-xs);
      white-space: normal;
    }
    label.tool .labels {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    label.tool .title {
      color: var(--color-ink);
    }
    label.tool .desc {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .field {
      /* Override the base label rule, which centres its content (7.4). */
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-2xs);
    }
    .field > span {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .ttl-note {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .key {
      display: flex;
      gap: var(--space-2xs);
    }
    .key input {
      flex: 1;
      min-width: 0;
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-xs);
    }
    .key input:focus-visible {
      outline: var(--focus-ring);
    }
    button.act,
    button.reset {
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-md);
      cursor: pointer;
    }
    button.act:hover:not(:disabled),
    button.reset:hover {
      background: var(--color-surface-hover);
    }
    button.act:disabled {
      color: var(--color-border);
      cursor: default;
    }
    button.act:focus-visible,
    button.reset:focus-visible {
      outline: var(--focus-ring);
    }
    .hint {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    ul {
      list-style: none;
      margin: 0 0 var(--space-lg);
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .row {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
    }
    .row:hover {
      background: var(--color-surface-hover);
    }
    .labels {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .title {
      color: var(--color-ink);
    }
    code {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .move {
      display: flex;
      gap: var(--space-2xs);
    }
    button.icon {
      font: inherit;
      color: var(--color-body-mid);
      background: none;
      border: 0;
      padding: var(--space-2xs);
      border-radius: var(--radius-sm);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      font-size: var(--text-body);
    }
    button.icon:hover:not(:disabled) {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    button.icon:disabled {
      color: var(--color-border);
      cursor: default;
    }
    button.icon:focus-visible {
      outline: var(--focus-ring);
    }
    button.icon svg {
      display: block;
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2xs);
      color: var(--color-body);
      cursor: pointer;
      white-space: nowrap;
    }
    .shown {
      font-size: var(--text-sm);
    }
    .switches {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      margin-bottom: var(--space-lg);
    }
    label.select {
      justify-content: space-between;
      white-space: normal;
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
      outline: var(--focus-ring);
    }
    .failed {
      margin: 0;
      color: var(--color-body);
    }

    /* The one-column look (section 9): every setting is one row, its name beside its
       control, so the eye never crosses the stage to pair them (natural mapping). */
    :host([tidy]) {
      max-width: var(--width-form);
    }
    :host([tidy]) h3 {
      margin: 0 0 var(--space-md);
      font-size: var(--text-subtitle);
      line-height: var(--leading-tight);
    }
    :host([tidy]) h3.later {
      margin-top: var(--space-xl);
      padding-top: var(--space-lg);
      border-top: var(--border-width) solid var(--color-border);
    }
    :host([tidy]) .switches,
    :host([tidy]) .account {
      gap: var(--space-sm);
      margin-bottom: 0;
    }
    :host([tidy]) .field {
      display: grid;
      grid-template-columns: 2fr 3fr;
      align-items: center;
      column-gap: var(--space-md);
      row-gap: var(--space-2xs);
      white-space: normal;
    }
    :host([tidy]) .field > span:first-child {
      color: var(--color-body);
      font-size: var(--text-body);
    }
    :host([tidy]) .field > :not(:first-child) {
      justify-self: start;
    }
    :host([tidy]) .field > .help {
      grid-column: 2;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    :host([tidy]) input[type="checkbox"] {
      margin: 0;
      accent-color: var(--color-accent);
    }
    :host([tidy]) .key {
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-xs);
    }
    :host([tidy]) .key .saved {
      color: var(--color-body);
      margin-right: var(--space-xs);
    }
    :host([tidy]) .tools {
      gap: var(--space-sm);
      margin-top: var(--space-md);
    }
    /* The model's description rides the hover in the workshop only; the dotted line
       is the signifier that a hint is there. */
    :host([tidy]) .field > .hinted {
      text-decoration: underline dotted var(--color-mute);
      text-underline-offset: var(--space-xs);
      cursor: help;
    }
    :host([tidy]) button.reset {
      margin-top: var(--space-md);
    }
  `;

  #actor = new ActorController(this);

  // A component or role name read as a label: "note-editor" → "Note editor".
  #label(name) {
    const words = name.replace(/-/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // One swap select per role (3.6, 7.3): the members to choose from, the default
  // (the member whose tag equals the role) first, the current choice selected.
  #roleSelect(role, members, settings) {
    const chosen = settings.editors[role] ?? role;
    const options = [...members].sort((a, b) => (a === role ? -1 : b === role ? 1 : a.localeCompare(b)));
    return html`
      <label class="select">
        ${this.#label(role)}
        <select @change=${(e) => this.#actor.send({ type: "_setEditor", role, component: e.target.value })}>
          ${options.map(
            (name) => html`<option value=${name} ?selected=${name === chosen}>${this.#label(name)}</option>`,
          )}
        </select>
      </label>
    `;
  }

  // One on/off setting. The tidy look puts the name first, in the same row format as
  // every other setting; the old look keeps the box before its name.
  #check(name, checked, toggle) {
    const box = html`<input type="checkbox" .checked=${checked} @change=${toggle} />`;
    return this.tidy
      ? html`<label class="field"><span>${name}</span>${box}</label>`
      : html`<label>${box} ${name}</label>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || !(snapshot.matches("ready") || snapshot.matches("failed"))) return nothing;
    if (snapshot.matches("failed")) return html`<p class="failed">settings unavailable</p>`;
    const { pages, settings, current, roles, profile, account, llm, toolList, tools } = snapshot.context;
    const rows = merge(pages, settings.nav);
    // The product profile (§12) shows only the production options: the editor
    // selects and the layout-switch row. The page order and the viewport switch
    // are workshop-only, so the product sheet never offers them.
    const workshop = profile !== "product";
    const device = html`
      ${workshop
        ? html`
      <h2>Workshop page links</h2>
      <ul>
        ${rows.map(
          (row, i) => html`
            <li class="row">
              <span class="move">
                <button
                  class="icon"
                  ?disabled=${i === 0}
                  aria-label="Move ${row.title} up"
                  title="Move ${row.title} up"
                  @click=${() => this.#actor.send({ type: "_up", path: row.path })}
                >
                  ${icon("arrow-up")}
                </button>
                <button
                  class="icon"
                  ?disabled=${i === rows.length - 1}
                  aria-label="Move ${row.title} down"
                  title="Move ${row.title} down"
                  @click=${() => this.#actor.send({ type: "_down", path: row.path })}
                >
                  ${icon("arrow-down")}
                </button>
              </span>
              <span class="labels">
                <span class="title">${row.title}</span>
                <code>${row.path}</code>
              </span>
              ${row.path === current
                ? nothing
                : html`
                    <label class="shown">
                      <input
                        type="checkbox"
                        .checked=${!row.hidden}
                        @change=${(e) =>
                          this.#actor.send({ type: e.target.checked ? "_show" : "_hide", path: row.path })}
                      />
                      Shown
                    </label>
                  `}
            </li>
          `,
        )}
      </ul>
          `
        : nothing}
      <div class="switches">
        ${workshop
          ? this.#check("Viewport switch shown", !settings.viewportSwitchHidden, () =>
              this.#actor.send({ type: "_toggleViewport" }),
            )
          : nothing}
        ${this.#check("Vim keys", settings.vimKeys, () => this.#actor.send({ type: "_toggleVim" }))}
        ${this.#check("Layout switch shown", !settings.layoutSwitchHidden, () =>
          this.#actor.send({ type: "_toggleLayout" }),
        )}
        ${Object.entries(roles).map(([role, members]) => this.#roleSelect(role, members, settings))}
      </div>
      <button class="reset" @click=${() => this.#actor.send({ type: "_reset" })}>
        ${this.tidy && account ? "Reset this device" : "Reset to defaults"}
      </button>
    `;
    // Without the `account` attribute the sheet is the page-links sheet exactly as
    // before; with it, "This device" and "Your account" stand as two named sections
    // (7.7, §12).
    if (!account) return device;
    return html`
      <h3>This device</h3>
      ${device}
      <h3 class="later">Your account</h3>
      ${this.#account(llm, profile, toolList, tools)}
    `;
  }

  // The tool switches (7.7): one row per thing the chat may read from the reader's own
  // library, on unless switched off. Each names what is read in plain words with its
  // description; flipping one is reversible by flipping it back (Don Norman: forgiveness,
  // honest signifiers). Shown only signed in and only when the catalog named some tools.
  #tools(toolList, tools, profile) {
    if (!toolList.length) return nothing;
    // The tidy look prints only the label. The description is written for the model,
    // so the product never shows it; the workshop keeps it on hover to check what the
    // model is told.
    if (this.tidy) {
      const hint = profile !== "product";
      return html`
        <div class="tools">
          <span class="group">What the chat may read</span>
          ${toolList.map(
            (tool) => html`
              <label class="field">
                <span class=${hint ? "hinted" : ""} title=${hint ? tool.description : nothing}>${tool.label}</span>
                <input
                  type="checkbox"
                  .checked=${tools[tool.key] !== false}
                  @change=${(e) => this.#actor.send({ type: "_toggleTool", key: tool.key, on: e.target.checked })}
                />
              </label>
            `,
          )}
        </div>
      `;
    }
    return html`
      <div class="tools">
        <span class="group">What the chat may read</span>
        ${toolList.map(
          (tool) => html`
            <label class="tool">
              <input
                type="checkbox"
                .checked=${tools[tool.key] !== false}
                @change=${(e) => this.#actor.send({ type: "_toggleTool", key: tool.key, on: e.target.checked })}
              />
              <span class="labels">
                <span class="title">${tool.label}</span>
                <span class="desc">${tool.description}</span>
              </span>
            </label>
          `,
        )}
      </div>
    `;
  }

  // The account section (7.7): signed out it invites a sign-in; signed in it offers
  // the provider, the API key, the model, the thinking effort, the cache lifetime and
  // the tool switches. Every gesture emits llm.edited (or tools.edited) and is
  // reversible by choosing the previous value; removing the key can only be undone by
  // entering it again, so its button is plainly labelled (Don Norman: forgiveness,
  // honest signifiers).
  #account(llm, profile, toolList, tools) {
    if (!llm || !llm.signedIn) return html`<p class="hint">Sign in to set up the chat.</p>`;
    const current = llm.providers.find((p) => p.id === llm.provider);
    // Echo is a test provider (§12): offered only in the workshop, except that an
    // account left on it in the product keeps it, named "Echo (test)", so it can be
    // switched away from.
    const providers = llm.providers.filter((p) => p.id !== "echo" || profile !== "product" || llm.provider === "echo");
    const providerLabel = (p) => (p.id === "echo" && profile === "product" ? "Echo (test)" : p.label);
    return html`
      <div class="account">
        <label class="field">
          <span>Provider</span>
          <select @change=${(e) => this.#actor.send({ type: "_setProvider", provider: e.target.value })}>
            ${providers.map(
              (p) => html`<option value=${p.id} ?selected=${p.id === llm.provider}>${providerLabel(p)}</option>`,
            )}
          </select>
        </label>
        ${current?.needsKey && this.tidy
          ? this.#key(current)
          : current?.needsKey
          ? html`
              <div class="field">
                <span>API key</span>
                <div class="key">
                  <input
                    type="password"
                    placeholder=${current.keySet ? "Key set" : "No key yet"}
                    .value=${this.keyDraft}
                    @input=${(e) => (this.keyDraft = e.target.value)}
                  />
                  <button
                    class="act"
                    ?disabled=${this.keyDraft.length === 0}
                    @click=${() => {
                      this.#actor.send({ type: "_saveKey", key: this.keyDraft });
                      this.keyDraft = "";
                    }}
                  >
                    Save
                  </button>
                  ${current.keySet
                    ? html`<button class="act" @click=${() => this.#actor.send({ type: "_removeKey" })}>
                        Remove key
                      </button>`
                    : nothing}
                </div>
              </div>
            `
          : nothing}
        ${llm.models.length
          ? html`
              <label class="field">
                <span>Model</span>
                <select @change=${(e) => this.#actor.send({ type: "_setModel", model: e.target.value })}>
                  ${llm.models.map(
                    (m) => html`<option value=${m.id} ?selected=${m.id === llm.model}>${m.label}</option>`,
                  )}
                </select>
              </label>
            `
          : this.tidy
          ? html`<div class="field"><span>Model</span><span class="help">Add your API key to choose a model.</span></div>`
          : html`<p class="hint">Add your API key to choose a model.</p>`}
        <label class="field">
          <span>Thinking effort</span>
          <select @change=${(e) => this.#actor.send({ type: "_setEffort", effort: e.target.value })}>
            ${llm.efforts.map(
              (e) => html`<option value=${e} ?selected=${e === llm.effort}>${EFFORT_LABELS[e] ?? this.#label(e)}</option>`,
            )}
          </select>
        </label>
        <label class="field">
          <span>Cache lifetime</span>
          <select @change=${(e) => this.#actor.send({ type: "_setTtl", ttl: e.target.value })}>
            ${TTLS.map((t) => html`<option value=${t} ?selected=${t === llm.ttl}>${TTL_LABELS[t]}</option>`)}
          </select>
          ${this.tidy ? html`<span class="help">${TTL_NOTE}</span>` : nothing}
        </label>
        ${this.tidy ? nothing : html`<span class="ttl-note">${TTL_NOTE}</span>`}
        ${this.#tools(toolList, tools, profile)}
      </div>
    `;
  }

  // The API key in the tidy look. A saved key reads as a plain statement with Replace
  // and Remove, so nothing on screen looks disabled; the box appears only when a key is
  // wanted, and Cancel or Escape closes it again without a change (forgiveness).
  #key(provider) {
    const cancel = () => {
      this.keyDraft = "";
      this.replacingKey = false;
    };
    const save = () => {
      this.#actor.send({ type: "_saveKey", key: this.keyDraft });
      cancel();
    };
    const open = !provider.keySet || this.replacingKey;
    return html`
      <div class="field">
        <span>API key</span>
        <div class="key">
          ${open
            ? html`
                <input
                  type="password"
                  placeholder="Paste your API key"
                  .value=${this.keyDraft}
                  @input=${(e) => (this.keyDraft = e.target.value)}
                  @keydown=${(e) => {
                    if (e.key === "Enter" && this.keyDraft) save();
                    if (e.key === "Escape" && provider.keySet) cancel();
                  }}
                />
                <button class="act" ?disabled=${this.keyDraft.length === 0} @click=${save}>Save</button>
                ${provider.keySet ? html`<button class="act" @click=${cancel}>Cancel</button>` : nothing}
              `
            : html`
                <span class="saved">Key saved</span>
                <button
                  class="act"
                  @click=${async () => {
                    this.replacingKey = true;
                    await this.updateComplete;
                    this.renderRoot.querySelector(".key input")?.focus();
                  }}
                >
                  Replace
                </button>
                <button class="act" @click=${() => this.#actor.send({ type: "_removeKey" })}>Remove</button>
              `}
        </div>
      </div>
    `;
  }
}

customElements.define("settings-sheet", SettingsSheet);
