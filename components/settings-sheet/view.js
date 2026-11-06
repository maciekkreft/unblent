import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask, answers } from "bus";
import { icon } from "icons";
import { machine, merge, BOXES, answersOf, boxView, checksShown, valueChecksShown, toolsShown, toolGroups, valueCheckers, ollamaView, deciderView, voiceView } from "./machine.js";
import edited from "./events/settings.edited.json" with { type: "json" };
import llmEdited from "./events/llm.edited.json" with { type: "json" };
import toolsEdited from "./events/tools.edited.json" with { type: "json" };
import checksEdited from "./events/checks.edited.json" with { type: "json" };
import valueChecksEdited from "./events/value-checks.edited.json" with { type: "json" };
import updatesEdited from "./events/updates.edited.json" with { type: "json" };
import voiceEdited from "./events/voice.edited.json" with { type: "json" };

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
  on: "On",
  off: "Off",
};
// Ollama runs on the user's own Mac (3.4), so its name says where the answers come from.
const PROVIDER_LABELS = { ollama: "Ollama (on this Mac)" };
const PULL = "ollama pull gemma4:e4b-mlx";
// Who answers the checks in the Mac app (3.4): each name says where the answers come from
// and what they cost.
const DECIDER_LABELS = { ollama: "Ollama (on this Mac)", jev: "Jev (your own key)" };
const PULL_KEV = "ollama pull kev:0.8b-mlx-bf16";
// How long Copy reads Copied, so the click visibly did something (Don Norman: feedback).
const COPIED_MS = 2000;
const FEEDBACK_URL = "https://github.com/maciekkreft/unblent/issues/new/choose";
const TTLS = ["5m", "1h"];
const TTL_LABELS = { "5m": "5 minutes", "1h": "1 hour" };
// The download's size in whole megabytes, as the design names it ("354 MB").
const mb = (bytes) => Math.round(bytes / 1e6);

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
        answered: answers,
        current: location.pathname,
        // The `account` attribute (7.7): read from the host's light DOM, so the
        // machine learns it through input and stays importable in Node.
        account: this.host.hasAttribute("account"),
      },
      events: { "settings.edited": edited, "llm.edited": llmEdited, "tools.edited": toolsEdited, "checks.edited": checksEdited, "value-checks.edited": valueChecksEdited, "updates.edited": updatesEdited, "voice.edited": voiceEdited },
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
  // manifest is visible. `keyDraft` holds what the user typed in the key box until
  // they save it, and is cleared after, so the key never lingers in the field. `replacingKey` is true while
  // the box is open over a key already saved.
  // `jevDraft` and `replacingJev` are the same two states for the Jev key.
  static properties = {
    account: { type: Boolean, reflect: true },
    keyDraft: { state: true },
    replacingKey: { state: true },
    jevDraft: { state: true },
    replacingJev: { state: true },
    // Ollama's address box: open while the user changes it, and the command Copy just
    // copied, so only that line reads Copied.
    editingAddress: { state: true },
    copied: { state: true },
    // The Inworld key's draft and whether its box is open over a saved key, as for the
    // other keys; and whether Play a sample is playing, from the press until it ends.
    inworldDraft: { state: true },
    replacingInworld: { state: true },
    playing: { state: true },
  };

  constructor() {
    super();
    this.keyDraft = "";
    this.replacingKey = false;
    this.jevDraft = "";
    this.replacingJev = false;
    this.editingAddress = false;
    this.copied = null;
    this.inworldDraft = "";
    this.replacingInworld = false;
    this.playing = false;
  }

  static styles = css`
    /* One column, every setting one row with its name beside its control, so the eye
       never crosses the stage to pair them (natural mapping). */
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
    }
    h2 {
      margin: 0 0 var(--space-sm);
      font-size: var(--text-body);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    /* A section heading over each group when the account section is shown (7.7). */
    h3 {
      margin: 0 0 var(--space-md);
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    h3.later {
      margin-top: var(--space-xl);
      padding-top: var(--space-lg);
      border-top: var(--border-width) solid var(--color-border);
    }
    .switches,
    .account {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .tools {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      margin-top: var(--space-md);
    }
    /* The tool switches stand in a fold; opened, they keep the gap of the fields above. */
    .tools details[open] {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    /* The tool groups: a gap between groups, and each group's heading set off by a line
       under it, with its own switch in the switch column. */
    .tool-groups {
      display: flex;
      flex-direction: column;
      gap: var(--space-lg);
    }
    .tool-group {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
    }
    .tool-head {
      padding-bottom: var(--space-xs);
      border-bottom: var(--border-width) solid var(--color-border);
    }
    .tool-head > span {
      color: var(--color-body-mid);
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      text-transform: uppercase;
    }
    /* The two headings of Your account: Generating, for the chat, and Evaluating. */
    .group {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    /* Reading aloud starts a group of its own, set off from the rows above it. */
    .switches > .group,
    .group.reading {
      margin-top: var(--space-md);
    }
    .judging {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      margin-top: var(--space-md);
    }
    .field {
      display: grid;
      grid-template-columns: 2fr 3fr;
      align-items: center;
      column-gap: var(--space-md);
      row-gap: var(--space-2xs);
      white-space: normal;
    }
    .field > :not(:first-child) {
      justify-self: start;
    }
    /* A checkbox row: the name takes the row and the box stands at its right end, so
       every box in the sheet lines up in one column under the others. */
    .field.check {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .field.check > input {
      justify-self: end;
    }
    /* Who decides has long names: the select shrinks to its column instead of pushing
       the sheet wider than a phone. */
    .field.decider {
      grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    }
    .field.decider > select {
      max-width: 100%;
    }
    .field > .help {
      grid-column: 2;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    /* The model's description rides the hover in the workshop only; the dotted line
       is the signifier that a hint is there. */
    .field > .hinted {
      text-decoration: underline dotted var(--color-mute);
      text-underline-offset: var(--space-xs);
      cursor: help;
    }
    input[type="checkbox"] {
      margin: 0;
      accent-color: var(--color-accent);
    }
    /* Ollama's status and the pull hint wrap under their buttons at phone width. */
    .ollama {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-xs);
    }
    .ollama .status {
      color: var(--color-body);
    }
    .ollama .status.off {
      color: var(--color-body-mid);
    }
    .ollama .dot {
      display: inline-block;
      width: var(--space-sm);
      height: var(--space-sm);
      margin-right: var(--space-xs);
      vertical-align: middle;
      border-radius: var(--radius-full);
      background: var(--color-success);
    }
    /* Reading aloud: the download's bar, sized like a key box, filled in the accent. */
    .bar {
      display: inline-block;
      width: calc(var(--space-2xl) * 3.375);
      max-width: 100%;
      height: var(--space-xs);
      border-radius: var(--space-2xs);
      background: var(--color-surface-active);
      overflow: hidden;
    }
    .bar > i {
      display: block;
      height: 100%;
      background: var(--color-accent);
    }
    .ollama .of {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .ollama button.act {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
    }
    /* Download voice is the one thing to do on the row, so it stands out from Cancel. */
    button.act.out {
      background: var(--color-canvas);
      border-color: var(--color-border-strong);
    }
    .ollama code {
      font-family: var(--font-mono);
    }
    /* Drawn as the feedback link is, so a link reads the same throughout the sheet. */
    .ollama a {
      color: var(--color-ink);
      text-decoration: underline;
      text-underline-offset: var(--space-2xs);
    }
    .ollama input {
      flex: 1;
      min-width: 0;
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-xs);
    }
    .ollama input:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .key {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-xs);
    }
    .key .saved {
      color: var(--color-body);
      margin-right: var(--space-xs);
    }
    /* A plain text box drawn as dots: a password box would make the browser offer
       to save the key as a password (macOS Passwords). */
    .key input {
      -webkit-text-security: disc;
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
      outline: none;
      box-shadow: var(--focus-ring);
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
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button.reset {
      margin-top: var(--space-md);
    }
    .hint {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    /* The last line of the sheet, set apart like a section, so it reads as a way out
       of the settings rather than one of them. */
    .feedback {
      margin: var(--space-xl) 0 0;
      padding-top: var(--space-lg);
      border-top: var(--border-width) solid var(--color-border);
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .feedback a {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2xs);
      color: var(--color-ink);
      text-decoration: underline;
      text-underline-offset: var(--space-2xs);
      border-radius: var(--radius-sm);
    }
    .feedback a:hover {
      color: var(--color-accent-hover);
    }
    .feedback a:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .keys-fold summary {
      width: fit-content;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
      cursor: pointer;
      /* A click opens the list; it must not select the words as a side effect. */
      user-select: none;
      -webkit-user-select: none;
    }
    .keys-title {
      margin: var(--space-xs) 0 0;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
    }
    .keys {
      display: grid;
      /* One key column width for every group, so the sheet reads as one table. */
      grid-template-columns: calc(var(--space-2xl) * 2.25) 1fr;
      gap: var(--space-2xs) var(--space-md);
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .keys dt {
      font-weight: var(--weight-semibold);
    }
    .keys dd {
      margin: 0;
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
      outline: none;
      box-shadow: var(--focus-ring);
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
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .failed {
      margin: 0;
      color: var(--color-body);
    }
    /* The choice point checks: one block per box, its evaluator beside its name, and
       under it one tinted card per question, so the eye reads a question with its own
       choices and never pairs a choice with the wrong question. */
    .checks {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      margin-top: var(--space-md);
    }
    /* Under the Jev key the fold stands in the group's own gap. */
    .judging .checks {
      margin-top: 0;
    }
    .boxes {
      display: flex;
      flex-direction: column;
      margin-top: var(--space-xs);
    }
    .box {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm) 0;
      border-top: var(--border-width) solid var(--color-border);
    }
    .box:first-child {
      border-top: 0;
    }
    .box select,
    .question select {
      max-width: 100%;
      min-width: 0;
    }
    .question {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-sm);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
    }
    .question > label {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-md);
      white-space: normal;
      color: var(--color-ink);
    }
    .choices {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: var(--space-2xs) var(--space-sm);
      font-size: var(--text-sm);
    }
    .choices > span {
      color: var(--color-body-mid);
    }
    .choices select {
      font-size: var(--text-sm);
      justify-self: start;
    }
    .question.off > span {
      color: var(--color-mute);
    }
    .question.off .note {
      color: var(--color-body-mid);
      font-size: var(--text-sm);
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
            (name) => html`<option value=${name} .selected=${name === chosen}>${this.#label(name)}</option>`,
          )}
        </select>
      </label>
    `;
  }

  // The key sheet (plan Revision 1, item 3): every key "Vim keys" turns on, in plain
  // words, written once here where the switch is, including where a key does not work.
  // It sits in a fold that starts closed, so the long list never crowds the switches,
  // and it is there with the switch off too, to read the keys before turning them on.
  #vimSheet(chat) {
    const group = (title, rows) => html`
      <p class="keys-title">${title}</p>
      <dl class="keys">${rows.map(([keys, what]) => html`<dt>${keys}</dt><dd>${what}</dd>`)}</dl>
    `;
    return html`
      ${group(`Anywhere on the desk, also while typing in a note${chat ? " or the chat box" : ""}`, [
        ["Ctrl+h, Ctrl+l", "go to the panel on the left or the right"],
        ["Ctrl+j, Ctrl+k", "go to the bottom panel, or back up to the middle"],
        ["Ctrl+. and Ctrl+,", "show the next or the previous tab of the panel you are in"],
        ["Ctrl+Shift+h, l, j", "fold or unfold the left, right or bottom panel"],
      ])}
      ${group(`In a list (books, contents, notes${chat ? ", chats" : ""})`, [
        ["j, k", "next or previous row"],
        ["gg, G", "first or last row"],
        ["Enter", "open the row"],
        ["Escape", `from a note${chat ? " or a chat" : ""}, back to its list (while typing, the first Escape only stops the typing)`],
        ...(chat ? [["In the chat box", "Enter sends; while typing, press Escape first (Enter there makes a new line)"]] : []),
      ])}
      ${group("In the Reader, a cursor shows on the text", [
        ["w, b", "next or previous word"],
        [") and (", "next or previous sentence"],
        ["} and {", "end or start of the paragraph"],
        ["l, h", "next or previous letter"],
        ["j, k", "line below or above"],
        ["0, $", "start or end of the line"],
        ["Click", "put the cursor on the letter clicked"],
        ["v, Ctrl+v", "start a highlight at the cursor; move to make it longer"],
        ["Enter, Escape", "make the highlight, or drop it"],
        ["Space, Ctrl+f, Ctrl+d", "next page (also the right arrow and Page Down)"],
        ["Ctrl+b, Ctrl+u", "previous page (also the left arrow and Page Up)"],
        ["gg, G", "first or last page of the chapter"],
      ])}
      <p class="hint">On a phone-sized window the panel, tab and fold keys are off; the list and Reader keys still work.</p>
    `;
  }

  // One on/off setting, in the same row format as every other setting.
  #check(name, checked, toggle) {
    return html`<label class="field check"
      ><span>${name}</span><input type="checkbox" .checked=${checked} @change=${toggle}
    /></label>`;
  }

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on its first
  // control.
  focus(options) {
    const target = this.renderRoot?.querySelector("input, select, button, textarea");
    if (target) target.focus(options);
    else super.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || !(snapshot.matches("ready") || snapshot.matches("failed"))) return nothing;
    if (snapshot.matches("failed")) return html`<p class="failed">settings unavailable</p>`;
    const { pages, settings, current, roles, profile, account, llm, toolList, tools, checks, evaluators } = snapshot.context;
    const reading = voiceView(snapshot.context);
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
        ${settings.vimKeys
          ? html`<details class="keys-fold">
              <summary>Show the keys</summary>
              ${this.#vimSheet(snapshot.context.chat)}
            </details>`
          : nothing}
        ${this.#check("Keep the open note and chat", settings.keepOpen, () =>
          this.#actor.send({ type: "_toggleKeep" }),
        )}
        ${this.#check("Layout switch shown", !settings.layoutSwitchHidden, () =>
          this.#actor.send({ type: "_toggleLayout" }),
        )}
        ${snapshot.context.updates === null
          ? nothing
          : this.#check("Beta releases", snapshot.context.updates, (e) => {
              // The box shows only what `updates` saved: updates.changed sets it, and
              // a switch that could not be saved leaves it as it was.
              e.target.checked = snapshot.context.updates;
              this.#actor.send({ type: "_toggleTest" });
            })}
        ${Object.entries(roles).map(([role, members]) => this.#roleSelect(role, members, settings))}
        ${reading?.here === "mac" ? this.#readingMac(reading) : nothing}
      </div>
      <button class="reset" @click=${() => this.#actor.send({ type: "_reset" })}>
        ${account ? "Reset this device" : "Reset to defaults"}
      </button>
    `;
    // Without the `account` attribute the sheet is the page-links sheet exactly as
    // before; with it, "This device" and "Your account" stand as two named sections
    // (7.7, §12).
    if (!account) return html`${device}${this.#feedback()}`;
    return html`
      <h3>This device</h3>
      ${device}
      <h3 class="later">Your account</h3>
      ${this.#account(llm, profile, toolList, tools, checks, evaluators)}
      ${this.#feedback()}
    `;
  }

  // The project's issue chooser, opened in a new tab or, in the Mac app, in the user's
  // browser (architecture.md 10), so the sheet stays where it was. The icon says the
  // link leaves the app (Don Norman: visible signifiers).
  #feedback() {
    return html`
      <p class="feedback">
        Something not working, or an idea?
        <a href=${FEEDBACK_URL} target="_blank" rel="noopener">Send feedback ${icon("arrow-square-out")}</a>
      </p>
    `;
  }

  // The tool switches (7.7): one row per thing the chat may read from the reader's own
  // library, on unless switched off, in groups, each under a heading whose switch turns
  // the whole group on or off and is on while any of it is on. Each names what is read in
  // plain words; flipping one is reversible by flipping it back (Don Norman: forgiveness,
  // honest signifiers). Shown only signed in and only when the catalog named some tools.
  #tools(toolList, tools, profile, vimKeys) {
    if (!toolList.length) return nothing;
    // Only the name is printed. The description is written for the model, so the
    // product never shows it; the workshop keeps it on hover to check what the model is
    // told.
    const hint = profile !== "product";
    // The list's keyboard path (12): the arrows, and j and k with Vim keys, step from
    // switch to switch, group headings included, and stop at both ends.
    const move = (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1, ...(vimKeys ? { j: 1, k: -1 } : {}) }[e.key];
      if (!step || e.ctrlKey || e.metaKey || e.altKey) return;
      const boxes = [...e.currentTarget.querySelectorAll("input[type=checkbox]")];
      const i = boxes.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      boxes[Math.max(0, Math.min(boxes.length - 1, i + step))].focus();
    };
    return html`
      <div class="tools">
        <details class="keys-fold">
          <summary>What the chat may read</summary>
          <div class="tool-groups" @keydown=${move}>
            ${toolGroups(toolList, tools).map(
              (group) => html`
                <div class="tool-group">
                  <label class="field check tool-head">
                    <span>${group.name}</span>
                    <input
                      type="checkbox"
                      aria-label=${group.name}
                      .checked=${group.on}
                      @change=${(e) =>
                        this.#actor.send({ type: "_toggleGroup", keys: group.tools.map((t) => t.key), on: e.target.checked })}
                    />
                  </label>
                  ${group.tools.map(
                    (tool) => html`
                      <label class="field check">
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
              `,
            )}
          </div>
        </details>
      </div>
    `;
  }

  // The account section (7.7): signed out it invites a sign-in; signed in it offers
  // the provider, the API key, the model, the thinking effort, the cache lifetime and
  // the tool switches. Every gesture emits llm.edited (or tools.edited) and is
  // reversible by choosing the previous value, and a key change by Undo (12, Undo).
  #account(llm, profile, toolList, tools, checks, evaluators) {
    if (!llm || !llm.signedIn) return html`<p class="hint">Sign in to set up the chat.</p>`;
    const current = llm.providers.find((p) => p.id === llm.provider);
    // Echo is a test provider (§12): offered only in the workshop, except that an
    // account left on it in the product keeps it, named "Echo (test)", so it can be
    // switched away from.
    const providers = llm.providers.filter((p) => p.id !== "echo" || profile !== "product" || llm.provider === "echo");
    const providerLabel = (p) => (p.id === "echo" && profile === "product" ? "Echo (test)" : PROVIDER_LABELS[p.id] ?? p.label);
    const ollama = llm.provider === "ollama" ? ollamaView(llm) : null;
    return html`
      <div class="account">
        <span class="group">Generating</span>
        <label class="field">
          <span>Provider</span>
          <select @change=${(e) => this.#actor.send({ type: "_setProvider", provider: e.target.value })}>
            ${providers.map(
              (p) => html`<option value=${p.id} .selected=${p.id === llm.provider}>${providerLabel(p)}</option>`,
            )}
          </select>
        </label>
        ${ollama ? this.#ollama(ollama) : nothing}
        ${current?.needsKey
          ? this.#keyField({
              field: "key",
              keySet: current.keySet,
              label: "API key",
              draftName: "keyDraft",
              replacingName: "replacingKey",
              save: (key) => this.#actor.send({ type: "_saveKey", key }),
              remove: () => this.#actor.send({ type: "_removeKey" }),
            })
          : nothing}
        ${ollama && !ollama.running
          ? nothing
          : llm.models.length
          ? html`
              <label class="field">
                <span>Model</span>
                <select @change=${(e) => this.#actor.send({ type: "_setModel", model: e.target.value })}>
                  ${llm.models.map(
                    (m) => html`<option value=${m.id} .selected=${m.id === llm.model}>${m.label}</option>`,
                  )}
                </select>
              </label>
            `
          : ollama
          ? nothing
          : html`<div class="field"><span>Model</span><span class="help">Add your API key to choose a model.</span></div>`}
        ${ollama?.defaultMissing
          ? this.#pullHint(PULL, html`gemma4:e4b-mlx isn't downloaded. In Terminal: <code>${PULL}</code>`)
          : nothing}
        <label class="field">
          <span>${ollama ? "Thinking" : "Thinking effort"}</span>
          <select @change=${(e) => this.#actor.send({ type: "_setEffort", effort: e.target.value })}>
            ${llm.efforts.map(
              (e) => html`<option value=${e} .selected=${e === llm.effort}>${EFFORT_LABELS[e] ?? this.#label(e)}</option>`,
            )}
          </select>
        </label>
        ${ollama
          ? nothing
          : html`
              <label class="field">
                <span>Cache lifetime</span>
                <select @change=${(e) => this.#actor.send({ type: "_setTtl", ttl: e.target.value })}>
                  ${TTLS.map((t) => html`<option value=${t} .selected=${t === llm.ttl}>${TTL_LABELS[t]}</option>`)}
                </select>
              </label>
            `}
        ${this.#tools(toolsShown(toolList, this.#actor.snapshot.context.hidden), tools, profile, this.#actor.snapshot.context.settings.vimKeys)}
        ${this.#readingWeb(voiceView(this.#actor.snapshot.context))}
        ${llm.jev ? this.#judging(llm, evaluators, checks) : this.#checks(checks, evaluators)}
      </div>
    `;
  }

  // Ollama's row (3.4): whether it answered at its address, with the address changeable
  // in place. Enter or leaving the box saves, Escape closes it unchanged, and an empty
  // address brings back the default, so every change is undone by typing the old one.
  // The chat and the checks each draw this row (`row`), and only the row the user
  // pressed opens its box; both read and change the one address.
  #ollama({ address, running }, row = "chat") {
    const editing = this.editingAddress === row;
    const save = (value) => {
      this.editingAddress = false;
      if (value.trim() !== address) this.#actor.send({ type: "_setAddress", address: value });
    };
    const edit = async () => {
      this.editingAddress = row;
      await this.updateComplete;
      this.renderRoot.querySelector(`.ollama[data-row="${row}"] input`)?.focus();
    };
    return html`
      <div class="field">
        <span>Ollama</span>
        <div class="ollama" data-row=${row}>
          ${editing
            ? html`
                <input
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  aria-label="Ollama address"
                  placeholder="localhost:11434"
                  .value=${address}
                  @keydown=${(e) => {
                    if (e.key === "Enter") save(e.target.value);
                    if (e.key === "Escape") this.editingAddress = false;
                  }}
                  @blur=${(e) => this.editingAddress === row && save(e.target.value)}
                />
              `
            : running
            ? html`<span class="status running"><span class="dot" aria-hidden="true"></span>Running at ${address}</span>`
            : html`
                <span class="status off">
                  Ollama isn't running. Open the Ollama app, or get it at
                  <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>.
                </span>
                <button class="act" @click=${() => this.#actor.send({ type: "_retryOllama" })}>Try again</button>
              `}
          ${editing ? nothing : html`<button class="act" @click=${edit}>Change address</button>`}
        </div>
      </div>
    `;
  }

  // A model is missing in Ollama: the one Terminal line that downloads it, with Copy,
  // and Try again to read the models once it is downloaded.
  #pullHint(command, text, help = nothing) {
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(command);
        this.copied = command;
        setTimeout(() => this.copied === command && (this.copied = null), COPIED_MS);
      } catch {
        // No clipboard (an insecure page): the command stays on screen to copy by hand.
      }
    };
    return html`
      <div class="field">
        <span></span>
        <div class="ollama pull">
          <span class="status">${text}</span>
          <button class="act" @click=${copy}>${this.copied === command ? "Copied" : "Copy"}</button>
          <button class="act" @click=${() => this.#actor.send({ type: "_retryOllama" })}>Try again</button>
        </div>
        ${help}
      </div>
    `;
  }

  // Evaluating: only where the picture carries `jev`. In the Mac app it starts with who
  // answers the checks (deciderView); the Jev key shows only while Jev is chosen, since
  // Kev needs none. Under the key, what uses evaluators: the values, then the
  // choice point boxes, each in a fold of its own.
  #judging(llm, evaluators, checks) {
    const decider = deciderView(llm);
    return html`
        <div class="judging">
          <span class="group">Evaluating</span>
          ${decider ? this.#decider(decider, llm) : nothing}
          ${decider && decider.provider !== "jev" ? nothing : this.#keyField({
            field: "jevKey",
            keySet: llm.jev?.keySet === true,
            label: "Jev key",
            draftName: "jevDraft",
            replacingName: "replacingJev",
            save: (key) => this.#actor.send({ type: "_saveJevKey", key }),
            remove: () => this.#actor.send({ type: "_removeJevKey" }),
          })}
          ${this.#valueChecks(llm, evaluators)}
          ${this.#checks(checks, evaluators)}
        </div>
    `;
  }

  // Reading aloud in the Mac app (3.4), under This device, since the voice is downloaded to
  // this Mac: the Voice model row, which shows the size before the download starts, a bar
  // with Cancel while it runs, and ready once it is checked; then the Voice list and Play a
  // sample, only once it is ready.
  #readingMac(reading) {
    const { state, done, size } = reading.kokoro ?? { state: "missing", done: 0, size: 0 };
    const total = size ? ` · ${mb(size)} MB` : "";
    const share = size ? Math.min(100, (done / size) * 100) : 0;
    const model =
      state === "ready"
        ? html`<span class="status"><span class="dot" aria-hidden="true"></span>Kokoro · ready on this Mac</span>`
        : state === "downloading"
        ? html`
            <span class="bar" role="progressbar" aria-label="Downloading the voice" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(share)}
              ><i style="width: ${share}%"></i
            ></span>
            <span class="of">${mb(done)} of ${mb(size)} MB</span>
            <button class="act" @click=${() => this.#actor.send({ type: "_cancelDownload" })}>Cancel</button>
          `
        : html`
            <span class="status">Kokoro · not downloaded</span>
            <button class="act out" @click=${() => this.#actor.send({ type: "_download" })}>Download voice${total}</button>
          `;
    return html`
      <span class="group">Reading aloud</span>
      <div class="field">
        <span>Voice model</span>
        <div class="ollama" data-row="voice-model">${model}</div>
      </div>
      ${state === "ready" ? this.#voiceRow(reading) : nothing}
      <div class="field"><span></span><span class="help">Kokoro reads on this Mac, offline and free. It is downloaded once.</span></div>
    `;
  }

  // Reading aloud on the website (3.4), under Your account, since Inworld reads on the
  // account's own key: the key field the other keys use, then the Voice list and Play a
  // sample once a key is saved.
  #readingWeb(reading) {
    if (reading?.here !== "web") return nothing;
    const keySet = reading.keySet && !this.#actor.snapshot.context.removed.includes("inworldKey");
    return html`
      <span class="group reading">Reading aloud</span>
      ${this.#keyField({
        field: "inworldKey",
        keySet: reading.keySet,
        label: "Inworld key",
        draftName: "inworldDraft",
        replacingName: "replacingInworld",
        save: (key) => this.#actor.send({ type: "_saveInworldKey", key }),
        remove: () => this.#actor.send({ type: "_removeInworldKey" }),
      })}
      ${keySet ? this.#voiceRow(reading) : nothing}
    `;
  }

  // The Voice list and Play a sample. Choosing a voice is a step `voice` records; choosing
  // the previous one again, or Undo, brings it back. A press on Play a sample while it
  // plays stops it (Don Norman: forgiveness).
  #voiceRow(reading) {
    const name = reading.voices.find((v) => v.id === reading.voice)?.label ?? reading.voice;
    const error = this.#actor.snapshot.context.sample?.error;
    return html`
      <div class="field">
        <span>Voice</span>
        <div class="ollama" data-row="voice">
          <select aria-label="Voice" @change=${(e) => this.#actor.send({ type: "_setVoice", voice: e.target.value })}>
            ${reading.voices.map((v) => html`<option value=${v.id} .selected=${v.id === reading.voice}>${v.label}</option>`)}
          </select>
          <button class="act" @click=${() => this.#sample()}>
            ${this.playing ? html`${icon("stop")}Playing ${name}…` : html`${icon("speaker-high")}Play a sample`}
          </button>
        </div>
        ${error && !this.playing ? html`<span class="help">The sample could not be played. Try again in a moment.</span>` : nothing}
      </div>
    `;
  }

  #audio = null;
  #played = 0;

  #sample() {
    if (this.playing) return this.#stopSample();
    this.playing = true;
    this.#actor.send({ type: "_sample" });
  }

  #stopSample() {
    this.#audio?.pause();
    this.#audio = null;
    this.playing = false;
  }

  // Plays each sample the machine was answered once; an error answer ends the playing.
  updated() {
    const sample = this.#actor.snapshot?.context.sample;
    if (!sample || sample.n === this.#played) return;
    this.#played = sample.n;
    if (!this.playing) return;
    if (sample.error) {
      this.playing = false;
      return;
    }
    const audio = new Audio(`data:${sample.mime};base64,${sample.audio}`);
    this.#audio = audio;
    const end = () => this.#audio === audio && this.#stopSample();
    audio.addEventListener("ended", end);
    audio.addEventListener("error", end);
    // A browser may refuse to play without a recent press; the button then reads as before.
    audio.play().catch(end);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#stopSample();
  }

  // The checks' rows (3.4), the same as the chat's: Provider, with Ollama its Ollama row,
  // then Model, the models downloaded there with Kev first, and the pull line while the
  // chosen model is missing.
  #decider({ provider, offered, models, model, running, ready }, llm) {
    const ollama = provider === "ollama" ? ollamaView(llm) : null;
    return html`
      <label class="field decider">
        <span>Provider</span>
        <select @change=${(e) => this.#actor.send({ type: "_setDecider", decider: e.target.value })}>
          ${offered.map((d) => html`<option value=${d} .selected=${d === provider}>${DECIDER_LABELS[d] ?? d}</option>`)}
        </select>
      </label>
      ${ollama ? this.#ollama(ollama, "checks") : nothing}
      ${ollama && !running
        ? nothing
        : models.length
        ? html`
            <label class="field decider-model">
              <span>Model</span>
              <select @change=${(e) => this.#actor.send({ type: "_setDeciderModel", model: e.target.value })}>
                ${models.map((m) => html`<option value=${m.id} .selected=${m.id === model}>${m.label}</option>`)}
              </select>
            </label>
          `
        : nothing}
      ${ollama && running && !ready
        ? this.#pullHint(
            PULL_KEV,
            html`Kev isn't downloaded. In Terminal: <code>${PULL_KEV}</code>`,
            html`<span class="help">It needs Ollama 0.40.4 or later.</span>`,
          )
        : nothing}
    `;
  }

  // The choice point checks: Jev answers an evaluator's questions about each line of a
  // box. The part folds the way the Vim keys list does (the user asked for the same fold):
  // the name and what it costs stay in view, the boxes are in a fold that starts closed.
  // Hidden when the page has no `choice-point-checks` to keep the settings, or a flag hides it (machine.js: checksShown).
  #checks(checks, evaluators) {
    if (!checksShown({ checks, hidden: this.#actor.snapshot.context.hidden })) return nothing;
    const choosable = evaluators.filter((e) => !e.removing);
    return html`
      <div class="checks">
        <details class="keys-fold">
          <summary>Choice point evaluators</summary>
          <div class="boxes">${BOXES.map(({ field, label }) => this.#checkBox(field, label, checks[field], choosable))}</div>
        </details>
      </div>
    `;
  }

  // The values checks: which evaluator Jev uses for the value lines and which for the
  // examples of the Your values sheet. Offered only once a Jev key is saved, since nothing
  // is checked without one (machine.js: valueChecksShown); folded like the choice point
  // checks, so the group stays short until the user wants it.
  #valueChecks(llm, evaluators) {
    const { valueChecks, hidden } = this.#actor.snapshot.context;
    if (!valueChecksShown({ valueChecks, hidden, llm })) return nothing;
    const choosable = valueCheckers(evaluators);
    const row = (line, label) => {
      const current = choosable.some((e) => e.id === valueChecks[line]) ? valueChecks[line] : null;
      return html`
        <div class="box" data-line=${line}>
          <label class="field">
            <span>${label}</span>
            <select @change=${(e) => this.#actor.send({ type: "_setValueChecker", line, evaluator: e.target.value || null })}>
              <option value="" .selected=${!current}>Not checked</option>
              ${choosable.map((e) => html`<option value=${e.id} .selected=${e.id === current}>${e.name || "Untitled"}</option>`)}
            </select>
          </label>
        </div>
      `;
    };
    return html`
      <details class="keys-fold value-checks">
        <summary>Your values evaluators</summary>
        <div class="boxes">${row("values", "Check values with")}${row("examples", "Check examples with")}</div>
      </details>
    `;
  }

  #checkBox(field, label, box, evaluators) {
    const current = box?.evaluator ?? null;
    const evaluator = evaluators.find((e) => e.id === current);
    const shown = boxView(box, evaluator);
    const questions = (evaluator?.questions ?? []).filter((q) => !q.removing);
    return html`
      <div class="box" data-field=${field}>
        <label class="field">
          <span>${label}</span>
          <select
            aria-label="Evaluator for ${label}"
            @change=${(e) => this.#actor.send({ type: "_setChecker", field, evaluator: e.target.value || null })}
          >
            <option value="" .selected=${!evaluator}>Not checked</option>
            ${evaluators.map((e) => html`<option value=${e.id} .selected=${e.id === current}>${e.name || "Untitled"}</option>`)}
          </select>
        </label>
        ${evaluator && !evaluator.combined ? questions.map((q, i) => this.#checkQuestion(field, q, i, shown.questions[i], questions)) : nothing}
        ${evaluator ? this.#alsoChoice(field, label, shown.also[0]?.evaluator ?? null, evaluators.filter((e) => e.id !== current)) : nothing}
      </div>
    `;
  }

  // A second evaluator that checks the same lines, in the same Jev request. It is offered
  // only while the box has its own evaluator, so a box never looks unchecked while it is
  // checked; None takes it away again. Its questions have no settings here: a combined
  // evaluator (Your values) counts every question toward its one mark.
  #alsoChoice(field, label, current, evaluators) {
    return html`
      <label class="field also">
        <span>Also check with</span>
        <select
          aria-label="Also check ${label} with"
          @change=${(e) => this.#actor.send({ type: "_setAlso", field, evaluator: e.target.value || null })}
        >
          <option value="" .selected=${!current}>None</option>
          ${evaluators.map((e) => html`<option value=${e.id} .selected=${e.id === current}>${e.name || "Untitled"}</option>`)}
        </select>
      </label>
    `;
  }

  // One question of a box's evaluator: Show, then, while shown, when it is shown (for a
  // question after the first). The answer expected is the evaluator's own. A
  // question switched off in the evaluator is not asked, so it has nothing to set here.
  #checkQuestion(field, q, i, setting, questions) {
    if (q.on === false) {
      return html`
        <div class="question off" data-question=${q.id}>
          <span>${i + 1}. ${q.text || "Untitled question"}</span>
          <span class="note">Off in the evaluator</span>
        </div>
      `;
    }
    const set = (patch) => this.#actor.send({ type: "_setQuestion", field, id: q.id, patch });
    const when = setting.when ? `${setting.when.question} ${setting.when.option}` : "";
    const earlier = questions.slice(0, i).filter((p) => p.on !== false);
    return html`
      <div class="question" data-question=${q.id}>
        <label>
          <span>${i + 1}. ${q.text || "Untitled question"}</span>
          <input type="checkbox" .checked=${setting.show} @change=${(e) => set({ show: e.target.checked })} />
        </label>
        ${setting.show && i > 0
          ? html`
              <div class="choices">
                <span>Ask</span>
                <select
                  aria-label="When question ${i + 1} is shown"
                  @change=${(e) => {
                    const [question, option] = e.target.value.split(" ");
                    set({ when: question ? { question, option } : null });
                  }}
                >
                  <option value="" .selected=${!when}>Always</option>
                  ${earlier.flatMap((p) =>
                    answersOf(p).map(
                      (a) => html`<option value="${p.id} ${a.id}" .selected=${when === `${p.id} ${a.id}`}>
                        Only when question ${questions.indexOf(p) + 1} is ${a.name}
                      </option>`,
                    ),
                  )}
                </select>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  // A key field: the provider's API key, or the Jev key. A saved key reads as a plain
  // statement with Replace and Remove, so nothing on screen looks disabled; the box
  // appears only when a key is wanted, and Cancel or Escape closes it again without a
  // change (forgiveness). Remove goes at once; `llm` makes it a step with Undo (12).
  // `draftName` and `replacingName` name this field's own two state properties, so the
  // two keys never share a draft; `field` names it to the machine ("key", "jevKey").
  #keyField({ field, keySet: saved, label, draftName, replacingName, save: saveKey, remove }) {
    const draft = this[draftName];
    const { removed } = this.#actor.snapshot.context;
    const keySet = saved && !removed.includes(field);
    const cancel = () => {
      this[draftName] = "";
      this[replacingName] = false;
    };
    const save = (key = draft) => {
      saveKey(key);
      cancel();
    };
    const open = !keySet || this[replacingName];
    return html`
      <div class="field">
        <span>${label}</span>
        <div class="key" data-key=${draftName}>
          ${open
            ? html`
                <input
                  type="text"
                  autocomplete="off"
                  autocapitalize="off"
                  spellcheck="false"
                  aria-label=${label}
                  placeholder="Paste your ${label}"
                  .value=${draft}
                  @input=${(e) => (this[draftName] = e.target.value)}
                  @keydown=${(e) => {
                    // The box's own value, not the draft of the last render, so Enter
                    // right after a paste saves what was pasted.
                    if (e.key === "Enter" && e.target.value) save(e.target.value);
                    if (e.key === "Escape" && keySet) cancel();
                  }}
                />
                <button class="act" ?disabled=${draft.length === 0} @click=${() => save()}>Save</button>
                ${keySet ? html`<button class="act" @click=${cancel}>Cancel</button>` : nothing}
              `
            : html`
                <span class="saved">Key saved</span>
                <button
                  class="act"
                  @click=${async () => {
                    this[replacingName] = true;
                    await this.updateComplete;
                    this.renderRoot.querySelector(`.key[data-key="${draftName}"] input`)?.focus();
                  }}
                >
                  Replace
                </button>
                <button
                  class="act"
                  @click=${async () => {
                    remove();
                    // The keyboard stays on the row, in the box for a new key.
                    await this.updateComplete;
                    this.renderRoot.querySelector(`.key[data-key="${draftName}"] input`)?.focus();
                  }}
                >
                  Remove
                </button>
              `}
        </div>
      </div>
    `;
  }
}

customElements.define("settings-sheet", SettingsSheet);
