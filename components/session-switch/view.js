import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import signin from "./events/signin.requested.json" with { type: "json" };
import signout from "./events/signout.requested.json" with { type: "json" };

// Icon names are literals (7.6), so the icon check can read them: a dashed circle
// while anonymous, a solid one once signed in — the single sign of state.
const DASHED = icon("user-circle-dashed");
const SOLID = icon("user-circle");

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "signin.requested": signin, "signout.requested": signout },
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

class SessionSwitch extends LitElement {
  static styles = css`
    /* An inline control in the nav bar (slotted into page-nav), flush with the
       layout switch beside it: no surface of its own, the bar carries it. */
    :host {
      display: inline-flex;
      align-items: center;
      font-size: var(--text-body);
    }
    :host([hidden]) {
      display: none;
    }
    /* A tight pill hugging one 1em glyph. font-size is set here, not left to the
       button's UA default, so the icon reads at --text-body like the layout switch
       in every engine. */
    button {
      border: none;
      background: none;
      font-size: var(--text-body);
      cursor: pointer;
      padding: var(--space-xs);
      border-radius: var(--radius-full);
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    button:focus-visible {
      outline: var(--focus-ring);
    }
    button svg {
      display: block;
    }
    /* Anonymous: the dashed circle sits back in the bar's own muted ink, brightening
       on hover — a quiet invitation, not a call to action. */
    button.anon {
      color: var(--color-body-mid);
    }
    button.anon:hover {
      background: var(--color-surface-hover);
      color: var(--color-ink);
    }
    /* Signed in: the solid circle carries the accent, so "you are in" reads at a
       glance and is the same accent the arranging switch uses when it is on. */
    button.here {
      color: var(--color-accent);
    }
    button.here:hover {
      background: var(--color-surface-hover);
      color: var(--color-accent-hover);
    }
  `;

  #actor = new ActorController(this);

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    // No session on the page means nothing to switch: the control leaves the page,
    // the way layout-switch does without settings.
    if (snapshot.matches("failed")) {
      this.hidden = true;
      return nothing;
    }
    this.hidden = false;
    const { userId, registrationOpen } = snapshot.context;
    const here = Boolean(userId);
    const label = here ? "Sign out" : registrationOpen ? "Create account" : "Sign in";
    return html`
      <button class=${here ? "here" : "anon"} aria-label=${label} title=${label}
        @click=${() => this.#actor.send({ type: "_toggle" })}>
        ${here ? SOLID : DASHED}
      </button>
    `;
  }
}

customElements.define("session-switch", SessionSwitch);
