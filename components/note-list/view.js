import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, shown, apart, source, highlights, showing, chaptered, placement } from "./machine.js";
import selected from "./events/note.selected.json" with { type: "json" };
import discarded from "./events/note.discarded.json" with { type: "json" };
import highlightsSelected from "./events/highlights.selected.json" with { type: "json" };
import moved from "./events/note.moved.json" with { type: "json" };
import removalStarted from "./events/removal.started.json" with { type: "json" };

// The Highlights row's id (Decision 2): a fixed constant, never a note id, so the machine
// never mistakes it for a note. It is only a name the view routes on; the machine hears
// _pickHighlights, not this id.
const HIGHLIGHTS = "highlights";

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo
// window; the token is the one clock, shared with the bar's animation.
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // The undo window comes from --duration-undo, read off the host so a stylesheet
    // or a test can set it; the machine only ever sees the number (importable in Node).
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    // Whether the Highlights were the open row, kept in this browser (3.1) because the
    // panel keeps showing them across a reload.
    this.key = `note-list${this.host.id ? `#${this.host.id}` : ""}:highlights`;
    let highlightsOpen = false;
    try {
      highlightsOpen = localStorage.getItem(this.key) === "open";
    } catch {
      // No storage: the mark lives only for this page.
    }
    // Which way the chapter switch stands, kept in this browser (3.1) so the choice
    // follows the device; This chapter unless All chapters was chosen.
    this.chaptersKey = `note-list${this.host.id ? `#${this.host.id}` : ""}:chapters`;
    let allChapters = false;
    try {
      allChapters = localStorage.getItem(this.chaptersKey) === "all";
    } catch {
      // No storage: the switch starts on This chapter.
    }
    this.#keptAll = allChapters;
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        mint: ulid,
        undoMs,
        // The `subject` attribute (D5): present means follow the stage and show only
        // the notes about it. Parsed by the time hostConnected runs. Off is exactly
        // today's behaviour.
        following: this.host.subject,
        highlightsOpen,
        allChapters,
        // A try page (8) shows the list signed out.
        tryPage: location.pathname.startsWith("/try/"),
      },
      events: {
        "note.selected": selected,
        "note.discarded": discarded,
        "highlights.selected": highlightsSelected,
        "note.moved": moved,
        "removal.started": removalStarted,
      },
    });
    this.subscription = this.actor.subscribe((snapshot) => {
      this.#keep(snapshot.context.highlightsOpen);
      this.#keepAll(snapshot.context.allChapters);
      this.host.requestUpdate();
    });
  }

  #kept = null;
  #keep(open) {
    if (open === this.#kept) return;
    this.#kept = open;
    try {
      if (open) localStorage.setItem(this.key, "open");
      else localStorage.removeItem(this.key);
    } catch {
      // No storage: nothing to keep.
    }
  }

  #keptAll = false;
  #keepAll(all) {
    if (all === this.#keptAll) return;
    this.#keptAll = all;
    try {
      if (all) localStorage.setItem(this.chaptersKey, "all");
      else localStorage.removeItem(this.chaptersKey);
    } catch {
      // No storage: the choice lasts for this page.
    }
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

// The note's time, absolute and formatted once (no clock, no timer): a note from
// today reads as a time of day, an older one as a short date. `new Date()` is read
// at render, not on an interval, so nothing re-renders to keep it current — the row
// changes only when note.changed brings a new updatedAt.
const timeOfDay = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat("en", { day: "numeric", month: "short" });
const when = (at) => {
  const d = new Date(at);
  const now = new Date();
  const today =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return today ? timeOfDay.format(d) : shortDate.format(d);
};

// Swipe-to-delete is the touch path to the trash (6); a pointer, not a touch, event so
// the desk mouse and the phone preview drive it the same way. A drag under the slop is
// a tap; a mostly-vertical one is a scroll and is abandoned.
const SLOP = 6; // px before a horizontal drag is a swipe rather than a tap
const REVEAL = 0.5; // how far left the row slides open, as a fraction of its width
const THRESHOLD = 0.35; // past this fraction, releasing deletes

class NoteList extends LitElement {
  // The one attribute the tag understands (D5): follow the stage, showing only the
  // notes about the subject. Reflected so a page's bare `subject` reads as true and the
  // manifest attribute is visible. Off is exactly today's behaviour.
  static properties = {
    subject: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    /* The list scrolls inside its own box, so a docked list never grows the desk. */
    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      list-style: none;
      margin: 0;
      padding: var(--space-2xs);
    }
    /* A row clips its swipe layers and its undo bar, and is the positioning context
       for both. A drag is horizontal; vertical stays a native scroll (touch-action).
       Text is never selected on a press, so a swipe does not start a selection. */
    .row {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-sm);
      cursor: pointer;
      touch-action: pan-y;
      user-select: none;
      -webkit-user-select: none;
    }
    .row:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The sliding layer carries the row's content. A Notes.app row: a title line and
       a subtitle line in a column, the trailing box beside them. The transition
       animates the settle back after a release; a live drag turns it off so the row
       tracks the finger, and gives it an opaque ground so the delete layer shows only
       in the strip the slide vacates, not through the moving content. */
    .slide {
      position: relative;
      display: flex;
      align-items: flex-start;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-sm);
      transition: transform var(--duration-slide) var(--ease);
    }
    @media (prefers-reduced-motion: reduce) {
      .slide {
        transition: none;
      }
    }
    .row:hover .slide {
      background: var(--color-surface-hover);
    }
    /* The open row (the note the editor shows) is the one visible selection. */
    .row[aria-selected="true"] .slide {
      background: var(--color-accent-subtle);
    }
    .row[aria-selected="true"] .name {
      color: var(--color-ink);
    }
    .row.dragging .slide {
      background: var(--color-canvas);
      transition: none;
    }
    /* The delete layer, revealed only during a swipe (so its danger ground never
       bleeds through a translucent selection at rest): the word Delete at the trailing
       edge on a soft danger ground, going solid once the drag is far enough to delete.
       The rest/hover trash affordance already sits there, so naming the action in words
       keeps the swipe reveal from being a second identical bin. */
    .under {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-inline: var(--space-sm);
      background: var(--color-danger-subtle);
      color: var(--color-danger);
      visibility: hidden;
    }
    .row.dragging .under {
      visibility: visible;
    }
    .row.armed .under {
      background: var(--color-danger);
      color: var(--color-accent-text);
    }
    .text {
      flex: 1;
      min-width: 0;
    }
    /* The open note kept in the list though it is not about the subject (12): a caption
       naming why it is here, and a rule under the row that sets it off from the notes
       that are about the subject below it. */
    .tag {
      display: block;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    .row.apart {
      border-bottom: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-0);
      margin-bottom: var(--space-2xs);
    }
    /* The next-note row is one line, centred in a note row's two-line height so the
       list keeps a constant row height. The height is the two line-boxes a note row
       stacks (title + subtitle), expressed from the type tokens. */
    .row.draft .slide {
      align-items: center;
    }
    .row.draft .text {
      display: flex;
      align-items: center;
      min-height: calc(
        var(--text-body) * var(--leading-normal) + var(--text-sm) * var(--leading-tight)
      );
    }
    .name {
      display: block;
      color: var(--color-body);
      font-weight: var(--weight-semibold);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .name.untitled {
      color: var(--color-mute);
      font-weight: var(--weight-normal);
    }
    /* The next-note row: the same weight as body text, muted, with a plus mark, so
       it reads as the blank page to write on rather than an existing note. */
    .name.draft {
      color: var(--color-body-mid);
      font-weight: var(--weight-normal);
    }
    .name .mark {
      display: inline-flex;
      vertical-align: middle;
      margin-right: var(--space-xs);
      color: var(--color-body-mid);
    }
    .name .mark svg {
      display: block;
    }
    /* The note's second line. A note with none keeps the line (a mute placeholder),
       so a row is always two lines tall and the list does not jump as notes gain or
       lose a subtitle. */
    .subtitle {
      display: block;
      font-size: var(--text-sm);
      line-height: var(--leading-tight);
      color: var(--color-mute);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* The time and the trash share one cell, so the trash appears in place on hover or
       focus without shifting the row; the cell is as wide as the wider of the two. */
    .trailing {
      flex: none;
      display: grid;
      align-items: start;
      justify-items: end;
    }
    .time,
    .bin {
      grid-area: 1 / 1;
    }
    .time {
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .bin {
      display: inline-flex;
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      margin: 0;
      font: inherit;
      cursor: pointer;
      color: var(--color-body-mid);
      visibility: hidden;
    }
    .bin svg {
      display: block;
    }
    .row:hover .bin,
    .row:focus-within .bin {
      visibility: visible;
    }
    .row:hover .time,
    .row:focus-within .time {
      visibility: hidden;
    }
    /* The Highlights row has no bin to reveal (Decision 5), so its time stays put on
       hover rather than vanishing to make room for a trash that is not there. */
    .row.highlights:hover .time,
    .row.highlights:focus-within .time {
      visibility: visible;
    }
    .bin:hover {
      color: var(--color-danger);
    }
    /* A note counting down to its delete keeps its row so the user sees what is going,
       struck through, its trash swapped for Undo, with a bar draining the window. */
    .row.discarding .name,
    .row.discarding .subtitle {
      text-decoration: line-through;
      color: var(--color-mute);
    }
    /* A cut row (Vim's dd) waits greyed in place for p or P, with no countdown. */
    .row.cut .name,
    .row.cut .subtitle,
    .row.cut .cut-mark {
      color: var(--color-mute);
    }
    .row.cut:hover .time,
    .row.cut:focus-within .time {
      visibility: visible;
    }
    .undo {
      display: inline-flex;
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      margin: 0;
      font: inherit;
      font-size: var(--text-caption);
      cursor: pointer;
      color: var(--color-accent);
    }
    /* The bar is the visible echo of the machine's timer; both read --duration-undo,
       so they cannot disagree. It stays under reduced motion because it is the only
       sign of how long is left. */
    .bar {
      position: absolute;
      inset-inline: 0;
      inset-block-end: 0;
      height: var(--space-2xs);
      background: var(--color-accent);
      transform-origin: left;
      animation: drain var(--duration-undo) linear forwards;
    }
    @keyframes drain {
      from {
        transform: scaleX(1);
      }
      to {
        transform: scaleX(0);
      }
    }
    /* The chapter switch, above the list: two buttons in one rounded box, the pressed
       one raised, as the viewport switch draws its choice. */
    .switch {
      flex: none;
      display: flex;
      gap: var(--space-2xs);
      align-self: flex-start;
      margin: var(--space-xs) var(--space-sm) 0;
      padding: var(--space-2xs);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      font-size: var(--text-sm);
    }
    .switch button {
      border: none;
      background: none;
      cursor: pointer;
      padding: var(--space-2xs) var(--space-sm);
      border-radius: var(--radius-full);
      font-family: inherit;
      font-size: inherit;
      color: var(--color-body);
    }
    .switch button:hover {
      background: var(--color-surface-hover);
    }
    .switch button:focus-visible,
    .show-all:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .switch button[aria-pressed="true"] {
      color: var(--color-ink);
      font-weight: var(--weight-semibold);
      background: var(--color-surface-active);
    }
    /* The line between the items linked to no chapter and the rest. */
    .line {
      margin: var(--space-xs) var(--space-sm);
      border-top: var(--border-width) solid var(--color-border);
    }
    .none,
    .more {
      padding: var(--space-xs) var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .show-all {
      appearance: none;
      background: none;
      border: 0;
      padding: 0;
      margin: 0;
      font: inherit;
      cursor: pointer;
      color: var(--color-accent);
      border-radius: var(--radius-sm);
    }
    .show-all:hover {
      text-decoration: underline;
    }
    .empty {
      margin: 0;
      padding: var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);

  // The keyboard leaving the list while a row is cut or counting down hands the delete
  // to the corner notice (12). Checked once the focus has landed; a window losing focus
  // (another app) is not leaving the list.
  constructor() {
    super();
    this.addEventListener("focusout", () =>
      setTimeout(() => {
        if (!document.hasFocus() || this.matches(":focus-within")) return;
        const context = this.#actor.snapshot?.context;
        if (context && (context.cut || context.discarding.size)) this.#actor.send({ type: "_left" });
      }),
    );
  }
  // Which row holds the roving tabindex and focus. Ephemeral UI focus, not a fact:
  // null falls back to the open row, then the first.
  #focusId = null;
  // The swipe in progress, or null. The click a release fires is swallowed, so a
  // completed swipe does not also pick the row.
  #drag = null;
  #swallowClick = false;

  #rows(snapshot) {
    // While the subject has an open chapter the notes linked to no chapter come first, then
    // the open chapter's (This chapter) or every chapter's (All chapters); render draws a
    // line between them.
    const groups = chaptered(snapshot.context);
    const notes = groups ? [...groups.loose, ...(groups.all ? groups.rest : groups.here)] : shown(snapshot.context);
    const { draft } = snapshot.context;
    // The open note, when it is not about the subject (12), leads the list set apart, so
    // its highlighted row is never missing. It is a real row: pickable, deletable, and it
    // takes the roving focus like any other.
    const kept = apart(snapshot.context);
    // The Highlights row (Decision 1): under the New note row and above the notes, shown
    // only while the subject has a highlight. It is not a note; the view sets it apart.
    const hs = highlights(snapshot.context);
    const lead = [
      ...(kept ? [{ ...kept, apart: source(kept, snapshot.context.books, snapshot.context.subject) }] : []),
      ...(draft ? [{ id: draft, draft: true }] : []),
      ...(hs ? [{ id: HIGHLIGHTS, highlights: true, count: hs.count, updatedAt: hs.updatedAt }] : []),
    ];
    return [...lead, ...notes];
  }

  // The keyboard's row: the one it moved to, else the open one — the Highlights row
  // while the Highlights are open, else the open note — else the first.
  #focusRow(rows, { open, highlightsOpen }) {
    const has = (id) => rows.some((r) => r.id === id);
    if (this.#focusId && has(this.#focusId)) return this.#focusId;
    if (highlightsOpen && has(HIGHLIGHTS)) return HIGHLIGHTS;
    if (open && has(open)) return open;
    return rows[0]?.id ?? null;
  }

  // Vim letters (12, "Vim keys"): only while the preference is on, never with a modifier
  // held (those belong to the browser and the desk), and never inside a field, where a
  // letter is typed text. gg is two presses, so a first g waits a moment for the second.
  // dd is the same idiom.
  #gAt = 0;
  #dAt = 0;
  #vim(event) {
    if (this.#actor.snapshot?.context.vimKeys !== true) return null;
    if (event.ctrlKey || event.metaKey || event.altKey) return null;
    const target = event.composedPath()[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName)) return null;
    const second = event.key === "g" && Date.now() - this.#gAt < 1000;
    this.#gAt = event.key === "g" && !second ? Date.now() : 0;
    if (second) return "first";
    const cut = event.key === "d" && Date.now() - this.#dAt < 1000;
    this.#dAt = event.key === "d" && !cut ? Date.now() : 0;
    if (cut) return "cut";
    return (
      { j: "down", k: "up", G: "last", g: "prefix", d: "prefix", p: "below", P: "above", u: "undo", o: "openBelow", O: "openAbove" }[
        event.key
      ] ?? null
    );
  }

  // The neighbours a move is placed between (12), worked out by the machine (placement)
  // from the note rows as shown; the fixed rows are not notes a move can stand next to.
  #neighbours(rows, current, below) {
    const ids = rows.filter((r) => !r.draft && !r.highlights && !r.apart).map((r) => r.id);
    return placement(this.#actor.snapshot.context, ids, current, below);
  }

  #keydown(event, rows) {
    const context = this.#actor.snapshot.context;
    // While a row is cut, Escape stays in the list (12): it deletes the row with its
    // countdown, and the container never sees it as Back.
    if (event.key === "Escape" && context.cut) {
      event.preventDefault();
      this.#actor.send({ type: "_escape" });
      return;
    }
    const vim = this.#vim(event);
    // Every Vim letter the list owns is spent here, even with nowhere to move (j on the
    // last row): an uncancelled letter is typed wherever the browser still keeps a
    // selection, and that may be a hidden editor (WebKit).
    if (vim) event.preventDefault();
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key] ?? { down: 1, up: -1 }[vim];
    const current = this.#focusRow(rows, context);
    if (vim === "cut") {
      this.#actor.send({ type: "_cut", id: current });
    } else if (vim === "below" || vim === "above") {
      if (!context.cut) return;
      const id = context.cut;
      if (current === id) this.#actor.send({ type: "_uncut" });
      else this.#actor.send({ type: "_paste", ...this.#neighbours(rows, current, vim === "below") });
      this.#follow(id);
    } else if (vim === "undo") {
      if (current === context.cut) this.#actor.send({ type: "_uncut" });
      else if (context.discarding.has(current)) this.#actor.send({ type: "_undo", id: current });
    } else if (vim === "openBelow" || vim === "openAbove") {
      this.#actor.send({ type: "_place", ...this.#neighbours(rows, current, vim === "openBelow") });
    } else if (step || vim === "first" || vim === "last") {
      const at = rows.findIndex((r) => r.id === current);
      const to = vim === "first" ? 0 : vim === "last" ? rows.length - 1 : at + step;
      const next = rows[Math.min(rows.length - 1, Math.max(0, to))];
      if (!next || next.id === current) return;
      event.preventDefault();
      this.#focusId = next.id;
      this.requestUpdate();
      // The row the keyboard moved to is scrolled into view by whichever box scrolls around
      // the list (its own, a panel's or the dock's), at once, so it is never left out of
      // sight below the fold.
      this.updateComplete.then(() => {
        const el = this.renderRoot.querySelector(`.row[data-id="${next.id}"]`);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest", behavior: "instant" });
      });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.#activate(current);
    }
  }

  // The keyboard stays on a row the list moved, wherever it lands.
  #follow(id) {
    this.#focusId = id;
    this.requestUpdate();
    this.updateComplete.then(() => {
      const el = this.renderRoot.querySelector(`.row[data-id="${id}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  }

  // A click or Enter on a row picks it — or, if it is counting down or cut, is the
  // one-step undo, the whole row being the target so there is nothing small to hit.
  #activate(id) {
    if (!id) return;
    const { discarding, cut } = this.#actor.snapshot.context;
    if (discarding.has(id)) this.#actor.send({ type: "_undo", id });
    else if (cut === id) this.#actor.send({ type: "_uncut" });
    else this.#pick(id);
  }

  #clickRow(id) {
    if (this.#swallowClick) {
      this.#swallowClick = false;
      return;
    }
    this.#activate(id);
  }

  #pick(id) {
    this.#focusId = id;
    // The Highlights row is not a note (Decision 2): it sends its own gesture, so the
    // machine never sees this fixed id as a note pick.
    this.#actor.send(id === HIGHLIGHTS ? { type: "_pickHighlights" } : { type: "_pick", id });
  }

  #discard(event, id) {
    event.stopPropagation();
    this.#actor.send({ type: "_discard", id });
  }

  #pointerdown(event, id) {
    if (event.button != null && event.button !== 0) return;
    if (this.#actor.snapshot.context.discarding.has(id)) return;
    const { width } = event.currentTarget.getBoundingClientRect();
    this.#drag = { id, pointerId: event.pointerId, x0: event.clientX, y0: event.clientY, width, dx: 0, dragging: false, abandoned: false, armed: false };
  }

  #pointermove(event) {
    const d = this.#drag;
    if (!d || d.abandoned || event.pointerId !== d.pointerId) return;
    const dx = event.clientX - d.x0;
    const dy = event.clientY - d.y0;
    if (!d.dragging) {
      if (Math.abs(dy) > Math.abs(dx)) {
        d.abandoned = true; // a vertical drag is a scroll, not a swipe
        return;
      }
      if (dx < -SLOP) {
        d.dragging = true;
        event.currentTarget.setPointerCapture(d.pointerId);
      } else return;
    }
    d.dx = Math.max(-REVEAL * d.width, Math.min(0, dx));
    d.armed = -d.dx >= THRESHOLD * d.width;
    this.requestUpdate();
  }

  #pointerup(event) {
    const d = this.#drag;
    if (!d) return;
    this.#drag = null;
    if (!d.dragging) return; // a tap: let the click pick the row
    try {
      event.currentTarget.releasePointerCapture(d.pointerId);
    } catch {
      // the capture may already be gone (pointercancel); nothing to release
    }
    this.#swallowClick = true;
    if (d.armed && event.type !== "pointercancel") this.#actor.send({ type: "_discard", id: d.id });
    this.requestUpdate(); // dx back to 0; the slide settles with its transition
  }

  // Rows are drawn by position (lit-core has no keyed repeat), so a reorder (an edited
  // note moving to the top) would leave the focus on whatever now fills the focused
  // element: the keyboard follows the roving row, which is keyed by id, instead.
  updated() {
    const active = this.renderRoot.activeElement;
    if (!active?.matches('[data-id][tabindex]')) return;
    const roving = this.renderRoot.querySelector('[data-id][tabindex="0"]');
    if (roving && roving !== active) roving.focus({ preventScroll: true });
  }

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on the roving row,
  // or the first button while there is no row.
  focus(options) {
    const target = this.renderRoot?.querySelector('[tabindex="0"]') ?? this.renderRoot?.querySelector("button");
    if (target) target.focus(options);
    else super.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    // Signed out nothing of the account shows (machine.js: showing).
    const account = showing(snapshot.context);
    if (account === "wait") return nothing;
    if (account === "sign-in") return html`<p class="empty">Sign in to see your notes.</p>`;
    const { open, discarding, highlightsOpen, cut, subject } = snapshot.context;
    const rows = this.#rows(snapshot);
    const focusId = this.#focusRow(rows, snapshot.context);
    const groups = chaptered(snapshot.context);
    const row = (r) => this.#row(r, open, focusId, discarding, highlightsOpen, cut, subject);
    // The failed state is the one time no rows show: notes could not answer, so the
    // next-note row would write into a picture we do not have. Otherwise the list is
    // always at least the next-note row, so there is no empty state.
    return html`
      ${snapshot.matches("failed")
        ? html`<p class="empty">Notes unavailable.</p>`
        : html`
            ${groups ? this.#switch(groups) : nothing}
            <ul class="list" role="listbox" aria-label="Notes" @keydown=${(e) => this.#keydown(e, rows)}>
              ${groups ? this.#grouped(rows, groups, row) : rows.map(row)}
            </ul>
          `}
    `;
  }

  // The chapter switch: two buttons, the pressed one the list as it stands, so its state
  // is seen and Tab reaches it before the rows.
  #switch({ unit, all }) {
    const set = (value) => this.#actor.send({ type: "_chapters", all: value });
    return html`
      <div class="switch" role="group" aria-label="Which notes">
        <button type="button" aria-pressed=${all ? "false" : "true"} @click=${() => set(false)}>This ${unit}</button>
        <button type="button" aria-pressed=${all ? "true" : "false"} @click=${() => set(true)}>All ${unit}s</button>
      </div>
    `;
  }

  // While the subject has an open chapter: the fixed rows, then the notes linked to no
  // chapter, then a line and the rest. Under This chapter the rest is the open chapter's
  // notes, or a text saying it has none, then how many notes the other chapters hold, with
  // Show all; under All chapters it is every chapter's. The line shows only with something on
  // both sides. The line and the texts are not options, so the keyboard moves over the rows alone.
  #grouped(rows, { unit, all, loose, here, rest, more }, row) {
    const day = unit === "day";
    const linked = all ? rest : here;
    const lead = rows.slice(0, rows.length - loose.length - linked.length);
    return html`
      ${rows.slice(0, lead.length + loose.length).map(row)}
      ${loose.length && (linked.length || !all) ? html`<li class="line" role="presentation"></li>` : nothing}
      ${linked.length
        ? rows.slice(lead.length + loose.length).map(row)
        : all
          ? nothing
          : html`<li class="none" role="presentation">No notes ${day ? "on this day" : "in this chapter"} yet.</li>`}
      ${more && !all
        ? html`<li class="more" role="presentation">
            ${more} more ${day ? "on other days" : "in other chapters"} ·
            <button type="button" class="show-all" @click=${() => this.#actor.send({ type: "_chapters", all: true })}>Show all</button>
          </li>`
        : nothing}
    `;
  }

  #row(r, open, focusId, discarding, highlightsOpen, cut, subject) {
    const isDiscarding = discarding.has(r.id);
    const isCut = cut === r.id;
    const d = this.#drag && this.#drag.id === r.id ? this.#drag : null;
    const dx = d ? d.dx : 0;
    const classes = [
      "row",
      r.draft ? "draft" : "",
      r.highlights ? "highlights" : "",
      r.apart ? "apart" : "",
      isDiscarding ? "discarding" : "",
      isCut ? "cut" : "",
      d && d.dragging ? "dragging" : "",
      d && d.armed ? "armed" : "",
    ]
      .filter(Boolean)
      .join(" ");

    // The Highlights row (Decision 5): a note-shaped row — a name with the highlighter
    // mark, a count subtitle, the latest time trailing — but not a note: no bin, no swipe,
    // and it reads as the selected row while it is the picked one (Decision 7).
    if (r.highlights) {
      return html`
        <li
          class=${classes}
          role="option"
          data-id=${r.id}
          aria-selected=${highlightsOpen}
          tabindex=${r.id === focusId ? 0 : -1}
          @click=${() => this.#clickRow(r.id)}
        >
          <span class="slide">
            <span class="text">
              <span class="name"><span class="mark">${icon("highlighter")}</span>Highlights</span>
              <span class="subtitle">${r.count} highlight${r.count === 1 ? "" : "s"}</span>
            </span>
            <span class="trailing"><span class="time">${when(r.updatedAt)}</span></span>
          </span>
        </li>
      `;
    }

    // The next-note row is one centered line, not a note with a blank second line, and
    // it has no delete: it is the blank page to write on, not an existing note. It reads as
    // the open row when the editor is on the blank note, but never while the Highlights row
    // is the picked one (Decision 7): only one row is ever selected.
    if (r.draft) {
      return html`
        <li
          class=${classes}
          role="option"
          data-id=${r.id}
          aria-selected=${r.id === open && !highlightsOpen}
          tabindex=${r.id === focusId ? 0 : -1}
          @click=${() => this.#clickRow(r.id)}
        >
          <span class="slide">
            <span class="text">
              <span class="name draft"><span class="mark">${icon("plus")}</span>New note</span>
            </span>
          </span>
        </li>
      `;
    }

    const untitled = !r.title;
    const trailing = isDiscarding
      ? html`<button class="undo" type="button" aria-label="Undo delete">Undo</button>`
      : isCut
      ? html`<span class="time cut-mark">Cut</span>`
      : html`<span class="time">${when(r.updatedAt)}</span
          ><button class="bin" type="button" tabindex="-1" aria-label="Delete note" @click=${(e) => this.#discard(e, r.id)}>
            ${icon("trash-simple")}
          </button>`;

    // A note with no second line keeps the subtitle line (an em-space placeholder),
    // so every note row is the same height.
    return html`
      <li
        class=${classes}
        role="option"
        data-id=${r.id}
        aria-selected=${r.id === open && !highlightsOpen}
        tabindex=${r.id === focusId ? 0 : -1}
        @click=${() => this.#clickRow(r.id)}
        @pointerdown=${(e) => this.#pointerdown(e, r.id)}
        @pointermove=${(e) => this.#pointermove(e)}
        @pointerup=${(e) => this.#pointerup(e)}
        @pointercancel=${(e) => this.#pointerup(e)}
      >
        <span class="under">Delete</span>
        <span class="slide" style="transform: translateX(${dx}px)">
          <span class="text">
            ${r.apart ? html`<span class="tag">${r.apart}</span>` : nothing}
            <span class="name ${untitled ? "untitled" : ""}">${untitled ? "Untitled" : r.title}</span>
            <span class="subtitle">${r.subtitle || " "}</span>
          </span>
          <span class="trailing">${trailing}</span>
        </span>
        ${isDiscarding ? html`<span class="bar"></span>` : nothing}
      </li>
    `;
  }
}

customElements.define("note-list", NoteList);
