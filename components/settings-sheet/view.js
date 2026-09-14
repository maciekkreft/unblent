import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine, merge } from "./machine.js";
import edited from "./events/settings.edited.json" with { type: "json" };

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
      },
      events: { "settings.edited": edited },
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
    button.reset {
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-md);
      cursor: pointer;
    }
    button.reset:hover {
      background: var(--color-surface-hover);
    }
    button.reset:focus-visible {
      outline: var(--focus-ring);
    }
    .failed {
      margin: 0;
      color: var(--color-body);
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loadingPages") || snapshot.matches("loadingSettings")) return nothing;
    if (snapshot.matches("failed")) return html`<p class="failed">settings unavailable</p>`;
    const { pages, settings, current } = snapshot.context;
    const rows = merge(pages, settings.nav);
    return html`
      <h2>Pages</h2>
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
      <div class="switches">
        <label>
          <input
            type="checkbox"
            .checked=${!settings.viewportSwitchHidden}
            @change=${() => this.#actor.send({ type: "_toggleViewport" })}
          />
          Desk|Phone switch shown
        </label>
        <label>
          <input
            type="checkbox"
            .checked=${!settings.layoutLockHidden}
            @change=${() => this.#actor.send({ type: "_toggleLock" })}
          />
          Layout lock shown
        </label>
      </div>
      <button class="reset" @click=${() => this.#actor.send({ type: "_reset" })}>Reset to defaults</button>
    `;
  }
}

customElements.define("settings-sheet", SettingsSheet);
