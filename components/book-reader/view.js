import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, segments, locate, chapterText, pointAt, indexOf, step, charStep, nearest, isMotion, passage } from "./machine.js";
import progressed from "./events/book.progressed.json" with { type: "json" };
import saved from "./events/note.saved.json" with { type: "json" };
import discarded from "./events/note.discarded.json" with { type: "json" };

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo window
// (the note-list idiom); the token is the one clock, shared with the bubble bar's
// animation, so they cannot disagree.
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
    // The undo window comes from --duration-undo, read off the host so a stylesheet or a
    // test can set it; the machine only ever sees the number (importable in Node).
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        mint: ulid,
        undoMs,
        // The attributes are parsed by the time hostConnected runs, so the actor is born
        // knowing whether it paints and makes highlights (Decision 3).
        highlighting: this.host.highlights,
      },
      events: { "book.progressed": progressed, "note.saved": saved, "note.discarded": discarded },
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

// Before a horizontal drag is a swipe rather than a tap, and how far it must travel
// to turn a page: gestures, not lengths that place a box, so plain constants (7.4),
// the note-list swipe idiom (6). A tap in the outer third of the page turns too.
const SLOP = 6;
const SWIPE = 40;
const EDGE = 0.3; // the fraction of the width, each side, that a tap turns from
// The gap the bubble keeps from the mark it sits above (or below, when there is no room
// above): a placement offset computed in JS, not a length that places a box in CSS (7.4).
const BUBBLE_GAP = 6;
// How long "Copied" stands on the Copy button after a copy, before it reads Copy again.
const COPIED_MS = 1200;
// The keyboard highlight's paint (12, "Vim keys"): the name in the document's one highlight
// registry, which a page holding a single reader never shares, and how many characters a
// line motion (0, $, j, k) reads before it gives up on a line that never ends.
const PENDING = "reader-pending";
const LINE_SCAN = 4000;
// One line holds two characters whose boxes share the column and overlap by more than
// half their height; a fraction, not a length (7.4).
const sameLine = (a, b) => a.col === b.col && Math.abs(a.top - b.top) < Math.min(a.height, b.height) / 2;

