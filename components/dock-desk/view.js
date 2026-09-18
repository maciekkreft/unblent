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
// One toggle glyph for folding, whichever way a dock recedes; CSS orients it per
// side (mirrored on the right, turned down on the bottom, turned down on every
// sheet on the phone). Fold and unfold are the same glyph in the same place.
const FOLD = icon("sidebar-simple");
// The narrow-desk breakpoint (6.4): the same 45rem the @container rule below uses,
// a literal in both places because 7.4 admits no token for a container breakpoint.
// rem is relative to the root font-size, so a resolved px width reads it once.
const NARROW_REM = 45;
const ROOT_EM = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // The children are what the page put on the desk (8); reading them is a read
    // of this element's own light DOM, and the machine only sees name and label.
    // The label falls back to the tag name when the child declares none. A child
    // carrying `control` (6.4) is not a view: it gets no tab and no place in the
    // layout, so it is left out of `views` and slotted into the stage header.
    const views = [...this.host.children]
      .filter((child) => !child.hasAttribute("control"))
      .map((child) => ({
        // A view is keyed by its role, not its tag, so a composer swap (3.6, 12)
        // keeps its dock slot: the chosen member carries data-role, the page default
        // is named by its tag.
        name: child.getAttribute("data-role") ?? child.localName,
        label: child.getAttribute("label") ?? child.localName,
        side: child.getAttribute("side") ?? undefined,
      }));
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        views,
        // The seed folds a side too wide for a narrow desk (6.4); the host's own
        // width is the honest signal (the phone frame narrows the body), read when
        // the seed is chosen, and compared to the same breakpoint as the CSS.
        narrow: () => this.host.getBoundingClientRect().width < NARROW_REM * ROOT_EM(),
      },
      events: { "dock.arranged": arranged },
    });
    this.subscription = this.actor.subscribe(() => this.host.requestUpdate());
    // The composer (3.6) swaps a role element in place; a view keyed by role
    // stays the same docked view (12), so a re-render re-assigns the new element
    // to its slot (updated()). A child list change is the one thing outside the
    // actor that must redraw the desk.
    this.observer = new MutationObserver(() => this.host.requestUpdate());
    this.observer.observe(this.host, { childList: true });
  }

  hostDisconnected() {
    this.subscription?.unsubscribe();
    this.observer?.disconnect();
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
      /* The containing block for a phone drawer and its scrim, both absolute. */
      position: relative;
    }
    /* The scrim only exists on the phone, where a side dock overlays the stage as
       a drawer (@container below). On the desk a side dock sits beside the stage,
       so the scrim stays out of the way. */
    .scrim {
      display: none;
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
    /* A group's body lays out its view as the document body does (base.css), so a
       view's height="fill" fills a dock or the stage exactly as it fills a page.
       Slots are display: contents, so the slotted host is the flex item. */
    .body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
    }
    /* One strip, four groups (Norman: one conceptual model). Tabs, then the
       actions for the shown tab, then on an edge the fold; every control is
       always visible, so what can be done is discoverable without hovering. The
       stage strip also ends with the page's slotted controls (6.4). */
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
      cursor: pointer;
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
    /* Page controls (6.4) slotted at the trailing end of the stage strip, past the
       tabs and their actions; empty on a desk with no control children, so it adds
       nothing there. */
    .controls {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
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
    /* One fold glyph, oriented per side: the left needs nothing, the right is
       mirrored, the bottom is turned down. The rail reorients it back where the
       rail itself is turned (below). */
    .right .fold svg {
      transform: scaleX(-1);
    }
    .bottom .fold svg {
      transform: rotate(-90deg);
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
      opacity: 0;
    }
    /* The rail is the folded strip: it lies on the receding edge at the folded
       size, not across the whole dock. Spanning the dock (inset: 0) only looks
       right once folded, when the dock has shrunk to that size; mid-slide the
       dock is still wide and a centred spine drifts into the middle of the band
       and flashes there as it fades. Pinned to the edge, the spine stays on the
       edge throughout the slide. Each side sets its own anchor below. */
    .rail {
      position: absolute;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-sm) 0;
      background: var(--color-canvas-soft);
      font-size: var(--text-sm);
      cursor: pointer;
      visibility: hidden;
      opacity: 0;
    }
    .folded .rail {
      visibility: visible;
      opacity: 1;
    }
    .rail [role="tablist"] {
      flex-direction: inherit;
      overflow: hidden;
    }
    /* Labels stand upright on a side rail: a vertical writing mode turns the
       strip's own row into a column. The left rail is turned so it reads from the
       bottom up, as a spine does; its fold glyph is turned back so it reads the
       same as on the strip. */
    .left .rail,
    .right .rail {
      writing-mode: vertical-rl;
      top: 0;
      bottom: 0;
      width: var(--space-xl);
    }
    .left .rail {
      left: 0;
      transform: rotate(180deg);
    }
    .right .rail {
      right: 0;
    }
    .left .rail .action {
      transform: rotate(180deg);
    }
    /* The unfold button sits at the top of either rail, where the fold was. */
    .right .rail .action {
      order: -1;
    }
    .bottom .rail {
      left: 0;
      right: 0;
      bottom: 0;
      height: var(--space-xl);
      padding: 0 var(--space-sm);
    }
    .settled .dock {
      transition:
        width var(--duration-slide) var(--ease),
        height var(--duration-slide) var(--ease);
    }
    /* Panel and rail cross-dissolve as the group recedes, rather than the panel
       sliding opaque while the rail fades in: right-pinned strip controls (the
       actions and the fold) otherwise ride the shrinking edge across the whole
       band and flash as a row of icons sweeping the emptying dock. Fading the
       panel out as it recedes dissolves that sweep into the rail fading up.
       Visibility flips only at the still ends, for hit-testing and assistive tech:
       on fold the rail turns visible at once and fades up while the panel fades
       down and then hides; on unfold the panel is visible at once and fades up
       while the rail fades down and then hides (the delay). */
    .settled .panel {
      transition: opacity var(--duration-slide) var(--ease), visibility 0s;
    }
    .settled .folded .panel {
      transition: opacity var(--duration-slide) var(--ease), visibility 0s var(--duration-slide);
    }
    .settled .rail {
      transition: opacity var(--duration-slide) var(--ease), visibility 0s var(--duration-slide);
    }
    .settled .folded .rail {
      transition: opacity var(--duration-slide) var(--ease), visibility 0s;
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
      .settled .rail,
      .settled .scrim {
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
      /* A folded side dock is a square button in the stage header's corner, not a
         full-height rail: it costs the header one token but leaves the whole stage
         width for the body below. Tapping it opens a full-height drawer over the
         stage (the geometry below). The dock is out of the flow, so folding never
         squeezes the stage; the header reserves the button's token as padding on
         the strip alone, one width whether the drawer is folded, open or sliding. */
      .row {
        position: relative;
      }
      .row:has(> .dock.left) .stage .strip {
        padding-left: var(--space-xl);
      }
      .row:has(> .dock.right) .stage .strip {
        padding-right: var(--space-xl);
      }
      .dock.left,
      .dock.right {
        position: absolute;
        top: 0;
        width: var(--space-xl);
        height: var(--space-xl);
        z-index: 0;
      }
      .dock.left {
        left: 0;
      }
      .dock.right {
        right: 0;
      }
      /* Opening a side dock grows it from the corner square to a full-height drawer
         over the stage, keeping its own canvas, edge border and clipping (base
         .dock); its panel fills it. It spans the row, so a bottom sheet stays whole
         below it, under the scrim. */
      .dock.left:not(.folded),
      .dock.right:not(.folded) {
        width: calc(100% - var(--space-2xl));
        height: 100%;
        box-shadow: var(--shadow-card);
        z-index: 2;
      }
      /* Folded, each side dock is a header-corner button: its rail lies flat as a
         square with the fold glyph centred, not a full-height vertical spine (base
         side-rail rules turned it upright). The tabs are hidden here — what the dock
         holds is read from the button's title and from the drawer once it opens. */
      .dock.left .rail,
      .dock.right .rail {
        writing-mode: horizontal-tb;
        transform: none;
        top: 0;
        bottom: auto;
        width: var(--space-xl);
        height: var(--space-xl);
        padding: 0;
        justify-content: center;
        background: transparent;
      }
      .dock.left .rail .action {
        transform: none;
      }
      .dock.left .rail [role="tablist"],
      .dock.right .rail [role="tablist"] {
        display: none;
      }
      /* Folded, the button carries no panel edge: the side border that divides an
         open drawer from the peeking stage would otherwise draw a stray tick beside
         the glyph, boxing the header. The open drawer keeps it (base .dock, the
         :not(.folded) state). */
      .dock.left.folded,
      .dock.right.folded {
        border: 0;
      }
      /* The left drawer opened from the leading corner, so its fold returns there:
         open and close are one spot. The right drawer's fold is already trailing. */
      .dock.left .strip .fold {
        order: -1;
      }
      .dock.left:not(.folded) .panel,
      .dock.right:not(.folded) .panel {
        width: 100%;
      }
      /* The drawer slides in from the whole edge, not out of the corner button:
         width animates while height steps at the still ends, so the panel is full
         height for the entire slide. Unfolding, height snaps to full at once, then
         the width grows from the edge; folding, it holds full height through the
         slide and drops back to the button only at the end (the same 0s-after-a-
         delay trick the visibility swap uses). z-index steps late so a closing
         drawer stays above the fading scrim until it is a button again. */
      .settled .dock.left,
      .settled .dock.right {
        transition:
          width var(--duration-slide) var(--ease),
          height 0s;
      }
      .settled .dock.left.folded,
      .settled .dock.right.folded {
        transition:
          width var(--duration-slide) var(--ease),
          height 0s var(--duration-slide),
          z-index 0s var(--duration-slide);
      }
      @media (prefers-reduced-motion: reduce) {
        .settled .dock.left,
        .settled .dock.right,
        .settled .dock.left.folded,
        .settled .dock.right.folded {
          transition: none;
        }
      }
      /* A bottom dock stays a sheet below the stage, giving way to its strip
         before the stage shrinks below a readable minimum. */
      .dock.bottom {
        flex: 0 1 auto;
        min-height: var(--space-xl);
        max-height: calc(var(--viewport-phone-tall) / 2);
      }
      /* The scrim dims the peeking stage while a drawer is open (.on, set by the
         view) and is the forgiving close target; it fades with the drawer and
         sits under the panel, over the stage. */
      .scrim {
        display: block;
        position: absolute;
        inset: 0;
        background: var(--color-scrim);
        z-index: 1;
        opacity: 0;
        visibility: hidden;
      }
      .scrim.on {
        opacity: 1;
        visibility: visible;
      }
      .settled .scrim {
        transition:
          opacity var(--duration-slide) var(--ease),
          visibility 0s var(--duration-slide);
      }
      .settled .scrim.on {
        transition: opacity var(--duration-slide) var(--ease);
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

  // A click on the bar toggles the panel, unless it landed on a control the bar
  // holds: tabs, actions and the fold glyph keep their own behaviour, so only
  // bare bar space folds or unfolds.
  #bar(event, act) {
    if (event.target.closest("button")) return;
    act();
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot || snapshot.matches("loading") || snapshot.matches("loadingSettings")) return nothing;
    const ready = snapshot.matches("ready");
    const { views, stage, docks, arranging } = snapshot.context;
    const labelOf = (name) => views.find((v) => v.name === name)?.label ?? name;
    const dockedAll = SIDES.flatMap((s) => docks[s]?.views ?? []);
    const tabs = views.map((v) => v.name).filter((name) => !dockedAll.includes(name));
    const dock = (side) => (docks[side] ? this.#dock(side, docks[side], labelOf, arranging) : nothing);
    // On the phone a side dock overlays the stage as a drawer (@container below);
    // the scrim dims the stage still peeking beside it, and tapping it folds the
    // drawer back to its header button — the forgiving close, one step, no new
    // gesture.
    const drawers = ["left", "right"].filter((s) => docks[s]?.open);
    const closeDrawers = () => drawers.forEach((s) => this.#send("_fold", undefined, s));

    return html`
      <div class="desk ${this.#settled ? "settled" : ""}">
        <div class="row">
          ${dock("left")}
          <section class="stage">
            <div class="strip">
              ${this.#tablist("Stage", tabs, stage, labelOf, (name) => this.#send("_open", name))}
              ${ready && stage && arranging ? this.#actions("stage", stage, labelOf) : nothing}
              <span class="controls"><slot></slot></span>
            </div>
            <div class="body" data-side="stage">
              ${stage
                ? tabs.map((name) => html`<slot name=${name} ?hidden=${name !== stage}></slot>`)
                : arranging
                  ? html`<p class="empty">
                      Everything is docked. Use ${RETURN} in a dock to bring a view back.
                    </p>`
                  : html`<p class="empty">Everything is docked. Turn on arranging to bring a view back.</p>`}
            </div>
          </section>
          ${dock("right")}
        </div>
        ${dock("bottom")}
        <div class="scrim ${drawers.length ? "on" : ""}" @click=${closeDrawers}></div>
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

  // A desk that is not being arranged shows no arrange control; folding stays, so
  // the fold and unfold buttons are always rendered (one glyph, oriented by CSS).
  #dock(side, dock, labelOf, arranging) {
    const active = dock.views.includes(dock.active) ? dock.active : dock.views[0];
    const show = (name) => this.#send("_activate", name, side);
    const group = `${side[0].toUpperCase()}${side.slice(1)} dock`;
    const entering = this.#present.has(side) ? "" : "entering";
    // Norman: the bar itself is the panel's handle, so the whole strip folds and
    // the whole rail unfolds, one conceptual model on the desk and on the phone
    // sheet. A click on a control inside the bar (a tab, an action, the glyph)
    // keeps its own behaviour; only bare bar space toggles.
    const fold = (event) => this.#bar(event, () => this.#send("_fold", undefined, side));
    const unfold = (event) => this.#bar(event, () => this.#send("_unfold", undefined, side));
    return html`
      <aside class="dock ${side} ${dock.open ? "" : "folded"} ${entering}" data-side=${side} aria-label=${group}>
        <div class="panel">
          <div class="strip" @click=${fold}>
            ${this.#tablist(group, dock.views, active, labelOf, show)}
            ${arranging ? this.#actions(side, active, labelOf) : nothing}
            ${this.#fold("Fold", "true", () => this.#send("_fold", undefined, side))}
          </div>
          <div class="body" data-side=${side}>
            ${dock.views.map((name) => html`<slot name=${name} ?hidden=${name !== active}></slot>`)}
          </div>
        </div>
        <div class="rail" @click=${unfold}>
          ${this.#tablist(group, dock.views, active, labelOf, show)}
          ${this.#fold("Unfold", "false", () => this.#send("_unfold", undefined, side), `Unfold ${dock.views.map(labelOf).join(", ")}`)}
        </div>
      </aside>
    `;
  }

  // The fold toggle: one glyph in the strip (expanded) and on the rail (folded),
  // oriented per side by CSS. The label loses the side name; the side reads from
  // the dock the button sits in. On the phone the folded rail is a header button
  // with no visible tabs, so its title names what the drawer holds; aria-label
  // stays the bare action, the accessible name the whole layout keys on.
  #fold(label, expanded, act, title = label) {
    return html`
      <button class="action fold" aria-label=${label} title=${title} aria-expanded=${expanded} @click=${act}>
        ${FOLD}
      </button>
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
    const child = (name) => [...this.children].find((c) => (c.getAttribute("data-role") ?? c.localName) === name);
    // Reading a width commits the docks' new sizes before any slot is reassigned:
    // a dock that opened, or entered at nothing, starts its slide now, whereas
    // WebKit rebuilds the tree on a reassignment and would draw it at its end.
    for (const d of this.renderRoot.querySelectorAll(".dock")) void d.offsetWidth;
    for (const slot of this.renderRoot.querySelectorAll("slot[name]")) {
      const el = child(slot.name);
      const current = slot.assignedElements();
      if (el && !(current.length === 1 && current[0] === el)) slot.assign(el);
    }
    // Slotting is manual (shadowRootOptions), so the control children (6.4) are
    // assigned by hand to the one unnamed slot in the stage strip, in page order.
    const controls = this.renderRoot.querySelector(".controls slot:not([name])");
    if (controls) {
      const want = [...this.children].filter((c) => c.hasAttribute("control"));
      const have = controls.assignedElements();
      if (want.length !== have.length || want.some((c, i) => have[i] !== c)) controls.assign(...want);
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
