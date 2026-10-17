import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, tilesOf, rowsOf } from "./machine.js";
import viewasRequested from "./events/viewas.requested.json" with { type: "json" };
import guestBlocked from "./events/guest.blocked.json" with { type: "json" };
import useReset from "./events/use.reset.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "viewas.requested": viewasRequested, "guest.blocked": guestBlocked, "use.reset": useReset },
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

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { people, spending, failed } = snapshot.context;
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
            <tr><th>Who</th><th>First seen</th><th>Last seen</th><th>Where</th><th>Device</th><th>Used</th><th>Space</th></tr>
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
