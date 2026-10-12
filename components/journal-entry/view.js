import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { machine, shown, margins, banner, toJudge, reasonLine, canJudge, conflictOn, longDate } from "./machine.js";
import saved from "./events/day.saved.json" with { type: "json" };
import judging from "./events/day.judging.requested.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), mint: ulid, now: () => Date.now() },
      events: { "day.saved": saved, "day.judging.requested": judging },
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

// The next local midnight after `now`, when the open day's banner appears.
const midnightAfter = (now) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

class JournalEntry extends LitElement {
  static properties = { height: { type: String, reflect: true } };

  // A panel's focus lands in what it shows (dock-desk): delegating it puts the keyboard
  // in the writing box.
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
      container-type: inline-size;
    }
    .page {
      box-sizing: border-box;
      padding: var(--space-md) var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      color: var(--color-body);
    }
    header {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    h2 {
      margin: 0;
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .status {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .status b {
      font-weight: var(--weight-semibold);
      color: var(--color-success);
    }
    .status b.closed {
      color: var(--color-body-mid);
    }
    .banner {
      margin: 0;
      padding: var(--space-sm) var(--space-md);
      border-radius: var(--radius-sm);
      background: var(--color-accent-subtle);
      color: var(--color-ink);
      font-size: var(--text-sm);
    }
    .line {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .judge {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-sm) var(--space-md);
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
      min-height: calc(var(--text-body) * var(--leading-normal) * 5 + var(--space-sm) * 2);
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
    button:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    button:disabled {
      cursor: default;
      color: var(--color-mute);
    }
    button.dark {
      padding: var(--space-xs) var(--space-md);
      border-color: var(--color-ink);
      background: var(--color-ink);
      color: var(--color-canvas);
    }
    button.dark:hover:not(:disabled) {
      background: var(--color-ink);
    }
    button.dark:disabled {
      border-color: var(--color-border);
      background: var(--color-surface-active);
      color: var(--color-mute);
    }
    /* Both copies of a day saved on two devices, side by side, each with the button that
       keeps it. */
    .conflict {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      padding: var(--space-md);
      border: var(--border-width) solid var(--color-warning);
      border-radius: var(--radius-md);
      background: var(--color-warning-subtle);
    }
    .conflict p {
      margin: 0;
      color: var(--color-ink);
      font-size: var(--text-sm);
    }
    .copies {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-sm);
    }
    .copy {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      min-width: 0;
    }
    .copy h3 {
      margin: 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
    }
    .copy pre {
      margin: 0;
      flex: 1;
      padding: var(--space-sm);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      color: var(--color-ink);
      font: inherit;
      font-size: var(--text-sm);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
    }
    .copy button {
      align-self: flex-start;
    }
    .paras {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
    }
    /* A paragraph with its margin beside it; under it on a narrow stage (the phone). */
    .para {
      display: grid;
      grid-template-columns: minmax(0, 1fr) calc(var(--space-2xl) * 3.5);
      gap: var(--space-md) var(--space-lg);
      padding: var(--space-sm) 0;
    }
    .para + .para {
      border-top: var(--border-width) dashed var(--color-border);
    }
    .para .text {
      margin: 0;
      color: var(--color-ink);
      line-height: var(--leading-normal);
      overflow-wrap: anywhere;
    }
    .para.unfinished .text {
      color: var(--color-mute);
    }
    .margin {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      min-width: 0;
      font-size: var(--text-caption);
    }
    .project {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .project > .name {
      font-weight: var(--weight-semibold);
      color: var(--color-accent-active);
    }
    .detector {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      padding-left: var(--space-sm);
      border-left: calc(var(--border-width) * 2) solid var(--color-border-strong);
    }
    .detector > .name {
      font-weight: var(--weight-semibold);
      color: var(--color-body-mid);
    }
    .pick {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2xs) var(--space-sm);
    }
    .pick b {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .pick.unsure b {
      font-weight: var(--weight-normal);
      color: var(--color-body-mid);
    }
    .sure {
      color: var(--color-body-mid);
      font-variant-numeric: tabular-nums;
    }
    .yn {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-sm);
      color: var(--color-body);
    }
    .pct {
      font-weight: var(--weight-semibold);
      font-variant-numeric: tabular-nums;
      color: var(--color-body);
    }
    .pct.yes {
      color: var(--color-success);
    }
    .pct.no {
      color: var(--color-danger);
    }
    .earlier {
      align-self: flex-start;
      padding: 0 var(--space-xs);
      border-radius: var(--radius-full);
      background: var(--color-surface-active);
      color: var(--color-body);
      cursor: help;
    }
    .note {
      color: var(--color-body-mid);
      font-style: italic;
    }
    .empty {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    /* Below about 30rem the paragraph would be squeezed beside its margin: a phone, or a
       desk with both docks open on a small window. */
    @container (width < 30rem) {
      .page {
        padding: var(--space-md);
      }
      .para {
        grid-template-columns: minmax(0, 1fr);
        gap: var(--space-xs);
      }
      .copies {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `;

  #actor = new ActorController(this);
  #timer = null;

  #send(event) {
    this.#actor.send(event);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.#timer);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="empty page">The journal is unavailable.</p>`;
    const { context } = snapshot;
    const { picture, selected, fresh, draft, editing, usedUp } = context;
    const now = Date.now();
    // Nobody acts at midnight, so a timer redraws the page when the banner is due.
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.requestUpdate(), midnightAfter(now) - now + 1000);
    const { day, editable } = shown(picture, selected, fresh, now);
    const text = editable && draft ? draft.text : day.text;
    const rows = margins(text, editable && editing, day, picture);
    const conflict = conflictOn(context.conflict, day, editable);
    const late = banner(day, editable, now);
    const why = reasonLine(picture, usedUp);
    const missing = toJudge(day, editable);
    return html`
      <div class="scroll">
        <div class="page">
          <header>
            <h2>${longDate(day.day)}</h2>
            <p class="status">
              ${editable
                ? html`<b>Open</b> · closes at midnight, or an hour after your last edit`
                : html`<b class="closed">Read only</b>`}
            </p>
          </header>
          ${late ? html`<p class="banner" role="status">${late}</p>` : nothing}
          ${conflict ? this.#conflict(conflict) : nothing}
          ${why ? html`<p class="line reason">${why}</p>` : nothing}
          ${missing
            ? html`<div class="judge">
                <button type="button" class="dark judge-day" ?disabled=${!canJudge(picture)} @click=${() => this.#send({ type: "_judge" })}>
                  Judge this day · ${missing} ¶
                </button>
                <span class="line">${plural(missing, "paragraph is", "paragraphs are")} not read by every detector that is on now.</span>
              </div>`
            : nothing}
          ${editable && !conflict
            ? html`<textarea
                class="text"
                aria-label="Today's entry"
                placeholder="What is on your mind? Press Enter to finish a paragraph."
                .value=${text}
                @input=${(e) => this.#send({ type: "_edit", text: e.target.value })}
                @blur=${() => this.#send({ type: "_blur" })}
              ></textarea>`
            : nothing}
          ${rows.length ? html`<ol class="paras">${rows.map((r) => this.#para(r))}</ol>` : nothing}
        </div>
      </div>
    `;
  }

  // Both copies, each kept in one step. A closed day can no longer be saved, so only the
  // other copy can stay, and the user's own is shown to copy from.
  #conflict(c) {
    return html`
      <section class="conflict" aria-label="Two copies of this entry">
        <p>
          ${c.keepable
            ? "This entry was also changed on another device. Keep one copy."
            : "This entry was also changed on another device, and it has closed, so the other copy is kept. Yours is here to copy from."}
        </p>
        <div class="copies">
          <div class="copy mine">
            <h3>Yours</h3>
            <pre>${c.mine}</pre>
            ${c.keepable ? html`<button type="button" class="keep-mine" @click=${() => this.#send({ type: "_keepMine" })}>Keep this copy</button>` : nothing}
          </div>
          <div class="copy theirs">
            <h3>The other device's</h3>
            <pre>${c.theirs}</pre>
            <button type="button" class="keep-theirs" @click=${() => this.#send({ type: "_keepTheirs" })}>
              ${c.keepable ? "Keep this copy" : "Done"}
            </button>
          </div>
        </div>
      </section>
    `;
  }

  #para(r) {
    return html`<li class="para ${r.state}"><p class="text">${r.text}</p><div class="margin">${this.#margin(r)}</div></li>`;
  }

  #margin(r) {
    if (r.state === "unfinished") return html`<span class="note">Not finished yet</span>`;
    if (r.state === "waiting") return html`<span class="note" role="status">Judging…</span>`;
    return r.projects.map(
      (p) => html`<div class="project">
        ${p.name ? html`<span class="name">${p.name}</span>` : nothing}
        ${p.detectors.map(
          (d) => html`<div class="detector">
            <span class="name">${d.name}</span>
            ${d.entries.map((e) => this.#entry(e))}
          </div>`,
        )}
      </div>`,
    );
  }

  #entry(e) {
    const earlier = e.earlier === null ? nothing : html`<span class="earlier" title=${e.earlier}>earlier wording</span>`;
    if (e.kind === "pick")
      return html`<span class="pick ${e.sure === "unsure" ? "unsure" : ""}"><b>${e.pick}</b> <span class="sure">${e.sure}</span></span>${earlier}`;
    return html`<span class="yn"><span>${e.text}</span><span class="pct ${e.tone}">${e.pct}%</span></span>${earlier}`;
  }
}

customElements.define("journal-entry", JournalEntry);
