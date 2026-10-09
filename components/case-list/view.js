import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import {
  machine,
  rows,
  onTools,
  firstLine,
  answersLine,
  verdict,
  blocked,
  counts,
  progress,
  waiting,
  stopped,
  errorText,
} from "./machine.js";
import selected from "./events/case.selected.json" with { type: "json" };
import requested from "./events/judging.requested.json" with { type: "json" };
import results from "./events/results.selected.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid },
      events: { "case.selected": selected, "judging.requested": requested, "results.selected": results },
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

class CaseList extends LitElement {
  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // on Judge all or the first row.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, delegatesFocus: true };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow-y: auto;
    }
    .head {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm) var(--space-sm) var(--space-xs);
    }
    .run {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .judge {
      appearance: none;
      font: inherit;
      cursor: pointer;
      border-radius: var(--radius-sm);
      padding: var(--space-xs) var(--space-md);
      border: var(--border-width) solid var(--color-ink);
      background: var(--color-ink);
      color: var(--color-canvas);
    }
    .judge:disabled {
      cursor: default;
      background: var(--color-surface-active);
      border-color: var(--color-surface-active);
      color: var(--color-body-mid);
    }
    .judge:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .progress {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      font-size: var(--text-sm);
      color: var(--color-body);
    }
    .track {
      height: calc(var(--space-xs) + var(--space-2xs));
      border-radius: var(--radius-full);
      background: var(--color-surface-active);
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: var(--color-accent);
      border-radius: var(--radius-full);
      transition: width var(--duration-fast) linear;
    }
    .error {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
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
    /* The row's text is its open button, so a row is one tab stop. */
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
      color: var(--color-ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name.untitled {
      color: var(--color-mute);
    }
    .name.draft {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      color: var(--color-body-mid);
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
    .mark {
      flex: none;
      display: inline-flex;
      justify-content: center;
      width: calc(var(--text-body) * 1.25);
      font-size: var(--text-body);
    }
    .mark.right {
      color: var(--color-success);
    }
    .mark.wrong {
      color: var(--color-danger);
    }
    .mark.wait {
      color: var(--color-mute);
    }
    .hint,
    .empty {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .hint.foot {
      padding: 0 var(--space-sm) var(--space-md);
    }
    .empty {
      padding: var(--space-xs) var(--space-sm);
      font-size: var(--text-sm);
    }
  `;

  #actor = new ActorController(this);

  // Up and Down move between the rows' open buttons, as in the other lists.
  #keydown(event) {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const buttons = [...this.renderRoot.querySelectorAll(".open")];
    const at = buttons.findIndex((b) => b === this.renderRoot.activeElement);
    const next = buttons[at + step];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty">Cases unavailable.</p>`;
    const { context } = snapshot;
    const { draft, current, cases, rubrics, decisions, run } = context;
    const shown = rows(cases, current);
    const tools = onTools(rubrics, current);
    const openId = context.open?.[current];
    // The open case may be a new one not saved yet: New case is then the open row.
    const newOpen = openId != null && !cases.some((c) => c.id === openId);
    const why = blocked(context);
    // While this project's run is going the progress line says so, and the line beside
    // the button keeps saying what is judged.
    const going = progress(run, current);
    const error = stopped(run, current);
    return html`
      <div class="head">
        <div class="run">
          <button class="judge" type="button" ?disabled=${why !== null} @click=${() => this.#actor.send({ type: "_judge" })}>
            Judge all
          </button>
          <span class="hint">${going ? counts(context) : why ?? counts(context)}</span>
        </div>
        ${going
          ? html`<div class="progress" role="status">
              <span>${going.text}</span>
              <div class="track"><div class="fill" style="width: ${going.share * 100}%"></div></div>
            </div>`
          : nothing}
        ${error ? html`<p class="error" role="status">${errorText(error)}</p>` : nothing}
      </div>
      <ul class="list" aria-label="Cases" @keydown=${(e) => this.#keydown(e)}>
        <li class="row new ${newOpen ? "current" : ""}" @click=${() => this.#actor.send({ type: "_pick", id: draft })}>
          <button class="open" type="button" aria-current=${newOpen ? "true" : nothing}>
            <span class="name draft">${icon("plus")}New case</span>
          </button>
        </li>
        ${shown.map((c) => this.#row(c, c.id === openId, tools, decisions, waiting(run, current, c.id)))}
      </ul>
      ${shown.length ? nothing : html`<p class="empty">No cases yet. Use New case to add the first text to judge.</p>`}
      <p class="hint foot">Cases are kept on this device.</p>
    `;
  }

  #row(c, isOpen, tools, decisions, wait) {
    const line = firstLine(c.text);
    const v = wait ? null : verdict(c, tools, decisions);
    let mark = nothing;
    if (wait) mark = html`<span class="mark wait" title="Waiting">·</span>`;
    else if (v === true) mark = html`<span class="mark right" title="Right">${icon("check")}</span>`;
    else if (v === false) mark = html`<span class="mark wrong" title="Wrong">${icon("x")}</span>`;
    return html`
      <li class="row ${isOpen ? "current" : ""}" data-id=${c.id} @click=${() => this.#actor.send({ type: "_pick", id: c.id })}>
        <button class="open" type="button" aria-current=${isOpen ? "true" : nothing}>
          <span class="name ${line ? "" : "untitled"}">${line || "Empty case"}</span>
          <span class="sub">${answersLine(c, tools)}</span>
        </button>
        ${mark}
      </li>
    `;
  }
}

customElements.define("case-list", CaseList);
