import { LitElement, html, css } from "lit";
import { mount, unmount } from "bus";
import { machine } from "./machine.js";

// Read from the stylesheet after render-blocking sheets have loaded, so `cssRules`
// is readable. The actor also calls this on every color-scheme.changed, so the
// printed values follow the scheme. DOM access is the view's job, grouping the actor's.
function collectTokens() {
  const names = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet
    }
    for (const rule of rules) {
      if (rule.selectorText !== ":root") continue;
      for (const prop of rule.style) {
        if (prop.startsWith("--")) names.add(prop);
      }
    }
  }
  const root = getComputedStyle(document.documentElement);
  return [...names].map((name) => ({
    name,
    value: root.getPropertyValue(name).trim(),
  }));
}

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, { input: { collect: collectTokens } });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
  }

  hostDisconnected() {
    this.subscription?.unsubscribe();
    unmount(this.actor);
  }

  get groups() {
    return this.actor?.getSnapshot().context.groups ?? [];
  }
}

const MOTION = new Set(["duration", "ease"]);
const TITLE_SIZES = new Set(["--text-heading", "--text-subtitle"]);
const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

class TokenSheet extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: var(--space-xl) var(--space-md);
    }
    .sheet {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xl);
    }
    section {
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
    }
    h2 {
      margin: 0;
      font-size: var(--text-heading);
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      text-transform: capitalize;
    }
    .tokens {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(calc(var(--space-2xl) * 5), 1fr));
      gap: var(--space-md);
    }
    .token {
      display: flex;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-md);
      border-radius: var(--radius-md);
      background: var(--color-canvas-soft);
    }
    .sample {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      min-width: var(--space-2xl);
      min-height: var(--space-2xl);
    }
    .meta {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      min-width: 0;
    }
    .name {
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      word-break: break-all;
    }
    .value {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
      word-break: break-all;
    }
    .swatch {
      width: var(--space-2xl);
      height: var(--space-2xl);
      border-radius: var(--radius-sm);
      border: var(--border-width) solid var(--color-border-strong);
    }
    .box {
      width: var(--space-2xl);
      height: var(--space-2xl);
      background: var(--color-accent);
    }
    .card {
      width: var(--space-2xl);
      height: var(--space-2xl);
      border-radius: var(--radius-md);
      background: var(--color-canvas);
    }
    .bordered {
      width: var(--space-2xl);
      height: var(--space-2xl);
      border-style: solid;
      border-color: var(--color-border-strong);
      border-radius: var(--radius-sm);
    }
    .bar {
      height: var(--space-sm);
      border-radius: var(--radius-full);
      background: var(--color-accent);
    }
    .type {
      color: var(--color-ink);
      line-height: var(--leading-tight);
      white-space: nowrap;
    }
    /* A size is documented for a role (tokens.css): a title is set semibold and
       tight, so its sample looks like the sheet's own headings. */
    .title {
      font-weight: var(--weight-semibold);
    }
    .weight {
      font-size: var(--text-heading);
    }
    .leading {
      width: calc(var(--space-2xl) * 2);
      font-size: var(--text-sm);
      color: var(--color-ink);
    }
    .lanes {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
    }
    .lane {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
    }
    .track {
      width: calc(var(--space-2xl) * 2);
      height: var(--space-md);
      border-radius: var(--radius-full);
      background: var(--color-accent-subtle);
    }
    .dot {
      width: var(--space-md);
      height: var(--space-md);
      border-radius: var(--radius-full);
      background: var(--color-accent);
      transition-property: transform;
    }
    /* Motion plays on hover, so a 3s token is felt as 3s and a 100ms one as a flick. */
    .token:hover .dot {
      transform: translateX(calc(var(--space-2xl) * 2 - var(--space-md)));
    }
    @media (prefers-reduced-motion: reduce) {
      .dot {
        transition-duration: 0s;
      }
    }
    .lane-label {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .hint {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .focus {
      background: var(--color-canvas-soft);
    }
    .plain {
      font-size: var(--text-caption);
      color: var(--color-ink);
      text-align: center;
      word-break: break-all;
    }
  `;

  #actor = new ActorController(this);

  // The ease sample runs longer than any UI transition, because at 300ms
  // a curve and a straight line are indistinguishable.
  renderLane(duration, easing, label) {
    return html`<div class="lane">
      <div class="track">
        <div class="dot" style="transition-duration: ${duration}; transition-timing-function: ${easing}"></div>
      </div>
      ${label ? html`<span class="lane-label">${label}</span>` : ""}
    </div>`;
  }

  renderSample(family, token) {
    const name = token.name;
    switch (family) {
      case "color":
        return html`<div class="swatch" style="background: var(${name})"></div>`;
      case "text": {
        const role = name.slice("--text-".length);
        const cls = TITLE_SIZES.has(name) ? "type title" : "type";
        return html`<span class=${cls} style="font-size: var(${name})">${capitalize(role)}</span>`;
      }
      case "weight":
        return html`<span class="type weight" style="font-weight: var(${name})">Ag</span>`;
      case "leading":
        return html`<p class="leading" style="line-height: var(${name})">
          The quick brown fox jumps over the lazy dog and keeps running.
        </p>`;
      case "duration":
        return this.renderLane(`var(${name})`, "linear");
      case "ease":
        return html`<div class="lanes">
          ${this.renderLane("calc(var(--duration-slide) * 4)", `var(${name})`, "ease")}
          ${this.renderLane("calc(var(--duration-slide) * 4)", "linear", "linear")}
        </div>`;
      case "font":
        return html`<span class="type" style="font-family: var(${name})">Ag</span>`;
      case "space":
        return html`<div class="bar" style="width: var(${name})"></div>`;
      case "radius":
        return html`<div class="box" style="border-radius: var(${name})"></div>`;
      case "shadow":
        return html`<div class="card" style="box-shadow: var(${name})"></div>`;
      case "focus":
        return html`<div class="card focus" style="box-shadow: var(${name})"></div>`;
      case "border":
        return html`<div class="bordered" style="border-width: var(${name})"></div>`;
      default:
        return html`<span class="plain">${token.value}</span>`;
    }
  }

  render() {
    return html`
      <div class="sheet">
        ${this.#actor.groups.map(
          (group) => html`
            <section>
              <h2>${group.name}</h2>
              <div class="tokens">
                ${group.tokens.map(
                  (token) => html`
                    <div class="token">
                      <div class="sample">
                        ${this.renderSample(group.name, token)}
                      </div>
                      <div class="meta">
                        <code class="name">${token.name}</code>
                        <code class="value">${token.value}</code>
                        ${MOTION.has(group.name) ? html`<span class="hint">hover to play</span>` : ""}
                      </div>
                    </div>
                  `,
                )}
              </div>
            </section>
          `,
        )}
      </div>
    `;
  }
}

customElements.define("token-sheet", TokenSheet);
