import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import arranged from "./events/dock.arranged.json" with { type: "json" };

const SIDES = ["left", "right", "bottom"];
// The four groups in one fixed order, so the action for "send to X" sits in the
// same place on every strip: a group's actions are the three other groups.
const GROUPS = ["left", "right", "bottom", "stage"];
// Icon names are literals (7.6), so the icon check can read them.
const SEND = {
  left: { glyph: icon("arrow-line-left"), label: "left" },
  right: { glyph: icon("arrow-line-right"), label: "right" },
  bottom: { glyph: icon("arrow-line-down"), label: "bottom" },
};
const RETURN = icon("arrows-in-simple");
// Fold points at the edge the dock recedes to; unfold points back into the desk.
const FOLD = { left: icon("caret-double-left"), right: icon("caret-double-right"), bottom: icon("caret-double-down") };
const UNFOLD = { left: icon("caret-double-right"), right: icon("caret-double-left"), bottom: icon("caret-double-up") };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // The children are what the page put on the desk (8); reading them is a read
    // of this element's own light DOM, and the machine only sees name and label.
    // The label falls back to the tag name when the child declares none.
    const views = [...this.host.children].map((child) => ({
      name: child.localName,
      label: child.getAttribute("label") ?? child.localName,
    }));
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload), views },
      events: { "dock.arranged": arranged },
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

class DockDesk extends LitElement {
  // Manual slot assignment: every child stays connected, so its actor stays
  // mounted, whether it is shown or behind another tab. No attribute is written on
  // any child, so the desk never touches another component.
  static shadowRootOptions = { ...LitElement.shadowRootOptions, slotAssignment: "manual" };

