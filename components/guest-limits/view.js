import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { machine, shortOf, limitText } from "./machine.js";
import limitsEdited from "./events/limits.edited.json" with { type: "json" };
import guestkeysEdited from "./events/guestkeys.edited.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "limits.edited": limitsEdited, "guestkeys.edited": guestkeysEdited },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
    // The part reads its data each time it comes into view: the sheet shows it only to
    // the admin, so nobody else asks.
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

  send(event) {
    this.actor?.send(event);
  }
}

class GuestLimits extends LitElement {
  // `drafts` holds what was typed in a key box until it is saved, by provider, and is
  // cleared after, so a key never lingers in a field; `replacing` names the providers
  // whose box is open over a key already saved.
  static properties = {
    drafts: { state: true },
    replacing: { state: true },
  };

  constructor() {
    super();
    this.drafts = {};
    this.replacing = new Set();
  }

  // The same column and rows as the Settings tab (settings-sheet), so the two tabs read
  // as one sheet: a name on the left, its control on the right.
  static styles = css`
    :host {
      display: block;
      padding: var(--space-md);
      max-width: var(--width-form);
    }
    h3 {
      margin: var(--space-xl) 0 var(--space-md);
      padding-top: var(--space-lg);
      border-top: var(--border-width) solid var(--color-border);
      font-size: var(--text-subtitle);
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    h3:first-child {
      margin-top: 0;
    }
    .part {
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
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
    .field > .help {
      grid-column: 2;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    .hint {
      margin: 0;
      color: var(--color-body-mid);
      font-size: var(--text-sm);
    }
    input {
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-xs);
    }
    input:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    input.money {
      width: calc(var(--space-2xl) * 2);
      font-variant-numeric: tabular-nums;
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
    .key input {
      flex: 1;
      min-width: 0;
    }
    button.act {
      font: inherit;
      color: var(--color-body);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: var(--space-2xs) var(--space-md);
      cursor: pointer;
    }
    button.act:hover:not(:disabled) {
      background: var(--color-surface-hover);
    }
    button.act:disabled {
      color: var(--color-border);
      cursor: default;
    }
    button.act:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
  `;

  #actor = new ActorController(this);

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on its first control.
  focus(options) {
    const target = this.renderRoot?.querySelector("input, button");
    if (target) target.focus(options);
    else super.focus(options);
  }

  // One limit: the amount in a box; Enter or leaving the box applies it, Escape puts
  // back what was there. Text that is not an amount is put back too, so a slip changes
  // nothing.
  #limit(name, field, value, optional) {
    const shown = limitText(value);
    const apply = (e) => {
      this.#actor.send({ type: "_setLimit", field, text: e.target.value });
      e.target.value = shown;
    };
    return html`
      <label class="field">
        <span>${name}</span>
        <input
          class="money"
          inputmode="decimal"
          aria-label=${name}
          placeholder=${optional ? "no own limit" : ""}
          .value=${shown}
          @change=${apply}
          @keydown=${(e) => {
            if (e.key === "Enter") e.target.blur();
            if (e.key === "Escape") e.target.value = shown;
          }}
        />
      </label>
    `;
  }

  // A key field, as on the Settings tab (settings-sheet's key field): a saved key reads
  // as a plain statement with Replace and Remove, so nothing on screen looks disabled;
  // the box appears only when a key is wanted, and Cancel or Escape closes it again
  // without a change (forgiveness).
  #keyField(provider) {
    const id = provider.id;
    const label = `${shortOf(provider.label)} key`;
    const draft = this.drafts[id] ?? "";
    const setDraft = (text) => (this.drafts = { ...this.drafts, [id]: text });
    const setReplacing = (on) => {
      const next = new Set(this.replacing);
      if (on) next.add(id);
      else next.delete(id);
      this.replacing = next;
    };
    const cancel = () => {
      setDraft("");
      setReplacing(false);
    };
    const save = () => {
      this.#actor.send({ type: "_saveKey", provider: id, key: draft });
      cancel();
    };
    const keySet = provider.guestKeySet;
    const open = !keySet || this.replacing.has(id);
    return html`
      <div class="field">
        <span>${label}</span>
        <div class="key" data-key=${id}>
          ${open
            ? html`
                <input
                  type="password"
                  aria-label=${label}
                  placeholder="Paste your ${label}"
                  .value=${draft}
                  @input=${(e) => setDraft(e.target.value)}
                  @keydown=${(e) => {
                    if (e.key === "Enter" && draft) save();
                    if (e.key === "Escape" && keySet) cancel();
                  }}
                />
                <button class="act" ?disabled=${draft.length === 0} @click=${save}>Save</button>
                ${keySet ? html`<button class="act" @click=${cancel}>Cancel</button>` : nothing}
              `
            : html`
                <span class="saved">Key saved</span>
                <button
                  class="act"
                  @click=${async () => {
                    setReplacing(true);
                    await this.updateComplete;
                    this.renderRoot.querySelector(`.key[data-key="${id}"] input`)?.focus();
                  }}
                >
                  Replace
                </button>
                <button class="act" @click=${() => this.#actor.send({ type: "_removeKey", provider: id })}>Remove</button>
              `}
        </div>
        ${keySet ? nothing : html`<span class="help">Without a guest key, guests are not offered ${shortOf(provider.label)}.</span>`}
      </div>
    `;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const { spending, failed } = snapshot.context;
    if (!spending) {
      return failed ? html`<h3>Limits</h3><p class="hint">The limits could not be read. Open this tab again to try again.</p>` : nothing;
    }
    const prices = spending.providers.map((p) => `${shortOf(p.label)}: ${p.price}.`).join(" ");
    return html`
      <h3>Limits</h3>
      <div class="part">
        ${this.#limit("Each guest, in total", "guest", spending.guest, false)}
        ${this.#limit("All guests, in total", "allGuests", spending.allGuests.limit, false)}
        ${spending.providers.map((p) => this.#limit(`${shortOf(p.label)}, all guests`, p.id, p.limit, true))}
        <p class="hint">Changes apply at once. Prices used: ${prices}</p>
      </div>
      <h3>Guest keys</h3>
      <div class="part">
        <p class="hint">Guests spend only on these keys. Your own keys stay on the Settings tab under "Your account".</p>
        ${spending.providers.map((p) => this.#keyField(p))}
      </div>
    `;
  }
}

customElements.define("guest-limits", GuestLimits);