class BookReader extends LitElement {
  // The one attribute the tag understands: height="fill" makes the reader take the
  // height its container leaves (the stage), so the columns paginate instead of the
  // stage scrolling. Mandatory on the page.
  static properties = {
    height: { type: String, reflect: true },
    // Whether the reader paints highlights and turns a text drag into one (Decision 3).
    // Reflected so the page's bare `highlights` reads as true and the manifest attribute
    // is visible. Off is exactly today's reader.
    highlights: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      /* The reader is its own query container, so its measure narrows on the phone
         (the dock-desk convention); a container cannot restyle itself, the inner
         .strip reads the query. */
      container: reader / inline-size;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    .reader {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      outline: none;
    }
    .reader:focus-visible {
      outline: var(--focus-ring);
      outline-offset: calc(-1 * var(--space-2xs));
    }
    /* One page is shown and everything else clipped. The clip happens at the reading
       measure, not the viewport edge, so the next column never peeks into the side
       margin of a wide desk; the viewport only centres that measure and hides the rest. */
    .viewport {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
      display: flex;
      justify-content: center;
      /* A horizontal finger drag is the reader's own turn gesture, so it is not
         surrendered to the browser as a pan; only a vertical drag scrolls. A press
         never starts a text selection (the note-list .row idiom). */
      touch-action: pan-y;
      user-select: none;
      -webkit-user-select: none;
    }
    /* The clip window, exactly one page wide (the reading measure), padded so the text
       sits in from the edge; its overflow hides the columns to either side. */
    .page {
      position: relative;
      height: 100%;
      width: 100%;
      max-width: calc(var(--space-2xl) * 11);
      padding-inline: var(--space-lg);
      box-sizing: border-box;
      overflow: hidden;
      isolation: isolate;
      /* A size container, so the strip can name the page's width as 100cqw (below) and
         an image its height as 100cqh: a percentage on an image resolves against the
         multicol box, which spans every column, so it must size to the page instead. */
      container-type: size;
    }
    /* The fragment, built outside Lit's template and appended once (view.js): a single
       tall column box, as wide as the page, whose overflow becomes further columns of
       the same width, so a page is exactly the strip's own width and --page slides it
       by whole pages. No length here is a raw pixel (7.4). */
    .strip {
      height: 100%;
      column-count: 1;
      /* iOS Safari does not fragment a box whose only column property is a count of
         one: the chapter stays one tall column, one page. Any column width makes it a
         multicol there; the count still caps it at one column, the full page wide. */
      column-width: var(--space-2xl);
      column-fill: auto;
      column-gap: var(--space-xl);
      /* One page is the clip window's content width, 100cqw, not the strip's own
         100%: WebKit resolves a transform's percentage against the pixel-snapped box,
         so at a fractional width every page slid a fraction short of its column. */
      transform: translateX(calc(-1 * var(--page, 0) * (100cqw + var(--space-xl))));
      /* The strip is a tall multi-column box; kept on its own compositor layer
         between turns, a turn no longer begins by promoting and painting the whole
         box (a stall that outran the slide in phone width). */
      will-change: transform;
      transition: transform var(--duration-slide) var(--ease);
      color: var(--color-body);
      line-height: var(--leading-normal);
    }
    /* Crossing a chapter: the entering strip slides in from the turn's side and the
       leaving one out the other, on the individual translate property so it composes
       with the --page transform the settle still corrects underneath. --dir is +1 for a
       forward turn, -1 for back. */
    @keyframes enter {
      from {
        translate: calc(var(--dir) * (100cqw + var(--space-xl)));
      }
    }
    @keyframes leave {
      to {
        translate: calc(-1 * var(--dir) * (100cqw + var(--space-xl)));
      }
    }
    .strip.entering {
      animation: enter var(--duration-slide) var(--ease);
    }
    /* The entering strip stays in flow, measured as usual; only the leaving one is lifted
       out and laid over the .page (its padding box, so inset-inline sits it back in the
       content box the in-flow strip fills) to slide away without disturbing the layout. */
    .strip.leaving {
      position: absolute;
      inset-block: 0;
      inset-inline: var(--space-lg);
      animation: leave var(--duration-slide) var(--ease) forwards;
    }
    @media (prefers-reduced-motion: reduce) {
      .strip,
      .cursor {
        transition: none;
        animation: none;
      }
    }
    /* A mouse can select the text to copy it; a finger cannot, so a horizontal
       finger drag stays the turn gesture and never starts a selection (the viewport's
       user-select: none, above). The pointer handlers already refuse a mouse swipe. */
    @media (hover: hover) and (pointer: fine) {
      .strip {
        user-select: text;
        -webkit-user-select: text;
      }
    }
    /* The book's own text in the app's type and tokens; the importer dropped its CSS
       (Decision 3). Everything is held to the page so nothing overflows a column. */
    .strip :is(h1, h2, h3, h4, h5, h6, p, ul, ol, dl, blockquote, pre, figure, table) {
      max-width: 100%;
    }
    .strip :is(h1, h2) {
      font-size: var(--text-heading);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .strip :is(h3, h4, h5, h6) {
      font-size: var(--text-subtitle);
      line-height: var(--leading-tight);
      color: var(--color-ink);
    }
    .strip :is(h1, h2, h3, h4, h5, h6) {
      break-after: avoid;
      margin-block: var(--space-lg) var(--space-md);
    }
    /* A narrow page (the phone) steps the headings down a size, so a section title
       does not fill a column that holds five words a line. */
    @container reader (width < 45rem) {
      .page {
        padding-inline: var(--space-md);
      }
      .strip :is(h1, h2) {
        font-size: var(--text-subtitle);
      }
      .strip :is(h3, h4, h5, h6) {
        font-size: var(--text-body);
        font-weight: var(--weight-semibold);
      }
    }
    /* Justified like a printed page; hyphenation (by the document's lang) keeps a
       five-word phone line from stretching its word gaps into rivers. */
    .strip p {
      font-size: var(--text-body);
      margin-block: var(--space-md);
      text-align: justify;
      -webkit-hyphens: auto;
      hyphens: auto;
    }
    .strip a {
      color: var(--color-accent);
    }
    /* A highlight (Decision 4): one colour, rounded ends that repeat on every wrapped
       line (box-decoration-break). It must never move the text — no padding, margin,
       border or inserted glyph — so the painted run measures exactly as the bare text
       did. A commented highlight carries a thin accent line under it, drawn as an inset
       shadow so it too adds no box. The mark is clickable (session 3 opens its bubble). */
    .strip mark {
      background: var(--color-highlight);
      color: inherit;
      border-radius: var(--radius-sm);
      -webkit-box-decoration-break: clone;
      box-decoration-break: clone;
      cursor: pointer;
    }
    /* The highlight in progress (12, "Vim keys"), painted through the CSS Custom Highlight
       API, which never touches the DOM, so the marks and the measure stay as they are: in
       the selection colour, so it reads as not yet made beside a finished highlight. */
    ::highlight(reader-pending) {
      background-color: var(--color-accent-selection);
    }
    /* The Vim cursor: a solid block in the accent pair note-editor's Vim cursor uses, so
       Vim has one cursor across the app. A real box placed on its character's own rect and
       carrying that character in the character's own type, rather than a custom
       highlight: Safari repaints a highlight whose range moved only when something else
       repaints, so a highlight cursor showed late and in the old place. Placed in JS, as
       the bubble is; over the text, so a link's accent letter still reads on it. */
    .cursor {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--cx, 0) var(--cy, 0);
      /* The strip's own slide (above), so a page turn carries the cursor with its text. */
      transform: translateX(calc(-1 * var(--page, 0) * (100cqw + var(--space-xl))));
      transition: transform var(--duration-slide) var(--ease);
      width: var(--cw, 0);
      height: var(--ch, 0);
      line-height: var(--ch, 0);
      z-index: 1;
      text-align: center;
      white-space: pre;
      overflow: hidden;
      background: var(--color-accent);
      color: var(--color-accent-text);
      border-radius: var(--radius-sm);
      pointer-events: none;
    }
    .strip mark.commented {
      box-shadow: inset 0 calc(-1 * var(--border-width)) 0 var(--color-accent);
    }
    /* A highlight counting down to its removal (session 3): dimmed while its bubble
       offers Undo, so the user sees what is going. */
    .strip mark.removing {
      opacity: 0.5;
    }
    /* The highlight bubble (Decision 3): a small overlay above the tapped mark's first
       line, inside the clipped .page. Copy and Remove; during the undo window it reads
       Removed · Undo with the draining bar note-list uses. Placed by --bx/--by set in JS
       (#positionBubble), so no literal length places it; it lifts above the text and a
       press on it never turns the page (#pointerdown stops there). */
    .bubble {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--bx, 0) var(--by, 0);
      z-index: 1;
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-2xs) var(--space-xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
      font-size: var(--text-caption);
      color: var(--color-mute);
      white-space: nowrap;
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
    }
    .bubble .act {
      appearance: none;
      border: 0;
      background: none;
      font: inherit;
      font-size: var(--text-caption);
      cursor: pointer;
      padding: var(--space-2xs) var(--space-xs);
      border-radius: var(--radius-sm);
      color: var(--color-body);
    }
    .bubble .act:hover {
      color: var(--color-ink);
      background: var(--color-surface-hover);
    }
    .bubble .act:focus-visible {
      outline: var(--focus-ring);
    }
    .bubble .act.remove:hover {
      color: var(--color-danger);
    }
    .bubble .act.undo {
      color: var(--color-accent);
    }
    /* The draining bar is the visible echo of the machine's timer; both read
       --duration-undo, so they cannot disagree (the note-list idiom). It stays under
       reduced motion because it is the only sign of how long is left. */
    .bubble .bar {
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
    /* A definition list (the O'Reilly idiom for a set of named things): each term set
       apart, its definition indented beneath it so the pairing reads at a glance. */
    .strip dl {
      font-size: var(--text-body);
      margin-block: var(--space-md);
    }
    .strip dt {
      margin-block-start: var(--space-md);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
      break-after: avoid;
    }
    .strip dd {
      margin-inline-start: var(--space-lg);
      margin-block: 0;
    }
    .strip dd > p:first-child {
      margin-block-start: var(--space-2xs);
    }
    /* An image sizes to the page, never past it: a full-page plate or a cover fills the
       page without spilling onto a second. Its own percentage cannot say so — inside the
       multicol it resolves against the box that spans every column (100% width was two
       pages wide in WebKit, 100% height did not resolve at all) — so it names the page
       through the .page container (100cqw, 100cqh). It keeps clear of the page edge by
       the figure's own block margins and one margin more, so a lone full-page figure fits
       within the one page with room to spare and never tips onto a second (WebKit
       fragments a box that fills the column to the pixel). */
    .strip img {
      max-inline-size: 100cqw;
      max-block-size: calc(100cqh - 3 * var(--space-md));
      object-fit: contain;
      break-inside: avoid;
    }
    /* An image inside running text (a book's emoji, shipped as a PNG) is a glyph: the
       height of the text it sits in, never its file's size. Figures keep theirs. */
    .strip :is(p, pre, li, td, th, blockquote) img {
      height: var(--text-body);
      width: auto;
      vertical-align: text-bottom;
    }
    /* A code line wraps at the column like the prose, so it never leaks into the next
       page (section 12: pages are per device). */
    .strip pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    /* Code is told from prose by its face, and a listing by its own sunken block,
       set smaller so fewer of its lines wrap. The padding stays inside max-width. */
    .strip :is(pre, code) {
      font-family: var(--font-mono);
    }
    .strip pre {
      box-sizing: border-box;
      margin-block: var(--space-md);
      padding: var(--space-sm) var(--space-md);
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
    }
    /* A book may wrap every word of a listing in its own code element, so only code
       in running text is tinted. */
    .strip :not(pre) > code {
      padding-inline: var(--space-2xs);
      font-size: var(--text-sm);
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
    }
    .strip pre img {
      height: var(--text-caption);
    }
    .strip :is(figure, table, pre) {
      break-inside: avoid;
    }
    .strip figure {
      margin: var(--space-md) 0;
    }
    /* A book may caption a figure with a heading (the O'Reilly idiom: an h6 in the
       figure), which is a caption, not a section: it follows its image, so there is
       nothing after it to keep it with. */
    .strip :is(figcaption, figure :is(h1, h2, h3, h4, h5, h6)) {
      margin-block: var(--space-xs) 0;
      font-size: var(--text-caption);
      font-weight: var(--weight-normal);
      line-height: var(--leading-normal);
      color: var(--color-mute);
      break-after: auto;
    }
    .strip table {
      border-collapse: collapse;
    }
    .strip :is(th, td) {
      border: var(--border-width) solid var(--color-border);
      padding: var(--space-xs) var(--space-sm);
      text-align: start;
    }
    /* The footer: chapter title, the page count, and the two turns. Every control is
       always visible, so what can be done is discoverable (Norman). */
    .footer {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--space-md);
      padding: var(--space-xs) var(--space-md);
      border-top: var(--border-width) solid var(--color-border);
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .footer .chap {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .footer .pageno {
      flex: none;
    }
    .footer .turns {
      flex: none;
      display: inline-flex;
      gap: var(--space-2xs);
    }
    .turn {
      display: inline-flex;
      appearance: none;
      border: 0;
      background: none;
      color: var(--color-body-mid);
      cursor: pointer;
      font: inherit;
      padding: var(--space-2xs);
      border-radius: var(--radius-sm);
    }
    .turn svg {
      display: block;
    }
    .turn:hover:not(:disabled) {
      color: var(--color-ink);
    }
    .turn:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .turn:focus-visible {
      outline: var(--focus-ring);
    }
    /* A word said plainly, centred: nothing chosen, or the server out of reach. */
    .message {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-md);
      padding: var(--space-2xl) var(--space-md);
      text-align: center;
      color: var(--color-mute);
      font-size: var(--text-sm);
    }
    .retry {
      appearance: none;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      color: var(--color-body);
      font: inherit;
      font-size: var(--text-sm);
      font-weight: var(--weight-semibold);
      padding: var(--space-xs) var(--space-md);
      cursor: pointer;
    }
    .retry:hover {
      background: var(--color-surface-hover);
    }
    .retry:focus-visible {
      outline: var(--focus-ring);
    }
  `;

  #actor = new ActorController(this);
  // The fragment lives outside Lit's template so a re-render never rebuilds it; its
  // children are the blocks, replaced when the chapter changes. A chapter-crossing turn
  // replaces the whole element instead, sliding the new one in beside the old (#swapStrip).
  #strip = this.#makeStrip();
  // The strip on its way out during a chapter-crossing slide, removed when it lands or the
  // reader disconnects.
  #leaving = null;
  #ro = null;
  // What has been applied, to know in updated() when the chapter or the owed place
  // changed. The page now shown, the pages there are, the anchor, and each block's
  // page — the view's own bookkeeping (Decision 4).
  #lastHtml = null;
  #lastPendingKey = null;
  // What was last painted, so a repaint happens only when the chapter's highlight set
  // changes (a new highlight saved, a comment added, one removed).
  #lastHighlightKey = null;
  // The stale highlights already tried against the chapter now shown (session 7): one
  // re-anchor attempt per highlight per chapter load, so a passage that is not found is
  // not searched for again until the reader loads another chapter. Reset on a rebuild.
  #reanchored = new Set();
  #chapter = 0;
  #page = 0;
  #pages = 1;
  // The place: the block at the top of the page and, when that block runs in from an
  // earlier page, the character at the top of this one. Only the user's own gesture
  // moves it (a turn, a jump, a chapter); a re-measure re-opens the page holding it,
  // so a fold and its unfold come back to the very same page, however many widths the
  // slide passed through. The bus hears only the block (section 12: the shared
  // position is a chapter and a block); the offset is the view's own state (3.1).
  #anchor = { block: 0, offset: 0 };
  #pageOf = [];
  #drag = null;
  // The block a fresh chapter or a jump should land on, and the frame and timer it
  // waits for (the timer is the fallback when a busy tab throttles the frame).
  #wantBlock = 0;
  // While settling on a freshly loaded chapter, re-measures land on the wanted block; a
  // user turn ends that, so a late measure keeps the page they turned to (Decision 4).
  #settling = false;
  #raf = 0;
  #timer = 0;
  // The direction of a turn that crossed the current chapter's edge (+1 forward, -1 back),
  // set as the _next/_prev is sent and consumed by the next fragment change, which slides
  // when it is the neighbour that turn asked for. Zero for every other navigation (an
  // in-chapter turn, a contents jump, a link, another device's move): those do not slide.
  #turning = 0;
  // The highlight whose bubble is open (session 3), the view's own UI state: a click or
  // tap on a mark opens it, a page turn, a chapter change, Escape, or a tap elsewhere
  // closes it. Null when no bubble shows.
  #active = null;
  // Whether the Copy button is flashing "Copied", and the timer that clears it.
  #copied = false;
  #copiedTimer = 0;
  // The reveal nonce last acted on (machine one-shot): a drag inside an existing
  // highlight opens that highlight's bubble, told through context.reveal (Decision 6).
  #lastReveal = 0;

  // The fragment element: a bare div with the click handler for in-text chapter links.
  // Made here so #swapStrip can build a second one for a chapter-crossing slide.
  #makeStrip() {
    const strip = document.createElement("div");
    strip.className = "strip";
    // A link inside the text to another chapter (the importer rewrote it to a
    // data-chapter, and a fragment to a data-block): jump rather than navigate.
    strip.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-chapter]");
      if (!a) return;
      e.preventDefault();
      this.#actor.send({ type: "_link", chapter: Number(a.dataset.chapter), block: Number(a.dataset.block ?? 0) });
    });
    strip.addEventListener("transitionend", (e) => {
      if (e.target === strip && e.propertyName === "transform") this.#slid();
    });
    return strip;
  }

  // A page turn slides the strip and the cursor box as two animations, which an engine
  // may sample a frame apart, so mid-slide the box can sit a few pixels off its letter.
  // While a slide runs the box carries `data-sliding`; when it ends (or, should no end
  // event come, a little after the slide's own duration) the box is placed again from
  // its letter's rect, so the settled page always shows it exactly on its letter.
  #sliding = false;
  #slideTimer = 0;
  #startSlide() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.#sliding = true;
    this.renderRoot?.querySelector(".cursor")?.setAttribute("data-sliding", "");
    clearTimeout(this.#slideTimer);
    const ms = toMs(getComputedStyle(this).getPropertyValue("--duration-slide"), 300);
    this.#slideTimer = setTimeout(() => this.#slid(), ms + 100);
  }

  #slid() {
    if (!this.#sliding) return;
    this.#sliding = false;
    clearTimeout(this.#slideTimer);
    this.renderRoot?.querySelector(".cursor")?.removeAttribute("data-sliding");
    this.#paintCursor();
  }

  connectedCallback() {
    super.connectedCallback();
    this.#ro = new ResizeObserver(() => this.#relayout());
    this.#ro.observe(this);
    // The web font changes the text's measure once it loads, so a chapter measured
    // before it lands would paginate wrongly; re-measure when it is ready.
    document.fonts?.ready.then(() => this.#relayout());
  }

  disconnectedCallback() {
    this.#ro?.disconnect();
    this.#ro = null;
    this.#leaving?.remove();
    this.#leaving = null;
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#timer);
    clearTimeout(this.#copiedTimer);
    clearTimeout(this.#slideTimer);
    this.#focused = false;
    this.#visual = null;
    this.#paintCursor();
    super.disconnectedCallback();
  }

  // A turn that crosses a chapter hands the current strip over as the leaving page and
  // slides a fresh one in beside it, so crossing a chapter gives the same feedback as any
  // turn (Norman). The old strip is already laid out on its own layer, so it is handed
  // over rather than re-laid-out; a jump has nowhere to slide from and does not call this.
  #swapStrip(dir) {
    const clip = this.#strip.parentNode;
    if (!clip) return;
    this.#leaving?.remove();
    const leaving = this.#strip;
    leaving.classList.add("leaving");
    leaving.inert = true;
    leaving.setAttribute("aria-hidden", "true");
    leaving.style.setProperty("--dir", dir);
    leaving.addEventListener("animationend", () => leaving.remove(), { once: true });
    this.#leaving = leaving;
    const entering = this.#makeStrip();
    entering.classList.add("entering");
    entering.style.setProperty("--dir", dir);
    entering.addEventListener(
      "animationend",
      () => {
        entering.classList.remove("entering");
        this.#slid();
      },
      { once: true },
    );
    this.#startSlide();
    // Prepended, so it is the first .strip the tests and updated() find; the leaving one
    // trails until its animation ends.
    clip.prepend(entering);
    this.#strip = entering;
  }

  // Put the chapter's fragment in the strip: parse the strict-XHTML subset (lit-core
  // has no unsafeHTML directive), send external links out safely, and re-measure once
  // each image has loaded, since an unloaded image has no height and moves the blocks.
  #setFragment(htmlText) {
    // The cursor and a highlight in progress were counted in the old fragment's text.
    this.#forgetCursor();
    this.#strip.replaceChildren();
    // A fresh fragment starts at its first page at once, with no transform transition: a
    // jump reuses the strip, which may still be slid or mid-slide to the old page, and a
    // transition from there would show the new text sweeping across before it settles;
    // a chapter-crossing turn enters on a fresh strip whose own slide is the translate.
    this.#page = 0;
    this.#place(0, false);
    if (htmlText) {
      const fragment = document.createRange().createContextualFragment(htmlText);
      for (const a of fragment.querySelectorAll("a[href]:not([data-chapter])")) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      this.#strip.append(fragment);
      for (const img of this.#strip.querySelectorAll("img")) {
        if (!img.complete) img.addEventListener("load", () => this.#relayout(), { once: true });
      }
    }
  }

  // Measure the columns: each block's page, and how many pages there are. Read once
  // per layout; a hidden tab has no box, so a zero width means measure later.
  #measure() {
    const strip = this.#strip;
    // The fractional width, not clientWidth: a rounded pitch is half a pixel off per
    // column, a whole page after a few hundred.
    const box = strip.getBoundingClientRect();
    const width = box.width;
    if (width <= 0) return false;
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    // Each block is measured from the strip's own edge: the slide moves both alike, so
    // the measure holds whatever page is shown, even while a turn is still in motion.
    const x0 = box.left;
    this.#pageOf = [...strip.children].map((el) =>
      Math.max(0, Math.round((el.getBoundingClientRect().left - x0) / (width + gap))),
    );
    this.#pages = Math.max(1, Math.round((strip.scrollWidth + gap) / (width + gap)));
    return true;
  }

  // The block at the top of a page: the first that starts on it, or, when none does
  // (a block that runs the whole page), the one spanning in from before. Re-opening
  // this block finds the same page again, so a re-measure never drifts (Decision 4).
  #topBlock(page) {
    const first = this.#pageOf.findIndex((p) => p >= page);
    if (first < 0) return Math.max(0, this.#pageOf.length - 1);
    return this.#pageOf[first] === page ? first : Math.max(0, first - 1);
  }

  #pageOfBlock(block) {
    if (!this.#pageOf.length) return 0;
    return this.#pageOf[Math.min(block, this.#pageOf.length - 1)];
  }

  // The page a client rect lies on, by the measure's own arithmetic: the strip slides
  // with its children, so its own edge is the origin whatever page is shown. Read at the
  // rect's centre, which lies inside its column whatever the rounding, so a character in
  // a line's right half is not counted on the next page.
  #columnOf(rect) {
    const strip = this.#strip;
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    const box = strip.getBoundingClientRect();
    return Math.floor((rect.left + rect.width / 2 - box.left + gap / 2) / (box.width + gap));
  }

  // The text nodes of a block, with the running offset each one starts at, so a
  // character offset into the block's text names one node and one index in it.
  #textNodes(block) {
    const el = this.#strip.children[block];
    const nodes = [];
    if (!el) return nodes;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let start = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      nodes.push({ node, start });
      start += node.data.length;
    }
    return nodes;
  }

  // Each block's text: the concatenation of its descendant text nodes, one string per
  // block, the basis the machine's places are counted in (12). Built from #textNodes so
  // the offsets a place carries and the texts the machine snaps in share one origin.
  #blockTexts() {
    return [...this.#strip.children].map((_, block) => this.#textNodes(block).map((t) => t.node.data).join(""));
  }

  // A DOM boundary (node, offset) as a place { block, offset } into the block's text, or
  // null when it is not inside the strip. A text-node boundary is exact; an element
  // boundary is measured by the text before it, which a Range concatenates the same way
  // #textNodes does (the character data of the text nodes, nothing added).
  #pointOf(node, offset) {
    let el = node;
    while (el && el.parentNode !== this.#strip) el = el.parentNode;
    if (!el || el.parentNode !== this.#strip) return null;
    const block = [...this.#strip.children].indexOf(el);
    if (block < 0) return null;
    const entry = this.#textNodes(block).find((t) => t.node === node);
    if (entry) return { block, offset: entry.start + offset };
    const range = document.createRange();
    range.setStart(el, 0);
    range.setEnd(node, offset);
    return { block, offset: range.toString().length };
  }

  // The current text selection inside the strip as a DOM range, or null when there is
  // none. getComposedRanges is the standard way to reach across the shadow boundary
  // (WebKit); a scoped ShadowRoot.getSelection is the fallback (Chromium).
  #selectionRange() {
    const doc = document.getSelection();
    if (doc && typeof doc.getComposedRanges === "function") {
      const [range] = doc.getComposedRanges({ shadowRoots: [this.renderRoot] });
      if (range && !(range.startContainer === range.endContainer && range.startOffset === range.endOffset)) return range;
    }
    const scoped = this.renderRoot.getSelection?.();
    if (scoped && !scoped.isCollapsed && scoped.rangeCount) return scoped.getRangeAt(0);
    return null;
  }

  #clearSelection() {
    document.getSelection()?.removeAllRanges?.();
    this.renderRoot.getSelection?.()?.removeAllRanges?.();
  }

  // Turn the drag's selection into a highlight (Decision 3): both ends to places, the
  // earlier one the start, and the message sent with the chapter's block texts. The
  // native selection is cleared, having been the live feedback during the drag. False
  // when there is nothing to highlight, so the caller can fall through to a tap.
  #makeHighlight() {
    const range = this.#selectionRange();
    if (!range) return false;
    const p = this.#pointOf(range.startContainer, range.startOffset);
    const q = this.#pointOf(range.endContainer, range.endOffset);
    this.#clearSelection();
    return this.#sendHighlight(p, q);
  }

  // Two places as the _highlight message, whichever comes first: the tail the mouse and
  // the keyboard share (12). The keyboard's is `exact`: its passage was painted letter
  // by letter as it was made, so it is not grown to whole words as a drag is.
  #sendHighlight(p, q, exact = false) {
    if (!p || !q) return false;
    const [start, end] = p.block > q.block || (p.block === q.block && p.offset > q.offset) ? [q, p] : [p, q];
    if (start.block === end.block && start.offset === end.offset) return false;
    this.#actor.send({ type: "_highlight", start, end, exact, texts: this.#blockTexts() });
    return true;
  }

  // --- The cursor and highlighting from the keyboard (12, "Vim keys"; 14) ------------
//
  // Vim's model: with "Vim keys" on and the reader focused, a one-character cursor is
  // always shown. Motions move it; v starts a highlight at it, the same motions grow it,
  // Enter makes it and Escape drops it, the cursor staying where it is. All of it is the
  // view's own UI state (3.1): the chapter's text as the motions read it (built once per
  // chapter), the cursor as an index into it, and where v was pressed. A cursor that
  // leaves the page turns the page; a page turned another way takes the cursor to its top.
  #text = null;
  #cursor = null;
  #visual = null;
  #focused = false;

  #chapterText() {
    this.#text ??= chapterText(this.#blockTexts());
    return this.#text;
  }

  // A fresh chapter: nothing the cursor or a highlight in progress counted is left.
  #forgetCursor() {
    this.#text = null;
    this.#cursor = null;
    this.#visual = null;
  }

  // A flat index of the chapter as a DOM boundary in the strip, through the same text
  // nodes the places are counted in.
  #domAt(i, chapter) {
    const { block, offset } = pointAt(chapter, i);
    const nodes = this.#textNodes(block);
    for (let k = nodes.length - 1; k >= 0; k -= 1) {
      if (nodes[k].start <= offset) return { node: nodes[k].node, offset: Math.min(offset - nodes[k].start, nodes[k].node.data.length) };
    }
    return null;
  }

  #rangeOf(from, to, chapter) {
    const a = this.#domAt(from, chapter);
    const b = this.#domAt(to, chapter);
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  }

  // The line a character sits on: its page (the measure's own arithmetic, #columnOf), its
  // top and height, and its centre across. Null for a character with no box.
  #lineOf(i, chapter) {
    const rect = [...(this.#rangeOf(i, i + 1, chapter)?.getClientRects() ?? [])].find((r) => r.width > 0 || r.height > 0);
    if (!rect) return null;
    return { col: this.#columnOf(rect), top: rect.top, height: rect.height, x: rect.left + rect.width / 2 };
  }

  // 0 and $ walk the cursor's own line to its ends; j and k walk to the next or previous
  // line and stop at the character nearest the cursor across. Lines are read from the
  // characters' boxes, as #charPage reads pages, so a page's columns and a wrapped
  // paragraph are measured the same way in every engine.
  #lineStep(i, key) {
    const chapter = this.#chapterText();
    const here = this.#lineOf(i, chapter);
    if (!here) return i;
    const dir = key === "$" || key === "j" ? 1 : -1;
    if (key === "0" || key === "$") {
      // A wrapped line's last box is the space it broke at; $ stops on the last letter,
      // as Vim's does.
      let k = i;
      let word = i;
      for (let n = 0; n < LINE_SCAN; n += 1) {
        const next = charStep(chapter, k, dir);
        const at = next === k ? null : this.#lineOf(next, chapter);
        if (!at || !sameLine(at, here)) break;
        k = next;
        if (!/\s/u.test(chapter.flat[k])) word = k;
      }
      return key === "$" ? word : k;
    }
    let k = i;
    let line = null;
    let best = null;
    for (let n = 0; n < LINE_SCAN; n += 1) {
      const next = charStep(chapter, k, dir);
      if (next === k) break;
      k = next;
      const at = this.#lineOf(k, chapter);
      if (!at) continue;
      if (!line) {
        if (sameLine(at, here)) continue;
        line = at;
      } else if (!sameLine(at, line)) break;
      const d = Math.abs(at.x - here.x);
      if (!best || d < best.d) best = { k, d };
    }
    return best ? best.k : i;
  }

  // Whether the cursor shows now: the preference on, a chapter on the page, the reader
  // focused.
  #cursorShown() {
    const snapshot = this.#actor.snapshot;
    return this.#focused && snapshot?.context.vimKeys === true && snapshot.matches("reading") && this.#strip.children.length > 0;
  }

  // The cursor on the page shown: kept while it is there, else the top of the page (the
  // anchor), which is also where it starts on a chapter and at the saved reading place.
  #placeCursor() {
    const chapter = this.#chapterText();
    if (this.#cursor != null) {
      const at = this.#lineOf(this.#cursor, chapter);
      if (!at || Math.max(0, Math.min(this.#pages - 1, at.col)) === this.#page) return;
    }
    this.#cursor = nearest(chapter, indexOf(chapter, this.#anchor));
    // A highlight in progress stays: a page turned by Space or Ctrl+f carries it on.
  }

  #move(key) {
    const chapter = this.#chapterText();
    const letter = key === "l" || key === "h";
    this.#cursor = isMotion(key)
      ? step(chapter, this.#cursor, key)
      : letter
        ? charStep(chapter, this.#cursor, key === "l" ? 1 : -1)
        : this.#lineStep(this.#cursor, key);
    if (this.#visual) this.#visual.letter = letter;
    const at = this.#lineOf(this.#cursor, chapter);
    const page = at ? Math.max(0, Math.min(this.#pages - 1, at.col)) : this.#page;
    if (page !== this.#page) {
      this.#closeBubble();
      this.#endSettle();
      this.#turn(page);
    }
    this.#paintCursor();
  }

  // A click on the text puts the cursor on the character clicked: the collapsed
  // selection the click left is that place, reached across the shadow boundary the way
  // #selectionRange reaches a dragged one.
  #cursorFromClick(x, y) {
    const doc = document.getSelection();
    const scoped = this.renderRoot.getSelection?.();
    const range =
      typeof doc?.getComposedRanges === "function"
        ? doc.getComposedRanges({ shadowRoots: [this.renderRoot] })[0]
        : scoped?.rangeCount
          ? scoped.getRangeAt(0)
          : null;
    const p = range && this.#pointOf(range.startContainer, range.startOffset);
    if (!p) return;
    const chapter = this.#chapterText();
    let at = nearest(chapter, indexOf(chapter, p));
    // A caret falls between two characters, after the clicked one when the click was in
    // its right half (Chromium): the cursor goes on the character under the pointer.
    const before = at > 0 ? this.#rangeOf(at - 1, at, chapter)?.getBoundingClientRect() : null;
    if (before && before.width > 0 && x >= before.left && x <= before.right && y >= before.top && y <= before.bottom) at -= 1;
    this.#cursor = at;
    this.#paintCursor();
  }

  #startVisual() {
    this.#closeBubble();
    this.#visual = { start: this.#cursor };
    this.#paintCursor();
  }

  // Enter makes the highlight (12), sending the same message the mouse does; Escape drops
  // it, saving nothing. Either way the cursor stays where it is.
  #endVisual(make) {
    const v = this.#visual;
    if (!v) return;
    this.#visual = null;
    this.#paintCursor();
    if (!make) return;
    const chapter = this.#chapterText();
    const [from, to] = passage(chapter, v.start, this.#cursor, v.letter);
    this.#sendHighlight(pointAt(chapter, from), pointAt(chapter, to), true);
  }

  // The cursor and the passage in progress, drawn in the same task as the key that moved
  // them (or the turn, resize or click), so what shows is never a step behind.
  #paintCursor() {
    const registry = globalThis.CSS?.highlights;
    if (!this.#cursorShown()) {
      this.#drawCursor(null);
      registry?.delete(PENDING);
      return;
    }
    this.#placeCursor();
    const chapter = this.#chapterText();
    this.#drawCursor(this.#cursor == null ? null : this.#rangeOf(this.#cursor, this.#cursor + 1, chapter), chapter);
    if (!registry) return;
    if (!this.#visual || this.#cursor == null) {
      registry.delete(PENDING);
    } else {
      const [from, to] = passage(chapter, this.#visual.start, this.#cursor, this.#visual.letter);
      const pending = this.#rangeOf(from, to, chapter);
      // A new Highlight every time, never one whose ranges change, and a class flipped
      // on the strip: Safari otherwise leaves the old passage painted until something
      // else repaints the text.
      registry.set(PENDING, pending ? new Highlight(pending) : new Highlight());
    }
    this.#strip.classList.toggle("repaint");
  }

  // The cursor box on its character's rect, read against the strip's own box: the strip
  // slides by whole pages under a transform the cursor shares (#place), so the offset
  // into the strip is all it needs, mid-slide or not. The place it names is for tests.
  #drawCursor(range, chapter) {
    const el = this.renderRoot?.querySelector(".cursor");
    if (!el) return;
    const rect = range && [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0);
    if (!rect) {
      el.hidden = true;
      return;
    }
    const strip = this.#strip;
    const box = strip.getBoundingClientRect();
    const x = strip.offsetLeft + rect.left - box.left;
    const y = strip.offsetTop + rect.top - box.top;
    el.style.setProperty("--cx", `${x}px`);
    el.style.setProperty("--cy", `${y}px`);
    el.style.setProperty("--cw", `${rect.width}px`);
    el.style.setProperty("--ch", `${rect.height}px`);
    // The letter as the page sets it: a heading's size and weight, a capitalised heading.
    const type = getComputedStyle(range.startContainer.parentElement);
    for (const p of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "textTransform", "letterSpacing"]) el.style[p] = type[p];
    el.textContent = range.toString();
    const { block, offset } = pointAt(chapter, this.#cursor);
    el.dataset.block = block;
    el.dataset.offset = offset;
    el.hidden = false;
  }

  // The reader's Vim keys; true when the key was one of them. Letters only while the
  // preference is on, never with Alt or Cmd held, and never inside a field.
  #gAt = 0;
  #vimKey(e) {
    if (this.#actor.snapshot?.context.vimKeys !== true || e.metaKey || e.altKey) return false;
    const target = e.composedPath()[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName)) return false;
    const key = e.key;
    if (e.ctrlKey) {
      // Vim's page keys, a whole page each, and Ctrl+v, Vim's other way into visual mode;
      // their browser defaults (bookmark, view source, paste) mean nothing on a read-only
      // page. Ctrl+h/j/k/l and Ctrl+. belong to the desk, which takes them first.
      if (key === "f" || key === "d") this.#next();
      else if (key === "b" || key === "u") this.#prev();
      else if (key === "v") this.#visualKey();
      else return false;
    } else {
      const second = key === "g" && Date.now() - this.#gAt < 1000;
      this.#gAt = key === "g" && !second ? Date.now() : 0;
      if (this.#cursor == null) this.#placeCursor();
      if (key === "g") {
        if (second) this.#edge(0);
      } else if (key === "G") this.#edge(this.#pages - 1);
      // h and l turn the page, as the owner asked; while a highlight is in progress they
      // move its end by one letter, as in Vim's visual mode, turning the page only when
      // the cursor leaves it, as the other motions do.
      else if (key === "l" && !this.#visual) this.#next();
      else if (key === "h" && !this.#visual) this.#prev();
      else if (isMotion(key) || ["0", "$", "j", "k", "l", "h"].includes(key)) {
        if (this.#cursor == null) return false;
        this.#move(key);
      } else if (key === "v") this.#visualKey();
      else if (key === "Enter" && this.#visual) this.#endVisual(true);
      else if (key === "Escape" && this.#visual) this.#endVisual(false);
      else return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // v (or Ctrl+v) starts a highlight at the cursor, or drops the one in progress.
  #visualKey() {
    if (this.#cursor == null) this.#placeCursor();
    if (this.#visual) this.#endVisual(false);
    else if (this.highlights && this.#actor.snapshot.context.highlighting && this.#cursor != null) this.#startVisual();
  }

  // gg and G: the chapter's first or last page, the cursor at its top.
  #edge(page) {
    this.#closeBubble();
    this.#endSettle();
    this.#cursor = null;
    this.#turn(page);
  }

  // Open the bubble on a highlight (session 3): its own UI state, so a normal mark click
  // needs no message to the machine. The overlap case reaches here through the reveal
  // one-shot (updated). A stale "Copied" is cleared, so the bubble opens reading Copy.
  #openBubble(id) {
    if (!id) return;
    clearTimeout(this.#copiedTimer);
    this.#active = id;
    this.#copied = false;
    this.requestUpdate();
  }

  #closeBubble() {
    if (this.#active == null && !this.#copied) return;
    clearTimeout(this.#copiedTimer);
    this.#active = null;
    this.#copied = false;
    this.requestUpdate();
  }

  // Copy the highlighted text (Decision 3): nothing is ever copied without this, and the
  // write is inside the click handler, where the clipboard permission holds. The label
  // reads "Copied" for a moment; a blocked clipboard leaves it as Copy rather than error.
  async #copyActive(quote) {
    try {
      await navigator.clipboard.writeText(quote?.exact ?? "");
      clearTimeout(this.#copiedTimer);
      this.#copied = true;
      this.requestUpdate();
      this.#copiedTimer = setTimeout(() => {
        this.#copied = false;
        this.requestUpdate();
      }, COPIED_MS);
    } catch {
      // no clipboard permission (an insecure context, a denied prompt): leave it as Copy.
    }
  }

  // Remove and undo (Decision 3): the mouse's gesture is one message, the machine runs
  // the delayed delete; the bubble stays open, reading Removed · Undo while the window
  // drains and Copy · Remove again once undone.
  #removeActive() {
    if (this.#active) this.#actor.send({ type: "_remove", id: this.#active });
  }

  #undoActive() {
    if (this.#active) this.#actor.send({ type: "_undo", id: this.#active });
  }

  // Dim the marks counting down to a removal, so the whole passage shows it is going,
  // not only the bubble (Decision 3). Runs every render, cheap, always in step with the
  // machine's discarding set.
  #reflectDiscarding(snapshot) {
    const discarding = snapshot.context.discarding;
    for (const mark of this.#strip.querySelectorAll("mark")) {
      mark.classList.toggle("removing", discarding.has(mark.dataset.id));
    }
  }

  // Place the open bubble above its mark's first line, inside the clipped .page: centred
  // on that line and clamped within the page, above it or, with no room, below. Positions
  // are set as custom properties (7.4). A mark gone (the chapter changed, the note
  // removed) closes the bubble.
  #positionBubble() {
    const bubble = this.renderRoot.querySelector(".bubble");
    const page = this.renderRoot.querySelector(".page");
    if (!bubble || !page) return;
    const mark = this.#strip.querySelector(`mark[data-id="${this.#active}"]`);
    if (!mark) {
      this.#closeBubble();
      return;
    }
    const line = mark.getClientRects()[0] ?? mark.getBoundingClientRect();
    const box = page.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let x = line.left - box.left + line.width / 2 - bw / 2;
    x = Math.max(0, Math.min(Math.max(0, box.width - bw), x));
    let y = line.top - box.top - bh - BUBBLE_GAP;
    if (y < 0) y = line.bottom - box.top + BUBBLE_GAP;
    y = Math.max(0, Math.min(Math.max(0, box.height - bh), y));
    bubble.style.setProperty("--bx", `${Math.round(x)}px`);
    bubble.style.setProperty("--by", `${Math.round(y)}px`);
  }

  // The chapter's highlights as one key, so updated() repaints only when the set changes.
  #highlightKey(snapshot) {
    const cv = snapshot.context.book?.contentVersion;
    return snapshot.context.highlights
      .filter((h) => h.place.chapter === this.#chapter && h.place.contentVersion === cv)
      .map((h) => `${h.id}:${h.commented ? 1 : 0}:${h.place.start.block}.${h.place.start.offset}-${h.place.end.block}.${h.place.end.offset}`)
      .sort()
      .join("|");
  }

  // Paint the shown chapter's highlights (Decision 4): drop every existing mark first,
  // then wrap each highlight's text, text node by text node from the last to the first,
  // so a wrap never shifts an offset not yet used. Only highlights counted in this
  // book's current content version are painted; a stale one waits for a re-anchor
  // (session 7). Marks live inside blocks, so #measure and #textNodes are unaffected.
  #paint() {
    const strip = this.#strip;
    if (!strip) return;
    for (const mark of [...strip.querySelectorAll("mark")]) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
    const snapshot = this.#actor.snapshot;
    if (!snapshot?.context.highlighting) return;
    const cv = snapshot.context.book?.contentVersion;
    const pieces = [];
    for (const h of snapshot.context.highlights) {
      if (h.place.chapter !== this.#chapter || h.place.contentVersion !== cv) continue;
      const texts = this.#blockTexts();
      for (const seg of segments({ start: h.place.start, end: h.place.end }, texts)) {
        for (const { node, start } of this.#textNodes(seg.block)) {
          const from = Math.max(seg.from, start) - start;
          const to = Math.min(seg.to, start + node.data.length) - start;
          if (from < to) pieces.push({ block: seg.block, order: start + from, node, from, to, id: h.id, commented: h.commented });
        }
      }
    }
    // Last text node first, and within a node the later offset first, so each wrap only
    // splits text no earlier piece still points into.
    pieces.sort((a, b) => b.block - a.block || b.order - a.order);
    for (const piece of pieces) {
      const mark = document.createElement("mark");
      mark.dataset.id = piece.id;
      if (piece.commented) mark.className = "commented";
      const range = document.createRange();
      range.setStart(piece.node, piece.from);
      range.setEnd(piece.node, piece.to);
      range.surroundContents(mark);
    }
  }

  // Try to re-anchor the highlights counted in an older content version (session 7): for
  // each not yet attempted against the chapter now shown, find its passage again from the
  // quote it kept — leniently in its own stored chapter, strictly (a single full-context
  // match) in any other, so a highlight is not moved across chapters by chance. A found
  // passage is handed to the reader as a corrected place; one that is not found is left
  // for another chapter load. Only its own text is read, no measure needed, so this runs
  // as soon as the fragment is in place.
  #reanchor(snapshot) {
    const { highlighting, highlights, book } = snapshot.context;
    if (!highlighting || !book) return;
    const cv = book.contentVersion;
    const stale = highlights.filter((h) => h.place.contentVersion !== cv && !this.#reanchored.has(h.id));
    if (!stale.length) return;
    const texts = this.#blockTexts();
    const items = [];
    for (const h of stale) {
      this.#reanchored.add(h.id);
      const found = locate(texts, { place: h.place, quote: h.quote }, h.place.chapter === this.#chapter);
      if (found) items.push({ id: h.id, place: { chapter: this.#chapter, contentVersion: cv, start: found.start, end: found.end } });
    }
    if (items.length) this.#actor.send({ type: "_reanchor", items });
  }

  // The page holding the character at an offset into a block. A collapsed space has
  // no rect, so the next few characters are tried; a block with no text (a figure)
  // answers with its own page. Pure geometry, the same in WebKit and Chromium.
  #charPage(block, offset, nodes = this.#textNodes(block)) {
    const range = document.createRange();
    for (let i = 0; i < 8; i++) {
      const at = offset + i;
      let k = nodes.length - 1;
      while (k > 0 && nodes[k].start > at) k--;
      if (k < 0) break;
      const { node, start } = nodes[k];
      const local = at - start;
      if (local >= node.data.length) break;
      range.setStart(node, local);
      range.setEnd(node, local + 1);
      const rect = [...range.getClientRects()].find((r) => r.width > 0 || r.height > 0);
      if (rect) return this.#columnOf(rect);
    }
    return this.#pageOfBlock(block);
  }

  // The anchor for a page: its top block and, when that block runs in from before, the
  // first of its characters on this page, found by bisection (columns only grow along
  // the text). A block that starts here anchors at its start, offset 0.
  #anchorOnPage(page) {
    const block = this.#topBlock(page);
    if (this.#pageOfBlock(block) >= page) return { block, offset: 0 };
    const nodes = this.#textNodes(block);
    const length = nodes.reduce((n, t) => n + t.node.data.length, 0);
    let lo = 0;
    let hi = Math.max(0, length - 1);
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#charPage(block, mid, nodes) >= page) hi = mid;
      else lo = mid + 1;
    }
    return { block, offset: lo };
  }

  #pageOfAnchor() {
    const { block, offset } = this.#anchor;
    const page = offset ? this.#charPage(block, offset) : this.#pageOfBlock(block);
    return Math.max(0, Math.min(this.#pages - 1, page));
  }

  // Slide the strip to a page within the chapter. An in-chapter turn animates, the
  // immediate feedback for the user's gesture (Norman); a landing does not, because a
  // chapter that opens, a jump, or a re-measure that keeps the place has no page within
  // the chapter to slide from (a chapter-crossing turn slides the whole strip instead,
  // #swapStrip). The transition is suspended for the one flush that applies the page.
  #place(page, animate) {
    if (animate && this.#strip.style.getPropertyValue("--page") !== String(page)) this.#startSlide();
    // The cursor slides with the text it sits on, the same distance at the same time.
    const moving = [this.#strip, this.renderRoot?.querySelector(".cursor")].filter(Boolean);
    for (const el of moving) {
      if (!animate) el.style.transition = "none";
      el.style.setProperty("--page", page);
    }
    if (!animate) {
      for (const el of moving) {
        void el.offsetWidth;
        el.style.transition = "";
      }
    }
  }

  // Show a page: slide the strip, refresh the footer, and tell the machine where we
  // settled (it throttles that into book.progressed). The place is the anchor, which
  // the caller has set.
  #show(page, animate = true) {
    const clamped = Math.max(0, Math.min(this.#pages - 1, page));
    this.#page = clamped;
    this.#place(clamped, animate);
    this.requestUpdate();
    this.#actor.send({ type: "_settled", chapter: this.#chapter, block: this.#anchor.block });
    this.#paintCursor();
  }

  // A turn: the anchor becomes the top of the page turned to.
  #turn(page) {
    this.#anchor = this.#anchorOnPage(Math.max(0, Math.min(this.#pages - 1, page)));
    this.#show(page);
  }

  // Open a block, after a fresh fragment or a jump: the anchor is its start, and the
  // page shown the one holding it. Going back into a chapter's end (block Infinity)
  // anchors at the top of its last page, so a long last paragraph still opens there.
  #open(block) {
    if (block === Infinity) {
      this.#anchor = this.#anchorOnPage(this.#pages - 1);
      this.#show(this.#pages - 1, false);
      return;
    }
    this.#anchor = { block: Math.max(0, Math.min(this.#pageOf.length - 1, block)), offset: 0 };
    this.#show(this.#pageOfAnchor(), false);
  }

  // Land again on the page holding the anchor, which stays as it is: a run of
  // re-measures (the font, each image, every width of a fold's slide) finds the same
  // page every time instead of creeping from wherever the last one showed.
  #keep() {
    this.#show(this.#pageOfAnchor(), false);
  }

  // A resize (a dock fold, a rotation, the font loading, the composer): re-measure and
  // keep the place, even when its page number changes (Decision 4, section 12).
  #relayout() {
    if (!this.#measure()) return;
    this.#keep();
  }

  // Land on the wanted block once the fresh fragment is laid out. A chapter switch does
  // not resize the host, so the ResizeObserver never fires for it; measure now (often
  // right), then again next frame in case the layout or the web font was not ready yet.
  #schedule() {
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#timer);
    this.#settling = true;
    // Each measure lands on the wanted block until the user turns a page; a first
    // measure taken before the columns had laid out (or before the font arrived) is
    // corrected by a later one, without yanking a turn made in between back to the start.
    const land = () => {
      if (!this.#measure()) return;
      if (this.#settling) this.#open(this.#wantBlock);
      else this.#keep();
    };
    land();
    // A frame lets the columns lay out; a timer is the fallback for when a busy tab
    // throttles the frame, so the measure never waits on the frame alone.
    this.#raf = requestAnimationFrame(() => requestAnimationFrame(land));
    this.#timer = setTimeout(land, 120);
  }

  // A turn is a user gesture: it ends settling on the loaded chapter and cancels any
  // pending re-measure, so a frame still owed from the chapter load cannot yank the
  // page they just turned to back to where it opened.
  #endSettle() {
    this.#settling = false;
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#timer);
  }

  // A turn that stays in the chapter shows the neighbouring page; a turn past the edge
  // loads a neighbour chapter, which schedules its own settling afresh.
  #next() {
    this.#closeBubble();
    if (this.#page + 1 < this.#pages) {
      this.#endSettle();
      this.#turn(this.#page + 1);
    } else {
      this.#turning = 1;
      this.#actor.send({ type: "_next" });
    }
  }

  #prev() {
    this.#closeBubble();
    if (this.#page > 0) {
      this.#endSettle();
      this.#turn(this.#page - 1);
    } else {
      this.#turning = -1;
      this.#actor.send({ type: "_prev" });
    }
  }

  #keydown(e) {
    if (this.#vimKey(e)) return;
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
      e.preventDefault();
      this.#next();
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      this.#prev();
    } else if (e.key === "Home") {
      e.preventDefault();
      this.#closeBubble();
      this.#endSettle();
      this.#turn(0);
    } else if (e.key === "End") {
      e.preventDefault();
      this.#closeBubble();
      this.#endSettle();
      this.#turn(this.#pages - 1);
    } else if (e.key === "Escape" && this.#active != null) {
      // Escape closes an open bubble (Norman: every action reversible in one step). The
      // reader's only letters are the Vim ones, and only while Vim keys is on (12).
      e.preventDefault();
      e.stopPropagation();
      this.#closeBubble();
    }
  }

  // The cursor shows only while the reader has the keyboard, and comes back where it was.
  #focusChanged(focused) {
    this.#focused = focused;
    this.#paintCursor();
  }

  #pointerdown(e) {
    if (e.button != null && e.button !== 0) return;
    this.#endVisual(false);
    this.#drag = {
      pointerId: e.pointerId,
      mouse: e.pointerType === "mouse",
      x0: e.clientX,
      y0: e.clientY,
      width: e.currentTarget.getBoundingClientRect().width,
      dragging: false,
      abandoned: false,
    };
  }

  #pointermove(e) {
    const d = this.#drag;
    if (!d || d.abandoned || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.dragging) {
      if (Math.abs(dy) > Math.abs(dx)) {
        d.abandoned = true; // a vertical drag is a scroll, not a page turn
        return;
      }
      if (Math.abs(dx) > SLOP) {
        // A mouse drag across the text is a selection, never a swipe; only a finger
        // or a pen swipes. The mouse still turns from the edges and the footer.
        if (d.mouse) d.abandoned = true;
        else d.dragging = true;
      }
    }
  }

  #pointerup(e) {
    const d = this.#drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.#drag = null;
    const dx = e.clientX - d.x0;
    if (d.dragging && Math.abs(dx) >= SWIPE) {
      if (dx < 0) this.#next();
      else this.#prev();
      return;
    }
    // A mouse selection over the text is a highlight, not a swipe or a tap (Decision 3):
    // it is what the abandoned mouse drag left behind, and the native selection was the
    // live feedback. Nothing is copied; the drag never turns the page.
    if (this.highlights && d.mouse && this.#makeHighlight()) return;
    if (d.dragging || d.abandoned) return; // a drag that is neither a swipe nor a clean tap
    // A click that ends on a selection (a double-click on a word) is about the text.
    if (d.mouse && !(this.renderRoot.getSelection?.() ?? document.getSelection())?.isCollapsed) return;
    // A tap or click on a highlight is about that highlight: it opens its bubble (Copy,
    // Remove), never a page turn (session 3).
    const mark = e.target.closest("mark");
    if (mark) {
      this.#openBubble(mark.dataset.id);
      return;
    }
    // A tap anywhere else closes an open bubble (Norman: forgiveness); a turn below
    // closes it too, so a tap in the outer third both closes and turns.
    this.#closeBubble();
    // A tap: the outer third on each side turns; the middle does nothing, so a reach
    // for a link or a figure is never a turn.
    const rel = (e.clientX - e.currentTarget.getBoundingClientRect().left) / d.width;
    if (rel <= EDGE) this.#prev();
    else if (rel >= 1 - EDGE) this.#next();
    else if (d.mouse) this.#cursorFromClick(e.clientX, e.clientY);
  }

  // The fragment and the owed place are the actor's; apply them here after each render,
  // when they change. A new chapter rebuilds the strip and opens its pending block; a
  // pending place in the open chapter re-opens it.
  updated() {
    this.#keepFocus();
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return;
    const reading = snapshot.matches("reading");
    const clip = this.renderRoot.querySelector(".page");
    if (clip && this.#strip.parentNode !== clip) clip.append(this.#strip);
    if (!reading) {
      // Nothing to read: drop the fragment so a return starts clean.
      if (this.#lastHtml !== null) {
        this.#setFragment("");
        this.#lastHtml = null;
        this.#lastHighlightKey = null;
      }
      return;
    }
    // While a chapter is fetched the actor already names it but still holds the old
    // fragment; the page keeps showing the old chapter, whole, until the new one lands,
    // rather than the old text under the new title.
    if (!snapshot.matches({ reading: "ready" })) return;
    const { html: htmlText, pending, chapter } = snapshot.context;
    const pendingKey = pending ? `${pending.chapter}:${pending.block}` : null;
    // A rebuilt fragment starts with no marks, so it must be repainted whatever the key.
    let rebuilt = false;
    if (this.#lastHtml !== htmlText || this.#chapter !== chapter) {
      // A turn that crossed into the very neighbour it asked for slides; every other
      // chapter change (a jump, a link, another device's move) does not. Consume the
      // direction whichever way it goes, so a no-op or offline turn cannot leave it set.
      const dir = this.#turning;
      this.#turning = 0;
      const slide =
        dir !== 0 && chapter === this.#chapter + dir && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.#lastHtml = htmlText;
      // A fresh chapter (a turn, a jump, a re-import) rebuilds the marks, so any open
      // bubble's mark is gone: close it (session 3).
      this.#closeBubble();
      if (slide) this.#swapStrip(dir);
      this.#chapter = chapter;
      // A fresh chapter is a fresh re-anchor pass: the stale highlights get one attempt
      // against this chapter's text (session 7).
      this.#reanchored = new Set();
      this.#wantBlock = pending && pending.chapter === chapter ? pending.block : 0;
      this.#setFragment(htmlText);
      this.#schedule();
      rebuilt = true;
    } else if (pendingKey !== this.#lastPendingKey && pending && pending.chapter === chapter) {
      this.#wantBlock = pending.block;
      this.#schedule();
    }
    this.#lastPendingKey = pendingKey;
    // Paint after the fragment and place are applied: a fresh fragment lost its marks, and
    // a saved, changed or removed highlight changes the key. Marks are inline, so painting
    // after the measure never shifts a column (Decision 4).
    const highlightKey = this.#highlightKey(snapshot);
    if (rebuilt || highlightKey !== this.#lastHighlightKey) {
      this.#paint();
      this.#lastHighlightKey = highlightKey;
    }
    // Re-anchor stale highlights against the chapter now laid out (session 7): find each
    // passage again from its quote and, when found, hand the reader the corrected place. It
    // adopts the place (repainting on the next render) and re-saves the note.
    this.#reanchor(snapshot);
    // A repaint of the marks moves the text nodes the cursor's ranges point into.
    this.#paintCursor();
    // A drag inside an existing highlight opens that highlight's bubble (Decision 6),
    // told through the reveal one-shot; acted on once per nonce so a later render never
    // re-opens it.
    const reveal = snapshot.context.reveal;
    if (reveal && reveal.n !== this.#lastReveal) {
      this.#lastReveal = reveal.n;
      this.#openBubble(reveal.id);
    }
    // The removal countdown dims its marks; the open bubble is placed after the marks
    // are painted. A highlight the fact has removed (its window elapsed) closes the bubble.
    this.#reflectDiscarding(snapshot);
    if (this.#active != null) {
      if (snapshot.context.highlights.some((h) => h.id === this.#active)) this.#positionBubble();
      else this.#closeBubble();
    }
  }

  // The bubble for the open highlight (session 3): Copy and Remove, or, while the removal
  // window drains, Removed · Undo with the bar. Rendered inside .page so it is placed
  // against the same box #positionBubble measures; a press on it never turns the page.
  #bubble(snapshot) {
    if (this.#active == null) return nothing;
    const h = snapshot.context.highlights.find((x) => x.id === this.#active);
    if (!h) return nothing;
    const removing = snapshot.context.discarding.has(this.#active);
    return html`
      <div class="bubble" role="group" aria-label="Highlight" @pointerdown=${(e) => e.stopPropagation()}>
        ${removing
          ? html`
              <span class="removed">Removed ·</span>
              <button class="act undo" type="button" @click=${() => this.#undoActive()}>Undo</button>
              <span class="bar"></span>
            `
          : html`
              <button class="act" type="button" @click=${() => this.#copyActive(h.quote)}>
                ${this.#copied ? "Copied" : "Copy"}
              </button>
              <button class="act remove" type="button" @click=${() => this.#removeActive()}>Remove</button>
            `}
      </div>
    `;
  }

  // dock-desk's Ctrl+h/j/k/l (12) focuses a panel by its host: land on the page, where
  // the reader's own keys are read. Asked before the first page is drawn (the desk
  // starts the keyboard on the stage at load), it lands as soon as there is one.
  focus(options) {
    const target = this.renderRoot?.querySelector(".reader");
    if (target) target.focus(options);
    else this.#owedFocus = true;
  }

  #owedFocus = false;
  #hadFocus = false;

  // A change of state (loading, empty, reading) draws a new page element, which would
  // drop the keyboard on the bare page; read before the render so it can be put back.
  willUpdate() {
    this.#hadFocus = Boolean(this.renderRoot?.activeElement);
  }

  #keepFocus() {
    if (!(this.#owedFocus || this.#hadFocus) || this.renderRoot.activeElement) return;
    const target = this.renderRoot.querySelector(".reader");
    if (!target) return;
    this.#owedFocus = false;
    target.focus({ preventScroll: true });
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    if (snapshot.matches("empty")) return html`<div class="reader" tabindex="-1"><p class="message">Choose a book from the shelf.</p></div>`;
    if (snapshot.matches({ reading: "offline" }))
      return html`<div class="reader" tabindex="-1">
        <p class="message">
          The server is unavailable.
          <button class="retry" type="button" @click=${() => this.#actor.send({ type: "_retry" })}>Retry</button>
        </p>
      </div>`;

    const { book } = snapshot.context;
    const title = book?.chapters[this.#chapter]?.title ?? "";
    const count = book?.chapters.length ?? 1;
    const atFirst = this.#page === 0 && this.#chapter === 0;
    const atLast = this.#page === this.#pages - 1 && this.#chapter === count - 1;
    return html`
      <div
        class="reader"
        tabindex="0"
        @keydown=${(e) => this.#keydown(e)}
        @focus=${() => this.#focusChanged(true)}
        @blur=${() => this.#focusChanged(false)}
      >
        <div
          class="viewport"
          @pointerdown=${(e) => this.#pointerdown(e)}
          @pointermove=${(e) => this.#pointermove(e)}
          @pointerup=${(e) => this.#pointerup(e)}
          @pointercancel=${() => (this.#drag = null)}
        >
          <div class="page"><span class="cursor" aria-hidden="true" hidden></span>${this.#bubble(snapshot)}</div>
        </div>
        <div class="footer">
          <span class="chap">${title}</span>
          <span class="pageno">Page ${this.#page + 1} of ${this.#pages}</span>
          <span class="turns">
            <button class="turn" type="button" aria-label="Previous page" ?disabled=${atFirst} @click=${() => this.#prev()}>
              ${icon("caret-left")}
            </button>
            <button class="turn" type="button" aria-label="Next page" ?disabled=${atLast} @click=${() => this.#next()}>
              ${icon("caret-right")}
            </button>
          </span>
        </div>
      </div>
    `;
  }
}

customElements.define("book-reader", BookReader);