  static styles = css`
    /* base.css makes the body a flex column exactly one viewport tall (7.4), so a
       view fills the height left below page-nav by flexing, then owns its own
       scroll rather than growing the page. Every group scrolls inside its own
       body, so the page never scrolls, and the stage keeps its height whatever
       is docked. container-type makes :host the query container for its
       descendants; a container cannot restyle itself from its own query, so the
       layout lives on an inner .desk that the @container rule can reach. */
    :host {
      flex: 1;
      min-height: 0;
      display: block;
      container-type: inline-size;
    }
    .desk {
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .row {
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .stage {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .body {
      flex: 1;
      min-height: 0;
      overflow: auto;
    }
    /* One strip, four groups (Norman: one conceptual model). Tabs, then the
       actions for the shown tab, then on an edge the fold; every control is
       always visible, so what can be done is discoverable without hovering. */
    .strip {
      flex: none;
      box-sizing: border-box;
      height: var(--space-xl);
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: 0 var(--space-sm);
      border-bottom: var(--border-width) solid var(--color-border);
      font-size: var(--text-sm);
    }
    .dock .strip {
      background: var(--color-canvas-soft);
    }
    [role="tablist"] {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: var(--space-2xs);
      overflow-x: auto;
      scrollbar-width: none;
    }
    /* A strip narrower than its tabs scrolls without a bar, so the view brings the
       selected tab into the strip itself (updated()); once settled, it glides
       there, so the eye can follow where the tab went. */
    .settled .strip [role="tablist"] {
      scroll-behavior: smooth;
    }
    button {
      font: inherit;
      color: var(--color-body);
      background: none;
      border: 0;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover {
      background: var(--color-surface-hover);
    }
    button:focus-visible {
      outline: var(--focus-ring);
    }
    [role="tab"][aria-selected="true"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
    }
    .actions {
      flex: none;
      display: flex;
      align-items: center;
    }
    .action {
      box-sizing: border-box;
      width: calc(var(--space-lg) + var(--space-xs) * 2);
      height: calc(var(--space-lg) + var(--space-xs) * 2);
      padding: var(--space-xs);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: var(--text-body);
      color: var(--color-body-mid);
    }
    .action:hover {
      color: var(--color-ink);
    }
    .action svg {
      display: block;
    }
    .empty {
      margin: 0;
      padding: var(--space-xl) var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .empty svg {
      vertical-align: text-bottom;
    }
    /* An edge group is a band that slides between its open size and its strip.
       The band clips; inside it the panel keeps the open size, so nothing reflows
       mid-slide, and it sits against the stage so it recedes through the edge.
       The rail (the folded strip) lies on the edge under the panel and takes
       over when the slide ends; visibility is swapped with the slide's delay,
       instantly when unfolding. */
    .dock {
      flex: none;
      position: relative;
      overflow: hidden;
      background: var(--color-canvas);
    }
    .dock.left,
    .dock.right {
      width: calc(var(--space-2xl) * 6);
      display: flex;
    }
    .dock.left {
      justify-content: flex-end;
      border-right: var(--border-width) solid var(--color-border);
    }
    .dock.right {
      border-left: var(--border-width) solid var(--color-border);
    }
    .dock.bottom {
      height: calc(var(--space-2xl) * 5);
      border-top: var(--border-width) solid var(--color-border);
    }
    .dock.left.folded,
    .dock.right.folded {
      width: var(--space-xl);
    }
    .dock.bottom.folded {
      height: var(--space-xl);
    }
    .panel {
      flex: none;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
    }
    .left .panel,
    .right .panel {
      width: calc(var(--space-2xl) * 6);
      height: 100%;
    }
    .bottom .panel {
      width: 100%;
      height: calc(var(--space-2xl) * 5);
    }
    .folded .panel {
      visibility: hidden;
    }
    .rail {
      position: absolute;
      inset: 0;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-sm) 0;
      background: var(--color-canvas-soft);
      font-size: var(--text-sm);
      visibility: hidden;
    }
    .folded .rail {
      visibility: visible;
    }
    .rail [role="tablist"] {
      flex-direction: inherit;
      overflow: hidden;
    }
    /* Labels stand upright on a side rail: a vertical writing mode turns the
       strip's own row into a column. The left rail is turned so it reads from the
       bottom up, as a spine does; its caret is turned back so it still points into
       the desk. */
    .left .rail,
    .right .rail {
      writing-mode: vertical-rl;
    }
    .left .rail {
      transform: rotate(180deg);
    }
    .left .rail .action {
      transform: rotate(180deg);
    }
    /* The unfold caret sits at the top of either rail, where the fold was. */
    .right .rail .action {
      order: -1;
    }
    .bottom .rail {
      padding: 0 var(--space-sm);
    }
    .settled .dock {
      transition:
        width var(--duration-slide) var(--ease),
        height var(--duration-slide) var(--ease);
    }
    .settled .panel,
    .settled .rail {
      transition: visibility 0s;
    }
    .settled .folded .panel,
    .settled .folded .rail {
      transition-delay: var(--duration-slide);
    }
    /* A side that has just been docked to slides in from its edge: drawn once at
       nothing, then released to its size (updated()). A class the view sets rather
       than @starting-style, which WebKit re-applies to a dock whenever a slot is
       reassigned, so every move replayed both docks' entrances. */
    .settled .dock.entering.left,
    .settled .dock.entering.right {
      width: 0;
    }
    .settled .dock.entering.bottom {
      height: 0;
    }
    @media (prefers-reduced-motion: reduce) {
      .settled .dock,
      .settled .panel,
      .settled .rail {
        transition: none;
      }
      .settled .strip [role="tablist"] {
        scroll-behavior: auto;
      }
    }
    /* Below the width where a beside-the-stage dock stops fitting, every dock drops
       under the stage as a stacked bottom sheet, each capped at half the phone. The
       phone preview narrows the body, so the host width is the honest signal;
       data-viewport is never read. 45rem is a literal, not a token, because 7.4
       admits only tokens for lengths that place a box, and a container breakpoint is
       neither. Range syntax: WebKit ≥ 16.4 and Chromium support it. */
    @container (width < 45rem) {
      /* One column: the row dissolves so the stage and all three sheets share
         the height, each sheet giving way down to its strip before the stage
         shrinks below a readable minimum. */
      .row {
        display: contents;
      }
      .stage {
        order: 0;
        flex: 1 1 0;
        min-height: calc(var(--space-2xl) * 2);
      }
      .dock,
      .dock.left,
      .dock.right {
        order: 1;
        flex: 0 1 auto;
        width: auto;
        height: calc(var(--space-2xl) * 5);
        min-height: var(--space-xl);
        max-height: calc(var(--viewport-phone-tall) / 2);
        display: block;
        border-left: 0;
        border-right: 0;
        border-top: var(--border-width) solid var(--color-border);
      }
      .dock.folded,
      .dock.left.folded,
      .dock.right.folded {
        width: auto;
        height: var(--space-xl);
      }
      .panel,
      .left .panel,
      .right .panel {
        width: 100%;
        height: 100%;
      }
      .left .rail,
      .right .rail {
        writing-mode: horizontal-tb;
        transform: none;
        padding: 0 var(--space-sm);
      }
      .left .rail .action,
      .right .rail .action {
        transform: none;
        order: 0;
      }
      .settled .dock.entering.left,
      .settled .dock.entering.right {
        width: auto;
        height: 0;
      }
    }
  `;

