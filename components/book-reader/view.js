import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { icon } from "icons";
import { machine } from "./machine.js";
import progressed from "./events/book.progressed.json" with { type: "json" };

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: { ask: (target, name, payload) => ask(machine, target, name, payload) },
      events: { "book.progressed": progressed },
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

class BookReader extends LitElement {
  // The one attribute the tag understands: height="fill" makes the reader take the
  // height its container leaves (the stage), so the columns paginate instead of the
  // stage scrolling. Mandatory on the page.
  static properties = {
    height: { type: String, reflect: true },
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
      /* A container so the strip can name the page's width as 100cqw (below). */
      container-type: inline-size;
    }
    /* The fragment, built outside Lit's template and appended once (view.js): a single
       tall column box, as wide as the page, whose overflow becomes further columns of
       the same width, so a page is exactly the strip's own width and --page slides it
       by whole pages. No length here is a raw pixel (7.4). */
    .strip {
      height: 100%;
      column-count: 1;
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
    @media (prefers-reduced-motion: reduce) {
      .strip {
        transition: none;
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
    .strip :is(h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, pre, figure, table) {
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
    .strip p {
      font-size: var(--text-body);
      margin-block: var(--space-md);
    }
    .strip a {
      color: var(--color-accent);
    }
    .strip img {
      max-width: 100%;
      max-height: 100%;
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
  // The fragment lives outside Lit's template so a re-render never rebuilds it; it is
  // created once and its children are the blocks, replaced when the chapter changes.
  #strip = document.createElement("div");
  #ro = null;
  // What has been applied, to know in updated() when the chapter or the owed place
  // changed. The page now shown, the pages there are, the anchor, and each block's
  // page — the view's own bookkeeping (Decision 4).
  #lastHtml = null;
  #lastPendingKey = null;
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

  constructor() {
    super();
    this.#strip.className = "strip";
    // A link inside the text to another chapter (the importer rewrote it to a
    // data-chapter, and a fragment to a data-block): jump rather than navigate.
    this.#strip.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-chapter]");
      if (!a) return;
      e.preventDefault();
      this.#actor.send({ type: "_link", chapter: Number(a.dataset.chapter), block: Number(a.dataset.block ?? 0) });
    });
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
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#timer);
    super.disconnectedCallback();
  }

  // Put the chapter's fragment in the strip: parse the strict-XHTML subset (lit-core
  // has no unsafeHTML directive), send external links out safely, and re-measure once
  // each image has loaded, since an unloaded image has no height and moves the blocks.
  #setFragment(htmlText) {
    this.#strip.replaceChildren();
    // A fresh fragment starts at its first page at once: the strip may still be slid,
    // or mid-slide, to the old chapter's page, and a transition from there would show
    // the new text sweeping across several pages before it settles.
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
  // with its children, so its own edge is the origin whatever page is shown.
  #columnOf(rect) {
    const strip = this.#strip;
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    const box = strip.getBoundingClientRect();
    return Math.round((rect.left - box.left) / (box.width + gap));
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

  // Slide the strip to a page. A turn animates, the immediate feedback for the user's
  // gesture (Norman); a landing does not, because a chapter that opens, a jump, or a
  // re-measure that keeps the place has nowhere to slide from. The transition is
  // suspended for the one style flush that applies the page, then restored.
  #place(page, animate) {
    const strip = this.#strip;
    if (!animate) strip.style.transition = "none";
    strip.style.setProperty("--page", page);
    if (!animate) {
      void strip.offsetWidth;
      strip.style.transition = "";
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
    if (this.#page + 1 < this.#pages) {
      this.#endSettle();
      this.#turn(this.#page + 1);
    } else this.#actor.send({ type: "_next" });
  }

  #prev() {
    if (this.#page > 0) {
      this.#endSettle();
      this.#turn(this.#page - 1);
    } else this.#actor.send({ type: "_prev" });
  }

  #keydown(e) {
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
      e.preventDefault();
      this.#next();
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      this.#prev();
    } else if (e.key === "Home") {
      e.preventDefault();
      this.#endSettle();
      this.#turn(0);
    } else if (e.key === "End") {
      e.preventDefault();
      this.#endSettle();
      this.#turn(this.#pages - 1);
    }
  }

  #pointerdown(e) {
    if (e.button != null && e.button !== 0) return;
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
    if (d.dragging || d.abandoned) return; // a drag that is neither a swipe nor a clean tap
    // A click that ends on a selection (a double-click on a word) is about the text.
    if (d.mouse && !(this.shadowRoot.getSelection?.() ?? document.getSelection())?.isCollapsed) return;
    // A tap: the outer third on each side turns; the middle does nothing, so a reach
    // for a link or a figure is never a turn.
    const rel = (e.clientX - e.currentTarget.getBoundingClientRect().left) / d.width;
    if (rel <= EDGE) this.#prev();
    else if (rel >= 1 - EDGE) this.#next();
  }

  // The fragment and the owed place are the actor's; apply them here after each render,
  // when they change. A new chapter rebuilds the strip and opens its pending block; a
  // pending place in the open chapter re-opens it.
  updated() {
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
      }
      return;
    }
    // While a chapter is fetched the actor already names it but still holds the old
    // fragment; the page keeps showing the old chapter, whole, until the new one lands,
    // rather than the old text under the new title.
    if (!snapshot.matches({ reading: "ready" })) return;
    const { html: htmlText, pending, chapter } = snapshot.context;
    const pendingKey = pending ? `${pending.chapter}:${pending.block}` : null;
    if (this.#lastHtml !== htmlText || this.#chapter !== chapter) {
      this.#lastHtml = htmlText;
      this.#chapter = chapter;
      this.#wantBlock = pending && pending.chapter === chapter ? pending.block : 0;
      this.#setFragment(htmlText);
      this.#schedule();
    } else if (pendingKey !== this.#lastPendingKey && pending && pending.chapter === chapter) {
      this.#wantBlock = pending.block;
      this.#schedule();
    }
    this.#lastPendingKey = pendingKey;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    if (snapshot.matches("empty")) return html`<div class="reader"><p class="message">Choose a book from the shelf.</p></div>`;
    if (snapshot.matches({ reading: "offline" }))
      return html`<div class="reader">
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
      <div class="reader" tabindex="0" @keydown=${(e) => this.#keydown(e)}>
        <div
          class="viewport"
          @pointerdown=${(e) => this.#pointerdown(e)}
          @pointermove=${(e) => this.#pointermove(e)}
          @pointerup=${(e) => this.#pointerup(e)}
          @pointercancel=${() => (this.#drag = null)}
        >
          <div class="page"></div>
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
