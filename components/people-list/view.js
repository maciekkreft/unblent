import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, tilesOf, rowsOf, shownOf } from "./machine.js";
import viewasRequested from "./events/viewas.requested.json" with { type: "json" };
import guestBlocked from "./events/guest.blocked.json" with { type: "json" };
import useReset from "./events/use.reset.json" with { type: "json" };
import removalStarted from "./events/removal.started.json" with { type: "json" };
import syncAllowed from "./events/sync.allowed.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "viewas.requested": viewasRequested, "guest.blocked": guestBlocked, "use.reset": useReset, "removal.started": removalStarted, "sync.allowed": syncAllowed },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
    // The part reads its data each time it comes into view: the sheet shows it only to
    // the admin, so nobody else asks, and each opening shows who came since.
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) this.actor.send({ type: "_shown" });
    });
    this.observer.observe(this.host);
  }

  hostDisconnected() {
    this.observer?.disconnect();
    this.subscription?.unsubscribe();
    unmount(this.actor);
  }

  get snapshot() {
    return this.actor?.getSnapshot();
  }
}

class PeopleList extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: var(--space-md);
    }
    h3 {
      margin: 0 0 var(--space-md);
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(calc(var(--space-2xl) * 2.5), 1fr));
      gap: var(--space-sm);
      margin-bottom: var(--space-md);
    }
    .tile {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm) var(--space-md);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }
    .tile .sub {
      color: var(--color-body-mid);
      font-size: var(--text-caption);
    }
    .tile .big {
      color: var(--color-ink);
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      font-variant-numeric: tabular-nums;
    }
    .tile .of {
      color: var(--color-body-mid);
      font-size: var(--text-caption);
      font-weight: var(--weight-normal);
    }
    .track {
      display: block;
      height: calc(var(--space-xs) + var(--space-2xs));
      background: var(--color-surface-active);
      border-radius: var(--radius-full);
      overflow: hidden;
    }
    .fill {
      display: block;
      height: 100%;
      border-radius: var(--radius-full);
      background: var(--color-accent);
    }
    .out .fill,
    .fill.out {
      background: var(--color-danger);
    }
    /* The table scrolls sideways on a narrow screen, inside its own frame, so the page
       itself never does. */
    .table {
      overflow-x: auto;
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: var(--text-caption);
    }
    th,
    td {
      text-align: left;
      padding: var(--space-sm) var(--space-md);
      border-bottom: var(--border-width) solid var(--color-border);
      white-space: nowrap;
    }
    tr:last-child td {
      border-bottom: 0;
    }
    th {
      color: var(--color-body-mid);
      background: var(--color-canvas-soft);
      font-weight: var(--weight-semibold);
      text-transform: uppercase;
    }
    td {
      color: var(--color-ink);
      font-variant-numeric: tabular-nums;
    }
    /* Who stays in view while the rest scrolls sideways: the first column sticks to the
       frame's left edge over an opaque ground, with a line marking where the rest slides
       under it. */
    th:first-child,
    td:first-child {
      position: sticky;
      left: 0;
      z-index: 1;
      box-shadow: inset calc(-1 * var(--border-width)) 0 0 var(--color-border);
    }
    td:first-child {
      background: var(--color-canvas);
    }
    .pill {
      display: inline-block;
      padding: var(--space-2xs) var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      background: var(--color-canvas-soft);
      color: var(--color-body);
      font-weight: var(--weight-semibold);
    }
    .pill.you {
      border-color: transparent;
      background: var(--color-accent-subtle);
      color: var(--color-ink);
    }
    .pill.blocked {
      color: var(--color-danger);
    }
    .mini {
      display: inline-block;
      width: calc(var(--space-2xl) * 0.75);
      margin-right: var(--space-xs);
      vertical-align: middle;
    }
    .own {
      color: var(--color-body-mid);
    }
    .actions {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      color: var(--color-body-mid);
    }
    .actions button {
      padding: var(--space-2xs) var(--space-xs);
      border: 0;
      border-radius: var(--radius-sm);
      background: none;
      color: var(--color-accent);
      font: inherit;
      font-weight: var(--weight-semibold);
      cursor: pointer;
    }
    .actions button:hover {
      background: var(--color-surface-hover);
    }
    .actions button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .actions button.danger {
      color: var(--color-danger);
    }
    .hint {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
  `;

  #actor = new ActorController(this);

  #used(used) {
    if (!used) return "—";
    if (used.own) return html`<span class="own">own keys</span>`;
    return html`<span class="mini track"><span class="fill ${used.out ? "out" : ""}" style="width: ${Math.round(used.share * 100)}%"></span></span>${used.spent}`;
  }

  // A guest row's actions (12): Reset use and Block take effect at once and show an
  // Undo in the notices, Delete waits out its Undo there, and View as is reversed by
  // Back to you on the bar.
  #actions(r) {
    const send = (type, extra = {}) => this.#actor.actor.send({ type, user: r.userId, ...extra });
    const who = r.who.replace(/ · blocked$/, "");
    return html`<span class="actions">
      <button type="button" aria-label="View as ${who}" @click=${() => send("_viewAs")}>View as</button>
      <span aria-hidden="true">·</span>
      <button type="button" aria-label="Reset use of ${who}" @click=${() => send("_reset")}>Reset use</button>
      <span aria-hidden="true">·</span>
      <button
        type="button"
        class=${r.blocked ? "" : "danger"}
        aria-label="${r.blocked ? "Unblock" : "Block"} ${who}"
        @click=${() => send("_block", { blocked: !r.blocked })}
      >${r.blocked ? "Unblock" : "Block"}</button>
      <span aria-hidden="true">·</span>
      <button type="button" class="danger" aria-label="Delete ${who}" @click=${() => send("_delete", { name: who })}>Delete</button>
    </span>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { spending, failed, deleting } = snapshot.context;
    const people = shownOf(snapshot.context.people, deleting);
    const now = Date.now();
    if (!people) {
      return html`<h3>People</h3>
        ${failed ? html`<p class="hint">The people could not be read. Open this tab again to try again.</p>` : nothing}`;
    }
    return html`
      <h3>People</h3>
      <div class="tiles">
        ${tilesOf(spending, people, now).map(
          (t) => html`
            <div class="tile">
              <span class="sub">${t.title}</span>
              <span class="big">${t.big}${t.of ? html` <span class="of">${t.of}</span>` : nothing}</span>
              ${t.share !== undefined
                ? html`<span class="track ${t.share >= 1 ? "out" : ""}"><span class="fill" style="width: ${Math.round(t.share * 100)}%"></span></span>`
                : html`<span class="sub">${t.sub}</span>`}
            </div>
          `,
        )}
      </div>
      <div class="table">
        <table>
          <thead>
            <tr><th>Who</th><th>First seen</th><th>Last seen</th><th>Where</th><th>Device</th><th>Used</th><th>Space</th><th aria-label="Actions"></th></tr>
          </thead>
          <tbody>
            ${rowsOf(people, spending, now).map(
              (r) => html`
                <tr data-user=${r.userId}>
                  <td><span class="pill ${r.look}">${r.who}</span></td>
                  <td>${r.firstSeen}</td>
                  <td>${r.lastSeen}</td>
                  <td>${r.where}</td>
                  <td>${r.device}</td>
                  <td>${this.#used(r.used)}</td>
                  <td>${r.space}</td>
                  <td>${r.guest ? this.#actions(r) : nothing}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
  }
}

customElements.define("people-list", PeopleList);