  #actor = new ActorController(this);
  #settled = false;
  #dockScroll = {};
  // The sides drawn at their size; a side not here is entering.
  #present = new Set();

  #send(type, name, side) {
    const event = { type };
    if (name !== undefined) event.name = name;
    if (side !== undefined) event.side = side;
    this.#actor.send(event);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading")) return nothing;
    const ready = snapshot.matches("ready");
    const { views, stage, docks } = snapshot.context;
    const labelOf = (name) => views.find((v) => v.name === name)?.label ?? name;
    const dockedAll = SIDES.flatMap((s) => docks[s]?.views ?? []);
    const tabs = views.map((v) => v.name).filter((name) => !dockedAll.includes(name));
    const dock = (side) => (docks[side] ? this.#dock(side, docks[side], labelOf) : nothing);

    return html`
      <div class="desk ${this.#settled ? "settled" : ""}">
        <div class="row">
          ${dock("left")}
          <section class="stage">
            <div class="strip">
              ${this.#tablist("Stage", tabs, stage, labelOf, (name) => this.#send("_open", name))}
              ${ready && stage ? this.#actions("stage", stage, labelOf) : nothing}
            </div>
            <div class="body" data-side="stage">
              ${stage
                ? tabs.map((name) => html`<slot name=${name} ?hidden=${name !== stage}></slot>`)
                : html`<p class="empty">
                    Everything is docked. Use ${RETURN} in a dock to bring a view back.
                  </p>`}
            </div>
          </section>
          ${dock("right")}
        </div>
        ${dock("bottom")}
      </div>
    `;
  }

  // A group's strip: tabs first, then the shown tab's actions, then the fold.
  #tablist(group, tabs, active, labelOf, activate) {
    return html`
      <div role="tablist" aria-label="${group} tabs" @keydown=${(e) => this.#arrow(e, tabs, active, activate)}>
        ${tabs.map(
          (name) => html`
            <button
              role="tab"
              aria-selected=${name === active}
              tabindex=${name === active ? 0 : -1}
              @click=${() => activate(name)}
            >
              ${labelOf(name)}
            </button>
          `,
        )}
      </div>
    `;
  }

  // Arrow keys move along a tablist and show the tab they land on; Home and End
  // jump to the ends. Either axis works, so a vertical rail reads the same keys.
  #arrow(event, tabs, active, activate) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const at = tabs.indexOf(active);
    let next;
    if (step) next = tabs[(at + step + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (!next || next === active) return;
    event.preventDefault();
    activate(next);
    this.updateComplete.then(() =>
      event.currentTarget.querySelector('[role="tab"][aria-selected="true"]')?.focus(),
    );
  }

  // The three other groups, in the fixed order, so the same arrow is always in
  // the same place: an edge sends to the other edges and returns to the stage.
  #actions(group, name, labelOf) {
    const label = labelOf(name);
    return html`
      <div class="actions">
        ${GROUPS.filter((g) => g !== group).map((g) =>
          g === "stage"
            ? this.#action(RETURN, `Return ${label} to the stage`, () => this.#send("_undock", name))
            : this.#action(
                SEND[g].glyph,
                `${group === "stage" ? "Dock" : "Move"} ${label} ${SEND[g].label}`,
                () => this.#send(group === "stage" ? "_dock" : "_move", name, g),
              ),
        )}
      </div>
    `;
  }

  #action(glyph, label, act) {
    return html`
      <button class="action" aria-label=${label} title=${label} @click=${act}>${glyph}</button>
    `;
  }

  #dock(side, dock, labelOf) {
    const active = dock.views.includes(dock.active) ? dock.active : dock.views[0];
    const show = (name) => this.#send("_activate", name, side);
    const group = `${side[0].toUpperCase()}${side.slice(1)} dock`;
    const entering = this.#present.has(side) ? "" : "entering";
    return html`
      <aside class="dock ${side} ${dock.open ? "" : "folded"} ${entering}" data-side=${side} aria-label=${group}>
        <div class="panel">
          <div class="strip">
            ${this.#tablist(group, dock.views, active, labelOf, show)}
            ${this.#actions(side, active, labelOf)}
            ${this.#action(FOLD[side], `Fold the ${side} dock`, () => this.#send("_fold", undefined, side))}
          </div>
          <div class="body" data-side=${side}>
            ${dock.views.map((name) => html`<slot name=${name} ?hidden=${name !== active}></slot>`)}
          </div>
        </div>
        <div class="rail">
          ${this.#tablist(group, dock.views, active, labelOf, show)}
          ${this.#action(UNFOLD[side], `Unfold the ${side} dock`, () => this.#send("_unfold", undefined, side))}
        </div>
      </aside>
    `;
  }

  // Capture each group's scroll before every re-render. Reassigning slots
  // redistributes the whole shadow tree, and WebKit resets a scroll container
  // when it does, throwing it back to the top on every stage change; we put it
  // back in updated(). Reading the value we captured means the user's own
  // scrolling between renders is preserved, not overwritten.
  update(changed) {
    for (const body of this.renderRoot?.querySelectorAll(".body") ?? [])
      this.#dockScroll[body.dataset.side] = body.scrollTop;
    super.update(changed);
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return;
    const child = (name) => [...this.children].find((c) => c.localName === name);
    // Reading a width commits the docks' new sizes before any slot is reassigned:
    // a dock that opened, or entered at nothing, starts its slide now, whereas
    // WebKit rebuilds the tree on a reassignment and would draw it at its end.
    for (const d of this.renderRoot.querySelectorAll(".dock")) void d.offsetWidth;
    for (const slot of this.renderRoot.querySelectorAll("slot[name]")) {
      const el = child(slot.name);
      const current = slot.assignedElements();
      if (el && !(current.length === 1 && current[0] === el)) slot.assign(el);
    }
    for (const body of this.renderRoot.querySelectorAll(".body")) {
      const want = this.#dockScroll[body.dataset.side];
      if (want != null && body.scrollTop !== want) body.scrollTop = want;
    }
    // The selected tab is what the strip is about, so it is never left clipped
    // behind the actions: scroll its strip just far enough to show it.
    for (const tab of this.renderRoot.querySelectorAll('.strip [role="tab"][aria-selected="true"]')) {
      const list = tab.parentElement;
      const t = tab.getBoundingClientRect();
      const l = list.getBoundingClientRect();
      const dx = t.right > l.right ? t.right - l.right : t.left < l.left ? t.left - l.left : 0;
      if (dx) list.scrollBy({ left: dx });
    }
    // Release the sides that entered, drawn once at nothing above, to their size.
    const sides = new Set([...this.renderRoot.querySelectorAll(".dock")].map((d) => d.dataset.side));
    for (const s of this.#present) if (!sides.has(s)) this.#present.delete(s);
    const entering = [...sides].filter((s) => !this.#present.has(s));
    if (entering.length) {
      for (const s of entering) this.#present.add(s);
      this.requestUpdate();
    }
    // Slides are feedback for a gesture, so the first picture is drawn still:
    // transitions switch on one frame after the desk has painted.
    if (!this.#settled && !snapshot.matches("loading")) {
      requestAnimationFrame(() => {
        this.#settled = true;
        this.requestUpdate();
      });
    }
  }
}

customElements.define("dock-desk", DockDesk);
