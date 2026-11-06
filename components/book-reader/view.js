import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, segments, locate, chapterText, pointAt, indexOf, step, charStep, nearest, isMotion, passage, highlightAt, sourceLink, textObject, passageText, addToNote, slipBoxShown, canRead, wordAt, wordAround, fingerPassage, movedEnd, linesOf, charNear, lineBoxes } from "./machine.js";
import progressed from "./events/book.progressed.json" with { type: "json" };
import saved from "./events/note.saved.json" with { type: "json" };
import discarded from "./events/note.discarded.json" with { type: "json" };
import linkCopied from "./events/link.copied.json" with { type: "json" };
import textCopied from "./events/text.copied.json" with { type: "json" };
import closed from "./events/book.closed.json" with { type: "json" };
import passageAdded from "./events/passage.added.json" with { type: "json" };

// A CSS duration token ("3s", "300ms") as milliseconds, for the timers the view keeps.
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
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        mint: ulid,
        // The attributes are parsed by the time hostConnected runs, so the actor is born
        // knowing whether it paints and makes highlights (Decision 3).
        highlighting: this.host.highlights,
      },
      events: { "book.progressed": progressed, "note.saved": saved, "note.discarded": discarded, "link.copied": linkCopied, "text.copied": textCopied, "book.closed": closed, "passage.added": passageAdded },
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
// How long a finger rests before it starts a passage, and how far it may wander meanwhile.
// iOS's own long press takes about half a second and allows ten points of wander: a
// resting finger is never steadier than that, and the reader acts just before iOS would.
const HOLD_MS = 400;
const HOLD_SLOP = 10;
// How long after a press ends its click is not about the text. A touch in the text whose
// touchstart was refused sends no click; a pen's press, or a touch the browser would not let
// be refused, may send one as it lifts, or up to a third of a second later.
const CLICK_AFTER_MS = 700;
// The gap the bubble keeps from the mark it sits above (or below, when there is no room
// above): a placement offset computed in JS, not a length that places a box in CSS (7.4).
const BUBBLE_GAP = 6;
// What the bubble keeps clear beyond that for a handle's ball, which stands out from its line
// by half its own size (.handle::after): also a placement offset (7.4).
const BALL_CLEAR = 6;
// The picture viewer's zoom, from the picture fitted to the box up to four times that,
// and how close in time two taps make a double tap: factors and a time, not lengths (7.4).
const ZOOM_MAX = 4;
const DOUBLE_TAP_MS = 300;
// How long "Copied" stands on the Copy button after a copy, before it reads Copy again,
// and over the footer after text copied with Vim keys.
const COPIED_MS = 1200;
// The keyboard highlight's paint (12, "Vim keys"): the name in the document's one highlight
// registry, which a page holding a single reader never shares, and how many characters a
// line motion (0, $, j, k) reads before it gives up on a line that never ends.
const PENDING = "reader-pending";
const LINE_SCAN = 4000;
// One line holds two characters whose boxes share the column and overlap by more than
// half their height; a fraction, not a length (7.4).
// Reading aloud: the names of the spoken word's paint in the highlight registry, and a
// moment of silence the one audio element plays at the press that starts reading, so a
// browser that lets audio play only after a press lets the clips that follow play too.
const SPOKEN = "reader-spoken";
const SILENCE = (() => {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const ascii = (at, text) => [...text].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 38, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, 2, true);
  bytes[44] = 128;
  bytes[45] = 128;
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
})();
// What reading aloud is doing, from the actor's state: idle, reading (also while the next
// clip is fetched) or paused (also when Pause came before the clip did).
const speechMode = (snapshot) => {
  if (!snapshot?.matches({ reading: "ready" })) return "idle";
  const speech = snapshot.context.speech;
  if (snapshot.matches({ reading: { ready: { speech: "idle" } } }) || !speech) return "idle";
  if (snapshot.matches({ reading: { ready: { speech: { speaking: "paused" } } } })) return "paused";
  if (snapshot.matches({ reading: { ready: { speech: "loading" } } }) && speech.held) return "paused";
  return "reading";
};
// A block's text as a voice gets it. A footnote reference is never said, and the import
// marked each from the book's own markup; it becomes spaces, not nothing, so the character
// offsets the voice answers still fall on the page's own text (#blockRange).
const spokenText = (el) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    text += node.parentElement.closest("a[data-noteref]") ? " ".repeat(node.data.length) : node.data;
  }
  return text;
};
// A block a voice can read: one with words in it, not a picture, a table or a listing.
const speakable = (el) => Boolean(el) && !el.matches("figure, table, pre, hr, img") && spokenText(el).trim() !== "";
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
      position: relative;
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      outline: none;
    }
    .reader:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
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
      /* Every finger move belongs to the reader: a swipe turns, a press and hold grows a
         passage, and a paginated page has nothing to pan. iOS reads this as the touch
         begins, before a hold can be told from a drag, so pan-y here would let it take the
         drag after a hold for a pan and cancel the pointer. A press never starts a text
         selection (the note-list .row idiom), nor a callout over a word, link or picture. */
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
    }
    /* The clip window, exactly one page wide (the reading measure), padded so the text
       sits in from the edge; its overflow hides the columns to either side. */
    .page {
      position: relative;
      height: 100%;
      width: 100%;
      max-width: calc(var(--space-2xl) * 11);
      /* The side margin, which the reading-aloud speaker sits in (.say). */
      --gutter: var(--space-lg);
      padding-inline: var(--gutter);
      box-sizing: border-box;
      overflow: hidden;
      /* Named again because a scroll container may end the chain touch-action is read in. */
      touch-action: none;
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
      .cursor,
      .say {
        transition: none;
        animation: none;
      }
    }
    /* The text selects for a mouse drag, which becomes a highlight at pointerup. The
       viewport keeps user-select: none (above), so the margins and the footer never select.
       A touch screen does not select at all: in this tall multi-column box the browser's
       selection jumped to everything above its start as the finger crossed a gap, so a
       finger's passage is the reader's own (#held), and on iOS a long press on a link or
       a picture would lift it to be dragged and end the touch. Only while a keyboard's
       passage or a word read aloud shows does it stay selectable, since WebKit paints no
       ::highlight on text that cannot be selected and spills it on the next text that can. */
    .strip {
      user-select: text;
      -webkit-user-select: text;
    }
    @media (hover: none) and (pointer: coarse) {
      .strip:not(.painted) {
        user-select: none;
        -webkit-user-select: none;
      }
      .strip :is(a, img) {
        -webkit-user-drag: none;
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
        --gutter: var(--space-md);
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
    /* The highlight whose end is being dragged: the drag's own boxes (.passage) show it, so
       the end it leaves does not stay painted. */
    .strip mark.moving {
      background: none;
      box-shadow: none;
    }
    /* A highlight's handle (12): a bar on the line's own height with a ball at its far end,
       inside a box big enough for a finger. The box is laid over the text and adds nothing
       to it. It sits above the text and under the bubble (same z-index, earlier in .page). A
       drag on it is the reader's, so the browser never reads it as a scroll or a selection. */
    .handle {
      position: absolute;
      top: 0;
      left: 0;
      width: calc(var(--space-xl) + var(--space-xs));
      height: calc(var(--hh, var(--space-lg)) + var(--space-lg));
      translate: var(--hx, 0) var(--hy, 0);
      z-index: 1;
      touch-action: none;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
    }
    .handle[hidden] {
      display: none;
    }
    .handle::before,
    .handle::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      margin-inline: auto;
      background: var(--color-accent);
    }
    .handle::before {
      width: var(--space-2xs);
      height: var(--hh, var(--space-lg));
    }
    .handle::after {
      width: calc(var(--space-sm) + var(--space-xs));
      height: calc(var(--space-sm) + var(--space-xs));
      border-radius: var(--radius-full);
    }
    .handle.start::before {
      bottom: 0;
    }
    .handle.start::after {
      bottom: var(--hh, var(--space-lg));
      translate: 0 50%;
    }
    .handle.end::before {
      top: 0;
    }
    .handle.end::after {
      top: var(--hh, var(--space-lg));
      translate: 0 -50%;
    }
    /* The highlight in progress (12, "Vim keys"), painted through the CSS Custom Highlight
       API, which never touches the DOM, so the marks and the measure stay as they are: in
       the selection colour, so it reads as not yet made beside a finished highlight. */
    ::highlight(reader-pending) {
      background-color: var(--color-accent-selection);
    }
    /* A finger's passage (#paintFinger), in the same colour: boxes over its lines, because
       a touch screen's text cannot be selected and so takes no ::highlight (.strip below).
       Laid over the text, so it also shows on a word already highlighted. */
    .passage {
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
    }
    .passage i {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--px, 0) var(--py, 0);
      width: var(--pw, 0);
      height: var(--ph, 0);
      background: var(--color-accent-selection);
      border-radius: var(--radius-sm);
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
    /* Reading aloud (3.1): the word being said, in the selection tone, through the Custom
       Highlight API so the text never moves, and the paragraph being read tinted as a box
       with a soft edge, a shadow and a background that add nothing to its size. */
    ::highlight(reader-spoken) {
      background-color: var(--color-accent-selection);
    }
    .strip > .speaking {
      background: var(--color-accent-subtle);
      box-shadow: 0 0 0 var(--space-xs) var(--color-accent-subtle);
      border-radius: var(--radius-sm);
    }
    /* The speaker in the page's left margin, beside the paragraph under the mouse, and the
       Stop in its place beside the paragraph being read. Placed in JS on the paragraph's
       first line on this page, and slid with the strip, as the cursor is; inside the
       page's padding, so the text never moves. A finger has no hover: the footer's Read
       page is the way in on a phone. */
    .say {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--sx, 0) calc(var(--sy, 0) + var(--space-2xs));
      transform: translateX(calc(-1 * var(--page, 0) * (100cqw + var(--space-xl))));
      transition: transform var(--duration-slide) var(--ease);
      z-index: 1;
      width: var(--gutter);
      height: var(--space-lg);
      display: grid;
      place-items: center;
      appearance: none;
      border: 0;
      background: none;
      padding: 0;
      cursor: pointer;
      color: var(--color-body-mid);
      font-size: var(--text-body);
      border-radius: var(--radius-sm);
    }
    .say:hover,
    .say.stop {
      color: var(--color-accent);
    }
    .say:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .say svg {
      display: block;
    }
    .say[hidden] {
      display: none;
    }
    @media (hover: none) {
      .say {
        display: none;
      }
    }
    .strip mark.commented {
      box-shadow: inset 0 calc(-1 * var(--border-width)) 0 var(--color-accent);
    }
    /* The highlight a followed source link points at glows for about a second, so the eye
       finds the passage on the page: the accent selection tone and a soft accent ring,
       fading back to the plain highlight. A shadow, not a border, so the text never moves. */
    .strip mark.glow {
      animation: reader-glow calc(3 * var(--duration-slide)) var(--ease);
    }
    @keyframes reader-glow {
      from,
      60% {
        background: var(--color-accent-selection);
        box-shadow: 0 0 0 var(--space-2xs) var(--color-accent-selection);
      }
    }
    /* The highlight bubble (Decision 3): a small overlay above the tapped mark's first
       line, inside the clipped .page. Copy, Copy link, Add to note and Remove. Placed by --bx/--by set in JS
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
      box-sizing: border-box;
      max-width: 100%;
      flex-wrap: wrap;
    }
    /* While a handle moves, placing the bubble again would make it jump. It stays focusable
       and in place, so a comment box keeps its keyboard. */
    .bubble.moving {
      opacity: 0;
      pointer-events: none;
    }
    .bubble textarea {
      flex: 1 0 100%;
      box-sizing: border-box;
      min-height: calc(var(--text-sm) * var(--leading-normal) * 3);
      padding: var(--space-xs);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-sm);
      background: var(--color-canvas);
      color: var(--color-ink);
      font: inherit;
      font-size: var(--text-sm);
      white-space: pre-wrap;
      resize: vertical;
      user-select: text;
      -webkit-user-select: text;
    }
    .bubble textarea:focus {
      outline: none;
      box-shadow: var(--focus-ring);
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
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .bubble .act.remove:hover {
      color: var(--color-danger);
    }
    /* aria-disabled rather than disabled, so the button still takes the pointer and its
       title says what to do first. */
    .bubble .act[aria-disabled="true"] {
      cursor: default;
      color: var(--color-mute);
      background: none;
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
    /* A picture opens in the viewer (below) on a tap, so it says it can be pressed. */
    .strip img {
      cursor: pointer;
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
    .strip :is(p, pre, li, td, th, blockquote, a) img {
      cursor: inherit;
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
    /* The command line (Vim keys): drawn over the footer, as Vim draws it over its
       status line, so the page keeps its height and nothing is paginated again. */
    .footer {
      position: relative;
    }
    .command {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      padding: 0 var(--space-md);
      background: var(--color-canvas);
      color: var(--color-ink);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
      white-space: pre;
      overflow: hidden;
    }
    .command.refused {
      color: var(--color-danger);
    }
    .command .caret {
      width: calc(var(--text-sm) * 0.6);
      height: calc(var(--text-sm) * var(--leading-tight));
      background: var(--color-ink);
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
    /* Read page, and while anything is read Pause or Resume and Stop, before the page
       number. */
    .footer .speakctl {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: var(--space-sm);
    }
    .speak {
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      appearance: none;
      border: 0;
      background: none;
      padding: 0 var(--space-2xs);
      cursor: pointer;
      font: inherit;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
      border-radius: var(--radius-sm);
    }
    .speak:hover {
      color: var(--color-ink);
    }
    .speak:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .speak svg {
      display: block;
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
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The picture viewer: one picture alone over the reader's own box, so the stage's
       tabs, the docks and the bars stay where they are. A size container, so the picture
       fits the box through 100cqw and 100cqh, swapped while it lies on its side, which is
       how a sideways picture gets the box's long side. --turn counts quarter turns and
       only grows, so every turn goes on clockwise; --zoom, --x and --y are set in JS
       (#paintFigure). The touch gestures are its own, so the browser zooms nothing. */
    .figure {
      position: absolute;
      inset: 0;
      z-index: 1;
      overflow: hidden;
      container-type: size;
      background: var(--color-canvas);
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
    }
    /* Centred by its own centre, so a picture on its side, whose box is wider than the
       viewer until it turns, stays in the middle: the turn and the zoom are about that
       centre and the pan moves it from there. */
    .figure img {
      position: absolute;
      inset-block-start: 50%;
      inset-inline-start: 50%;
      inline-size: 100cqw;
      block-size: 100cqh;
      object-fit: contain;
      rotate: calc(var(--turn, 0) * 90deg);
      scale: var(--zoom, 1);
      translate: calc(var(--x, 0px) - 50%) calc(var(--y, 0px) - 50%);
      transition:
        rotate var(--duration-slide) var(--ease),
        scale var(--duration-slide) var(--ease);
      cursor: zoom-in;
      -webkit-user-drag: none;
    }
    .figure[data-odd] img {
      inline-size: 100cqh;
      block-size: 100cqw;
    }
    .figure[data-zoomed] img {
      cursor: grab;
    }
    /* A finger or a wheel moves the picture with it, never behind it. */
    .figure[data-moving] img {
      transition: none;
    }
    .figure .bar {
      position: absolute;
      inset-block-start: var(--space-sm);
      inset-inline-end: var(--space-sm);
      display: inline-flex;
      gap: var(--space-2xs);
      padding: var(--space-2xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
    }
    @media (prefers-reduced-motion: reduce) {
      .figure img {
        transition: none;
      }
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
      outline: none;
      box-shadow: var(--focus-ring);
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
  // Which button is flashing "Copied" ("text" for Copy, "link" for Copy link, "passage"
  // for text copied with Vim keys outside a bubble, shown over the footer, "note" for Add
  // to note, "why" for a greyed Add to note's reason, shown over the footer, false for
  // none), so only the one pressed reads Copied, and the timer that clears it.
  #copied = false;
  // The reason a greyed Add to note was pressed with, while #copied is "why".
  #why = "";
  #copiedTimer = 0;
  // The reveal nonce last acted on (machine one-shot): a drag inside an existing
  // highlight opens that highlight's bubble, told through context.reveal (Decision 6).
  #lastReveal = 0;
  // The glow nonce last acted on (machine one-shot, passage.selected), the highlight
  // glowing now and the timer that ends it; a repaint while it glows keeps the class.
  #lastGlow = 0;
  #glowing = null;
  #glowTimer = 0;
  // The kind of the last pointer pressed on the page, so what the system would do with a
  // finger's press (#noNative) is refused while a mouse keeps its selection and its menu.
  #lastPointer = null;
  // The picture open in the viewer, the view's own UI state like the bubble: its source,
  // the quarter turns so far (only ever counted up), the zoom and the pan. Null while
  // closed; a new chapter closes it. Nothing of it is saved.
  #figure = null;
  // The viewer's pointers now down, by id, and the gesture they make (a tap, a pan or a
  // pinch), with the last tap's time and place for a double tap.
  #figurePointers = new Map();
  #figureGesture = null;
  #lastTap = null;
  #gestureZoom = 1;
  #wheelTimer = 0;
  // A finger's passage, from the hold that starts it until the lift makes it: the word it
  // started on, the [from, to) painted, the page's lines as measured at the hold (the text
  // does not move under a passage), and where the finger is.
  #finger = null;
  // A handle being dragged, from the press until the mark shows its new ends: the highlight,
  // which end, the [from, to) as it stands and as it was, the page's lines as measured at the
  // press, where the end is meant to be, how far the press was from it (so grabbing it does
  // not move it), and whether the move has been sent.
  #moving = null;
  // Whether the open bubble's highlight has been seen, because a new one's note arrives just
  // after the bubble opens.
  #activeSeen = false;
  #holdTimer = 0;
  // Until when a click in the text belongs to a finger's press that already did its work.
  #clickGone = 0;
  // iOS's own long presses (text interaction, loupe, link preview, lifting a drag) end a
  // touch whose finger rests, even in the middle of a drag, and that finger then sends
  // nothing more, so a passage could not go on. Refusing the touchstart makes them fail
  // while the pointer events keep coming. The browser then sends no click and moves no
  // focus for that touch, so #pointerup does a tap's work. A control needs its click, so
  // only a touch on the reading text is refused. A handle sits in the text and is refused too.
  #touchstart = (e) => {
    const target = e.composedPath()[0];
    if (e.cancelable && target.closest?.(".viewport") && !target.closest("button, .bubble")) e.preventDefault();
  };
  // These must be on the host before a touch begins: iOS decides at touchstart whether it
  // waits for a page's touch listeners, and only a non-passive listener may refuse. A touch
  // may still end with no pointerup, and a passage must not stay down then.
  #touchmove = (e) => {
    if ((this.#finger || this.#moving) && e.cancelable) e.preventDefault();
  };
  #touchend = (e) => {
    if (e.touches?.length) return;
    this.#cancelHold();
    if (this.#finger) this.#lift();
    this.#release();
  };

  // The fragment element: a bare div with the click handler for in-text chapter links.
  // Made here so #swapStrip can build a second one for a chapter-crossing slide.
  #makeStrip() {
    const strip = document.createElement("div");
    strip.className = "strip";
    // A link inside the text to another chapter (the importer rewrote it to a
    // data-chapter, and a fragment to a data-block): jump rather than navigate.
    strip.addEventListener("click", (e) => {
      if (Date.now() < this.#clickGone) {
        e.preventDefault();
        return;
      }
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
    this.addEventListener("touchstart", this.#touchstart, { passive: false });
    this.addEventListener("touchmove", this.#touchmove, { passive: false });
    this.addEventListener("touchend", this.#touchend);
    this.addEventListener("touchcancel", this.#touchend);
  }

  disconnectedCallback() {
    this.removeEventListener("touchstart", this.#touchstart);
    this.removeEventListener("touchmove", this.#touchmove);
    this.removeEventListener("touchend", this.#touchend);
    this.removeEventListener("touchcancel", this.#touchend);
    this.#cancelHold();
    this.#ro?.disconnect();
    this.#ro = null;
    this.#leaving?.remove();
    this.#leaving = null;
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#glowTimer);
    clearTimeout(this.#timer);
    clearTimeout(this.#copiedTimer);
    clearTimeout(this.#slideTimer);
    this.#focused = false;
    this.#visual = null;
    this.#dropFinger();
    this.#dropMoving();
    this.#paintCursor();
    cancelAnimationFrame(this.#speechRaf);
    this.#speechRaf = 0;
    this.#clipLoaded = false;
    this.#audio?.pause();
    globalThis.CSS?.highlights?.delete(SPOKEN);
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
    this.#dropFinger();
    this.#hush();
    this.#hovered = null;
    this.#figure = null;
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
    const range = this.#composedRange();
    if (range && !(range.startContainer === range.endContainer && range.startOffset === range.endOffset)) return range;
    const scoped = this.renderRoot.getSelection?.();
    if (scoped && !scoped.isCollapsed && scoped.rangeCount) return scoped.getRangeAt(0);
    return null;
  }

  // The document's selection as one range seen from inside this shadow root, or null
  // where getComposedRanges does not exist. The Mac app's window is the Mac's own WebKit,
  // and Safari 17 and 18 take the shadow roots only as separate arguments and throw on
  // the { shadowRoots } form the standard now uses (WebKit bug 265632), so the older form
  // is the fallback.
  #composedRange() {
    const doc = document.getSelection();
    if (typeof doc?.getComposedRanges !== "function") return null;
    try {
      return doc.getComposedRanges({ shadowRoots: [this.renderRoot] })[0] ?? null;
    } catch {
      return doc.getComposedRanges(this.renderRoot)[0] ?? null;
    }
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
    return this.#sendHighlight(p, q, false, true);
  }

  // --- A finger's passage ---------------------------------------------------------------
  //
  // A finger never uses the browser's selection, whose idea of where the finger is jumps
  // in this box. The page's characters are measured once, at the hold, and every move is
  // then a sum over those boxes (machine.js), the same in every engine; no caret API is
  // asked, since on iOS those can answer with a node outside this shadow root.

  // Each character shown on this page with its box and its flat index. A block counted by
  // the measure starts on or before its page, so the one before the first that starts
  // here may run in from the page before.
  #pageChars() {
    const chapter = this.#chapterText();
    const first = this.#pageOf.findIndex((p) => p >= this.#page);
    const chars = [];
    const range = document.createRange();
    const here = (r) => (r.width > 0 || r.height > 0) && this.#columnOf(r) === this.#page;
    for (let b = Math.max(0, (first < 0 ? this.#pageOf.length : first) - 1); b < this.#pageOf.length && this.#pageOf[b] <= this.#page; b += 1) {
      for (const { node, start } of this.#textNodes(b)) {
        range.selectNodeContents(node);
        if (![...range.getClientRects()].some(here)) continue;
        for (let k = 0; k < node.data.length; k += 1) {
          range.setStart(node, k);
          range.setEnd(node, k + 1);
          const r = [...range.getClientRects()].find((rect) => rect.width > 0 && here(rect));
          if (r) chars.push({ i: chapter.starts[b] + start + k, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
        }
      }
    }
    return chars;
  }

  // The finger has rested: this press is neither a swipe nor a tap any more. On a picture
  // it does nothing; a page with no text has nothing to start on.
  #held() {
    this.#holdTimer = 0;
    const d = this.#drag;
    if (!d) return;
    d.abandoned = true;
    d.dragging = false;
    if (d.picture) return;
    const lines = linesOf(this.#pageChars());
    const at = charNear(lines, d.x0, d.y0);
    if (at == null) return;
    this.#closeBubble(false);
    this.#clearSelection();
    const chapter = this.#chapterText();
    const word = wordAround(chapter, at);
    this.#finger = { word, span: fingerPassage(chapter, word, at), lines, x: d.x0, y: d.y0, frame: 0 };
    this.#paintFinger();
    this.requestUpdate();
  }

  #cancelHold() {
    clearTimeout(this.#holdTimer);
    this.#holdTimer = 0;
  }

  // A move may come many times a frame, and only the last before a frame can be seen.
  #follow(x, y) {
    const f = this.#finger;
    f.x = x;
    f.y = y;
    f.frame ||= requestAnimationFrame(() => this.#grow());
  }

  #grow() {
    const f = this.#finger;
    if (!f) return;
    cancelAnimationFrame(f.frame);
    f.frame = 0;
    const span = fingerPassage(this.#chapterText(), f.word, charNear(f.lines, f.x, f.y));
    if (span[0] === f.span[0] && span[1] === f.span[1]) return;
    f.span = span;
    this.#paintFinger();
  }

  // The passage's lines as boxes in the page, from the boxes measured at the hold. The text
  // it names is for tests.
  #paintFinger() {
    const el = this.renderRoot?.querySelector(".passage");
    if (!el) return;
    const f = this.#finger ?? this.#moving;
    const origin = el.getBoundingClientRect();
    el.replaceChildren(
      ...(f ? lineBoxes(f.lines, f.span[0], f.span[1]) : []).map((line) => {
        const box = document.createElement("i");
        box.style.setProperty("--px", `${line.left - origin.left}px`);
        box.style.setProperty("--py", `${line.top - origin.top}px`);
        box.style.setProperty("--pw", `${line.right - line.left}px`);
        box.style.setProperty("--ph", `${line.bottom - line.top}px`);
        return box;
      }),
    );
    el.dataset.text = f ? this.#rangeOf(f.span[0], f.span[1], this.#chapterText())?.toString() ?? "" : "";
  }

  // Lifting makes what is painted, letter for letter, as a keyboard passage is (12, "Vim
  // keys"), and its bubble opens; Undo takes it back. A cancelled touch ends here too: what it
  // painted is kept.
  #lift() {
    const f = this.#finger;
    this.#grow();
    this.#drag = null;
    this.#clickGone = Date.now() + CLICK_AFTER_MS;
    const chapter = this.#chapterText();
    this.#dropFinger();
    this.#sendHighlight(pointAt(chapter, f.span[0]), pointAt(chapter, f.span[1]), true, true);
  }

  #dropFinger() {
    if (!this.#finger) return;
    cancelAnimationFrame(this.#finger.frame);
    this.#finger = null;
    this.#paintFinger();
    this.requestUpdate();
  }

  // --- A highlight's handles (12) -------------------------------------------------------
  //
  // The browser's own selection handles are what jumped in this box (#held), so these are
  // the reader's, drawn on the open bubble's highlight. They use the same measure as a finger's
  // passage. Every press, move and lift on one stops here, so nothing under it hears of it, and
  // a mouse's press is not let start a selection or take the keyboard off a comment box.

  // The open bubble's highlight as [from, to) of the chapter, or null.
  #activeSpan() {
    const h = this.#actor.snapshot?.context.highlights.find((x) => x.id === this.#active);
    if (!h) return null;
    const chapter = this.#chapterText();
    return [indexOf(chapter, h.place.start), indexOf(chapter, h.place.end)];
  }

  // The rect of an end's own character on the page shown, or null when it is on another.
  #endRect(end, [from, to]) {
    const chapter = this.#chapterText();
    const range = end === "start" ? this.#rangeOf(from, from + 1, chapter) : this.#rangeOf(to - 1, to, chapter);
    return [...(range?.getClientRects() ?? [])].find((r) => r.width > 0 && this.#columnOf(r) === this.#page) ?? null;
  }

  // Each handle on its end, set as custom properties (7.4), hidden while its end is not on
  // the page shown.
  #placeHandles() {
    const handles = this.renderRoot.querySelectorAll(".handle");
    if (!handles.length) return;
    const span = this.#moving?.span ?? this.#activeSpan();
    const box = this.renderRoot.querySelector(".page").getBoundingClientRect();
    for (const el of handles) {
      const end = el.dataset.end;
      const rect = span && this.#endRect(end, span);
      el.hidden = !rect;
      if (!rect) continue;
      el.style.setProperty("--hh", `${rect.height}px`);
      el.style.setProperty("--hx", `${(end === "start" ? rect.left : rect.right) - box.left - el.offsetWidth / 2}px`);
      el.style.setProperty("--hy", `${(end === "start" ? rect.bottom - el.offsetHeight : rect.top) - box.top}px`);
    }
  }

  #grab(e, end) {
    e.stopPropagation();
    if ((e.button != null && e.button !== 0) || this.#moving) return;
    const span = this.#activeSpan();
    const rect = span && this.#endRect(end, span);
    if (!rect) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer already gone has nothing to capture, and what follows ends the drag.
    }
    this.#lastPointer = e.pointerType;
    const x = end === "start" ? rect.left : rect.right;
    const y = (rect.top + rect.bottom) / 2;
    this.#moving = { id: this.#active, end, span, was: span, lines: linesOf(this.#pageChars()), x, y, dx: e.clientX - x, dy: e.clientY - y, frame: 0, pointerId: e.pointerId, sent: false };
    this.#reflectGlow();
    this.#paintFinger();
    this.requestUpdate();
  }

  // A move may come many times a frame, and only the last before a frame can be seen.
  #moveHandle(e) {
    e.stopPropagation();
    const m = this.#moving;
    if (!m || m.sent || e.pointerId !== m.pointerId) return;
    m.x = e.clientX - m.dx;
    m.y = e.clientY - m.dy;
    m.frame ||= requestAnimationFrame(() => this.#stepHandle());
  }

  #stepHandle() {
    const m = this.#moving;
    if (!m) return;
    cancelAnimationFrame(m.frame);
    m.frame = 0;
    if (m.sent) return;
    const at = charNear(m.lines, m.x, m.y);
    if (at == null) return;
    const span = movedEnd(this.#chapterText(), m.span, m.end, at);
    if (span[0] === m.span[0] && span[1] === m.span[1]) return;
    m.span = span;
    this.#paintFinger();
    this.#placeHandles();
  }

  // The end stays where the handle was let go, one step. The drag's own boxes stay until the
  // mark shows the new ends (updated). A touch iOS ended counts as a release, so what was
  // painted is kept. Nothing moved is nothing to save.
  #release() {
    const m = this.#moving;
    if (!m || m.sent) return;
    this.#stepHandle();
    m.sent = true;
    this.#clickGone = Date.now() + CLICK_AFTER_MS;
    if (m.span[0] !== m.was[0] || m.span[1] !== m.was[1]) {
      const chapter = this.#chapterText();
      this.#actor.send({ type: "_move", id: m.id, start: pointAt(chapter, m.span[0]), end: pointAt(chapter, m.span[1]), texts: this.#blockTexts() });
    }
    this.requestUpdate();
  }

  #dropMoving() {
    if (!this.#moving) return;
    cancelAnimationFrame(this.#moving.frame);
    this.#moving = null;
    this.#reflectGlow();
    this.#paintFinger();
    this.requestUpdate();
  }

  // What the system would do with a finger's long press: a selection where the text can
  // still select (a touch screen with a fine main pointer), a menu (Android), a lifted link.
  #noNative(e) {
    if (e.composedPath()[0]?.closest?.(".bubble")) return;
    if (this.#lastPointer != null && this.#lastPointer !== "mouse") e.preventDefault();
  }

  // Two places as the _highlight message, whichever comes first: the tail the mouse and
  // the keyboard share (12). The keyboard's is `exact`: its passage was painted letter
  // by letter as it was made, so it is not grown to whole words as a drag is.
  #sendHighlight(p, q, exact = false, open = false) {
    if (!p || !q) return false;
    const [start, end] = p.block > q.block || (p.block === q.block && p.offset > q.offset) ? [q, p] : [p, q];
    if (start.block === end.block && start.offset === end.offset) return false;
    this.#actor.send({ type: "_highlight", start, end, exact, open, texts: this.#blockTexts() });
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
    const scoped = this.renderRoot.getSelection?.();
    const range = this.#composedRange() ?? (scoped?.rangeCount ? scoped.getRangeAt(0) : null);
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
    this.#dropFinger();
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
    this.#strip.classList.toggle("painted", Boolean(this.#visual) || speechMode(this.#actor.snapshot) !== "idle");
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
  // y and what follows it within a second, as gg (Vim's operator): y y copies the
  // highlight's quote, y i s and y i p the sentence or paragraph; #yInner once i came.
  #yAt = 0;
  #yInner = false;
  // d and a second d within a second, as gg: d d removes the highlight at the cursor.
  #dAt = 0;
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
      const dHeld = !this.#visual && Date.now() - this.#dAt < 1000;
      this.#dAt = 0;
      if (this.#cursor == null) this.#placeCursor();
      const yHeld = !this.#visual && Date.now() - this.#yAt < 1000;
      const inner = this.#yInner;
      this.#yAt = 0;
      this.#yInner = false;
      if (yHeld && !inner && key === "i") {
        // The y before it opened a highlight's bubble; y i copies text, not the link.
        this.#closeBubble();
        this.#yAt = Date.now();
        this.#yInner = true;
      } else if (yHeld && inner && (key === "s" || key === "p")) this.#yankObject(key);
      else if (yHeld && !inner && key === "y") this.#yankQuote();
      else if (key === "g") {
        if (second) this.#edge(0);
      } else if (key === "G") this.#edge(this.#pages - 1);
      // h and l move the cursor one letter, as in Vim, inside a highlight and outside
      // one; the page turns only when the cursor leaves it, as with the other motions.
      else if (isMotion(key) || ["0", "$", "j", "k", "l", "h"].includes(key)) {
        if (this.#cursor == null) return false;
        this.#move(key);
      } else if (key === "v") this.#visualKey();
      else if (key === "y" && this.#visual) this.#yankVisual();
      else if (key === "y") {
        this.#yAt = Date.now();
        this.#yankLink();
      } else if (key === "a" && !this.#visual && slipBoxShown(this.#actor.snapshot.context.hidden)) this.#addAtCursor();
      else if (key === "d" && !this.#visual) {
        if (dHeld) this.#removeAtCursor();
        else this.#dAt = Date.now();
      } else if ((key === "r" || key === "R") && !this.#visual && canRead(this.#actor.snapshot.context)) this.#readAtCursor(key === "R");
      else if (key === "Enter" && this.#visual) this.#endVisual(true);
      else if (key === "Escape" && this.#visual) this.#endVisual(false);
      else return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  // While the command line is open every key is the line's, so the reader's own keys
  // wait; the machine decides what each one does. ":" opens it, with Vim keys on.
  #commandLine(e) {
    const context = this.#actor.snapshot?.context;
    if (!context?.vimKeys || e.metaKey || e.altKey) return false;
    if (context.command == null) {
      if (e.key !== ":" || e.ctrlKey) return false;
      const target = e.composedPath()[0];
      if (target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName)) return false;
      if (this.#visual) this.#endVisual(false);
      this.#closeBubble();
    } else if (e.ctrlKey) return true;
    this.#actor.send({ type: "_commandKey", key: e.key });
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

  // The highlight holding the cursor, if any.
  #highlightAtCursor() {
    if (this.#cursor == null) return null;
    const ctx = this.#actor.snapshot.context;
    const cv = ctx.book?.contentVersion;
    const painted = ctx.highlights.filter((h) => h.place.contentVersion === cv);
    return highlightAt(painted, this.#chapter, pointAt(this.#chapterText(), this.#cursor)) ?? null;
  }

  // y: Copy link on the highlight holding the cursor, its bubble opened so the Copied is
  // seen. With no highlight there, y does nothing.
  #yankLink() {
    const h = this.#highlightAtCursor();
    if (!h) return;
    this.#openBubble(h.id);
    this.#copy("link", h);
  }

  // y y: Copy on the highlight holding the cursor, its quote's text; the bubble's Copy
  // reads Copied.
  #yankQuote() {
    const h = this.#highlightAtCursor();
    if (!h?.quote?.exact) return;
    this.#openBubble(h.id);
    this.#copyText(h.quote.exact, "text");
  }

  // a: Add to note on the highlight holding the cursor, its bubble opened so Added, or
  // the reason it cannot be added, is seen. With Slip-Box hidden a is not the reader's.
  #addAtCursor() {
    const h = this.#highlightAtCursor();
    if (!h) return;
    const add = addToNote(this.#actor.snapshot.context, h.id);
    if (!add) return;
    this.#openBubble(h.id);
    this.#addActive(h, add);
  }

  // d d: Remove on the highlight holding the cursor. With no highlight there, d d does
  // nothing.
  #removeAtCursor() {
    const h = this.#highlightAtCursor();
    if (!h) return;
    this.#openBubble(h.id);
    this.#removeActive();
  }

  // y on a passage marked with v or Ctrl+v copies it and makes no highlight; Enter
  // still makes one (12).
  #yankVisual() {
    const v = this.#visual;
    this.#visual = null;
    this.#paintCursor();
    const chapter = this.#chapterText();
    const [from, to] = passage(chapter, v.start, this.#cursor, v.letter);
    this.#copyPassage(from, to);
  }

  // y i s and y i p: the sentence or the paragraph holding the cursor.
  #yankObject(key) {
    if (this.#cursor == null) return;
    const [from, to] = textObject(this.#chapterText(), this.#cursor, key);
    this.#copyPassage(from, to);
  }

  #copyPassage(from, to) {
    this.#copyText(passageText(this.#chapterText(), from, to), "passage");
  }

  // gg and G: the chapter's first or last page, the cursor at its top.
  #edge(page) {
    this.#closeBubble();
    this.#endSettle();
    this.#cursor = null;
    this.#turn(page);
  }

  // --- Reading aloud (3.1) ------------------------------------------------------------
  //
  // The actor decides what is read and when each block ends; the view plays the clip it
  // is handed on one audio element, lights the word being said, tints its block and
  // places the margin speaker. The block under the mouse, the clip loaded, and the word
  // last lit are the view's own UI state (3.1).
  #audio = null;
  #clipN = 0;
  #clipLoaded = false;
  #words = [];
  #hovered = null;
  #lit = null;
  #speechRaf = 0;
  #lastNotice = 0;

  #player() {
    if (!this.#audio) {
      const audio = new Audio();
      audio.addEventListener("ended", () => {
        if (this.#clipLoaded) this.#actor.send({ type: "_spoken", n: this.#clipN });
      });
      this.#audio = audio;
    }
    return this.#audio;
  }

  // A browser that refuses to play without a press ends the reading quietly; a play cut
  // short by a pause or the next clip is no refusal.
  #play(audio) {
    audio.play().catch((e) => {
      if (e?.name === "NotAllowedError" && this.#clipLoaded) this.#actor.send({ type: "_hush" });
    });
  }

  // The press that starts reading plays a moment of silence on the audio element at
  // once, inside the press, which is what lets the clips that arrive later play.
  #say(items) {
    const context = this.#actor.snapshot?.context;
    if (!context || !canRead(context) || !items.length) return;
    const audio = this.#player();
    this.#clipLoaded = false;
    audio.src = SILENCE;
    this.#play(audio);
    this.#actor.send({ type: "_say", blocks: items });
  }

  // The blocks to read, each with its text as long as the page counts it, so the voice's
  // character offsets fall on the page's own text; the top block of the page, when it
  // runs in from the page before, from where this page starts.
  #items(blocks, top = null, start = 0) {
    return blocks
      .filter((b) => speakable(this.#strip.children[b]))
      .map((b) => {
        const text = spokenText(this.#strip.children[b]);
        return b === top && start > 0 ? { block: b, text: text.slice(start), start } : { block: b, text, start: 0 };
      })
      .filter((item) => item.text.trim() !== "");
  }

  // The blocks from one on to the last that starts on the page shown.
  #toPageEnd(from) {
    const out = [];
    for (let b = from; b < this.#pageOf.length && (b === from || this.#pageOf[b] <= this.#page); b += 1) out.push(b);
    return out;
  }

  #readPage() {
    const top = this.#topBlock(this.#page);
    const start = this.#anchor.block === top ? this.#anchor.offset : 0;
    this.#say(this.#items(this.#toPageEnd(top), top, start));
  }

  // r reads the paragraph holding the Vim cursor, R the page from it.
  #readAtCursor(page) {
    if (this.#cursor == null) return;
    const chapter = this.#chapterText();
    const [from] = textObject(chapter, this.#cursor, "p");
    const { block } = pointAt(chapter, from);
    this.#say(this.#items(page ? this.#toPageEnd(block) : [block]));
  }

  #hush() {
    if (speechMode(this.#actor.snapshot) !== "idle") this.#actor.send({ type: "_hush" });
  }

  #pauseOrResume() {
    const mode = speechMode(this.#actor.snapshot);
    if (mode === "reading") this.#actor.send({ type: "_pause" });
    else if (mode === "paused") this.#actor.send({ type: "_resume" });
  }

  // The audio element follows the actor: a new clip is loaded and played once, Pause and
  // Resume pause and play it, and the end of reading silences it.
  #syncSpeech(force = false) {
    const snapshot = this.#actor.snapshot;
    const mode = speechMode(snapshot);
    const clip = mode === "idle" ? null : snapshot.context.speech.clip;
    if (mode === "idle") {
      if (this.#clipLoaded) this.#audio.pause();
      this.#clipLoaded = false;
    } else if (clip && clip.n !== this.#clipN) {
      this.#clipN = clip.n;
      this.#clipLoaded = true;
      this.#words = clip.words;
      const audio = this.#player();
      audio.src = `data:${clip.mime};base64,${clip.audio}`;
      if (mode === "reading") this.#play(audio);
    } else if (clip && this.#clipLoaded) {
      if (mode === "reading" && this.#audio.paused && !this.#audio.ended) this.#play(this.#audio);
      else if (mode === "paused" && !this.#audio.paused) this.#audio.pause();
    }
    this.#paintSpeech(force);
    if (mode === "reading" && this.#clipLoaded && !this.#speechRaf) this.#speechRaf = requestAnimationFrame(this.#tickSpeech);
  }

  #tickSpeech = () => {
    this.#speechRaf = 0;
    if (speechMode(this.#actor.snapshot) !== "reading" || !this.#clipLoaded) return;
    this.#paintSpeech();
    this.#speechRaf = requestAnimationFrame(this.#tickSpeech);
  };

  // A block's characters [from, to) as a DOM range, through the text nodes its places
  // are counted in.
  #blockRange(block, from, to) {
    const nodes = this.#textNodes(block);
    const at = (i) => {
      for (let k = nodes.length - 1; k >= 0; k -= 1) {
        if (nodes[k].start <= i) return { node: nodes[k].node, offset: Math.min(i - nodes[k].start, nodes[k].node.data.length) };
      }
      return null;
    };
    const a = at(from);
    const b = at(to);
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  }

  // The block being read tinted, and the word being said lit, by the clip's own clock.
  // `force` paints again after the marks were rebuilt, which moves the text nodes.
  #paintSpeech(force = false) {
    const snapshot = this.#actor.snapshot;
    const speech = speechMode(snapshot) === "idle" ? null : snapshot.context.speech;
    const item = speech?.queue[speech.at] ?? null;
    const target = item ? this.#strip.children[item.block] : null;
    let word = -1;
    if (item && this.#clipLoaded && speech.clip?.n === this.#clipN) word = wordAt(this.#words, this.#audio.currentTime);
    const key = item ? `${this.#clipN}:${item.block}:${word}` : null;
    if (!force && key === this.#lit) return;
    this.#lit = key;
    for (const el of this.#strip.querySelectorAll(":scope > .speaking")) if (el !== target) el.classList.remove("speaking");
    target?.classList.add("speaking");
    const registry = globalThis.CSS?.highlights;
    if (registry) {
      const w = word >= 0 ? this.#words[word] : null;
      const range = w ? this.#blockRange(item.block, item.start + w.from, item.start + w.to) : null;
      // A new Highlight every time, as the cursor's passage (#paintCursor), for Safari.
      if (range) registry.set(SPOKEN, new Highlight(range));
      else registry.delete(SPOKEN);
      this.#strip.classList.toggle("repaint");
    }
    this.#placeSay();
  }

  // The margin speaker beside the block under the mouse, and Stop beside the block being
  // read, each on that block's first line on the page shown.
  #placeSay() {
    const snapshot = this.#actor.snapshot;
    const speech = speechMode(snapshot) === "idle" ? null : snapshot.context.speech;
    const reading = speech?.queue[speech.at]?.block ?? null;
    this.#placeAt(this.renderRoot?.querySelector(".say.stop"), reading);
    this.#placeAt(this.renderRoot?.querySelector(".say.read"), this.#hovered === reading ? null : this.#hovered);
  }

  #placeAt(button, block) {
    if (!button) return;
    const el = block == null ? null : this.#strip.children[block];
    let line = null;
    if (el) {
      const range = document.createRange();
      range.selectNodeContents(el);
      line = [...range.getClientRects()].find((r) => (r.width > 0 || r.height > 0) && this.#columnOf(r) === this.#page) ?? null;
    }
    if (!line) {
      button.hidden = true;
      return;
    }
    const strip = this.#strip;
    const box = strip.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(strip).columnGap) || 0;
    button.hidden = false;
    // The page's left edge in the strip's own frame: the button slides with --page, as
    // the strip does, so it is placed on the page's column and the slide brings it home.
    button.style.setProperty("--sx", `${strip.offsetLeft + this.#page * (box.width + gap) - button.offsetWidth}px`);
    button.style.setProperty("--sy", `${strip.offsetTop + line.top - box.top}px`);
    if (button.style.getPropertyValue("--page") !== String(this.#page)) {
      button.style.transition = "none";
      button.style.setProperty("--page", this.#page);
      void button.offsetWidth;
      button.style.transition = "";
    }
    button.dataset.block = block;
  }

  // The block under the mouse, for the margin speaker; the speaker itself keeps it.
  #hover(e) {
    if (e.pointerType !== "mouse" || !canRead(this.#actor.snapshot?.context ?? {})) return;
    const target = e.composedPath()[0];
    if (target?.closest?.(".say")) return;
    let el = target?.nodeType === 1 ? target : target?.parentElement;
    while (el && el.parentNode !== this.#strip) el = el.parentElement;
    const block = el && speakable(el) ? [...this.#strip.children].indexOf(el) : null;
    if (block === this.#hovered) return;
    this.#hovered = block;
    this.#placeSay();
  }

  #unhover() {
    if (this.#hovered == null) return;
    this.#hovered = null;
    this.#placeSay();
  }

  // Open the bubble on a highlight (session 3): its own UI state, so a normal mark click
  // needs no message to the machine. The overlap case reaches here through the reveal
  // one-shot (updated). A stale "Copied" is cleared, so the bubble opens reading Copy.
  #openBubble(id) {
    if (!id) return;
    clearTimeout(this.#copiedTimer);
    if (id !== this.#active) {
      this.#saveComment();
      this.#actor.send({ type: "_commentClose" });
    }
    this.#active = id;
    this.#activeSeen = false;
    this.#copied = false;
    this.#dropFinger();
    this.requestUpdate();
  }

  // Closing keeps the highlight and what its comment box holds. `back` hands the keyboard to
  // the page when the bubble held it.
  #closeBubble(back = true) {
    if (this.#active == null && !this.#copied) return;
    clearTimeout(this.#copiedTimer);
    const held = this.renderRoot.querySelector(".bubble")?.matches(":focus-within");
    this.#saveComment();
    this.#actor.send({ type: "_commentClose" });
    this.#active = null;
    this.#copied = false;
    if (this.#moving?.sent) this.#dropMoving();
    this.requestUpdate();
    if (back && held) this.renderRoot.querySelector(".reader")?.focus({ preventScroll: true });
  }

  #saveComment() {
    const box = this.renderRoot?.querySelector(".bubble textarea");
    if (box) this.#actor.send({ type: "_commentSave", body: box.value });
  }

  // Copy the highlighted text, or a link to it (Decision 3): nothing is ever copied
  // without this, and the write is inside the click or key handler, where the clipboard
  // permission holds. The button reads "Copied" for a moment; a blocked clipboard leaves
  // it as it was rather than error. A link is announced either way, so an editor's Vim
  // register gets it even when the system clipboard refused it.
  async #copy(kind, h) {
    const link = kind === "link";
    try {
      await navigator.clipboard.writeText(link ? sourceLink(h.id, h.quote) : (h.quote?.exact ?? ""));
      this.#flashCopied(kind);
    } catch {
      // no clipboard permission (an insecure context, a denied prompt): leave the label.
    }
    if (link) this.#actor.send({ type: "_copyLink", id: h.id });
  }

  // Text copied with Vim keys: on the clipboard, with Copied shown for a moment, and
  // announced either way, so an editor's Vim register gets it as it gets a link.
  async #copyText(text, kind) {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      this.#flashCopied(kind);
    } catch {
      // no clipboard permission: nothing reads Copied, as with the bubble's buttons.
    }
    this.#actor.send({ type: "_copyText", text });
  }

  #flashCopied(kind, ms = COPIED_MS) {
    clearTimeout(this.#copiedTimer);
    this.#copied = kind;
    this.requestUpdate();
    this.#copiedTimer = setTimeout(() => {
      this.#copied = false;
      this.requestUpdate();
    }, ms);
  }

  // Remove (Decision 3): the gesture is one message; the highlight goes at once, its mark
  // and bubble with it, and the short notice offers Undo (12, Undo).
  #removeActive() {
    if (this.#active) this.#actor.send({ type: "_remove", id: this.#active });
  }

  // Marks repaint from scratch, so the glowing highlight's class is set again each render.
  #reflectGlow() {
    for (const mark of this.#strip?.querySelectorAll("mark") ?? []) {
      mark.classList.toggle("glow", this.#glowing != null && mark.dataset.id === this.#glowing);
      mark.classList.toggle("moving", this.#moving != null && mark.dataset.id === this.#moving.id);
    }
  }

  // Place the open bubble above its mark's first line on the page shown, inside the clipped
  // .page, clear of the handle's ball there: centred on that line and clamped within the page.
  // With no room above it goes under the mark's last line, clear of the other handle, and with
  // room on neither side on the side that has more. Positions are set as custom properties
  // (7.4). A mark gone (the chapter changed, the note removed) closes the bubble. A bubble in
  // a drag stays where it was, so it never seems to jump.
  #positionBubble() {
    const bubble = this.renderRoot.querySelector(".bubble");
    const page = this.renderRoot.querySelector(".page");
    if (!bubble || !page || this.#moving) return;
    const marks = [...this.#strip.querySelectorAll(`mark[data-id="${this.#active}"]`)];
    if (!marks.length) {
      this.#closeBubble();
      return;
    }
    // A highlight split across pages sits beside its part on the page shown, the part
    // clicked or holding the cursor, not beside its first line on a page turned away.
    const lines = marks.flatMap((m) => [...m.getClientRects()]).filter((r) => r.width > 0 || r.height > 0);
    const shown = lines.filter((r) => this.#columnOf(r) === this.#page);
    const line = shown[0] ?? lines[0] ?? marks[0].getBoundingClientRect();
    const last = shown.at(-1) ?? line;
    const box = page.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    let x = line.left - box.left + line.width / 2 - bw / 2;
    x = Math.max(0, Math.min(Math.max(0, box.width - bw), x));
    const clear = BUBBLE_GAP + BALL_CLEAR;
    const above = line.top - box.top - bh - clear;
    const below = last.bottom - box.top + clear;
    const fitsBelow = below + bh <= box.height;
    let y = above >= 0 || (!fitsBelow && -above < below + bh - box.height) ? above : below;
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
    const moving = [this.#strip, this.renderRoot?.querySelector(".cursor"), ...(this.renderRoot?.querySelectorAll(".say") ?? [])].filter(Boolean);
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
    this.#placeSay();
  }

  // A turn: the anchor becomes the top of the page turned to.
  #turn(page) {
    if (this.#finger) return;
    // A page turned ends reading aloud: what is read is the page shown.
    this.#hush();
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
    // The boxes a passage in progress was measured in, and the line its button sits under,
    // are gone with the old layout.
    this.#dropFinger();
    if (!this.#measure()) return;
    this.#keep();
  }

  // Land on the wanted block once the fresh fragment is laid out. A chapter switch does
  // not resize the host, so the ResizeObserver never fires for it; measure now (often
  // right), then again next frame in case the layout or the web font was not ready yet.
  #schedule() {
    cancelAnimationFrame(this.#raf);
    clearTimeout(this.#glowTimer);
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
    clearTimeout(this.#glowTimer);
    clearTimeout(this.#timer);
  }

  // A turn that stays in the chapter shows the neighbouring page; a turn past the edge
  // loads a neighbour chapter, which schedules its own settling afresh.
  #next() {
    if (this.#finger) return;
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
    if (this.#finger) return;
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
    // While a picture is open the page under it keeps still: Escape closes the viewer,
    // and no other key reaches the page.
    if (this.#figure) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.#closeFigure();
      }
      return;
    }
    if (this.#commandLine(e)) return;
    // While anything is read aloud Space pauses and resumes it, before Space turns a page.
    if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey && speechMode(this.#actor.snapshot) !== "idle") {
      e.preventDefault();
      e.stopPropagation();
      this.#pauseOrResume();
      return;
    }
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
    } else if (e.key === "Escape" && speechMode(this.#actor.snapshot) !== "idle") {
      e.preventDefault();
      e.stopPropagation();
      this.#hush();
    }
  }

  // The cursor shows only while the reader has the keyboard, and comes back where it was.
  #focusChanged(focused) {
    this.#focused = focused;
    if (!focused && this.#actor.snapshot?.context.command != null) this.#actor.send({ type: "_commandKey", key: "Escape" });
    this.#paintCursor();
  }

  #pointerdown(e) {
    this.#lastPointer = e.pointerType;
    if (e.button != null && e.button !== 0) return;
    // A second finger during a passage or a handle's drag is not a new press.
    if (this.#finger || this.#moving) return;
    this.#cancelHold();
    this.#endVisual(false);
    const img = e.target.closest?.("img");
    const mouse = e.pointerType === "mouse";
    if (!mouse && this.highlights) this.#holdTimer = setTimeout(() => this.#held(), HOLD_MS);
    this.#drag = {
      pointerId: e.pointerId,
      mouse,
      picture: Boolean(img && this.#isPicture(img)),
      x0: e.clientX,
      y0: e.clientY,
      t0: e.timeStamp,
      width: e.currentTarget.getBoundingClientRect().width,
      dragging: false,
      abandoned: false,
    };
  }

  #pointermove(e) {
    this.#hover(e);
    const d = this.#drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (this.#finger) {
      this.#follow(e.clientX, e.clientY);
      return;
    }
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (this.#holdTimer && Math.hypot(dx, dy) > HOLD_SLOP) this.#cancelHold();
    if (d.abandoned) return;
    if (!d.dragging) {
      if (Math.abs(dy) > Math.abs(dx)) {
        d.abandoned = true; // a vertical drag is not a page turn
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
    this.#cancelHold();
    if (this.#finger) {
      this.#lift();
      return;
    }
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
    // A resting finger trembles, so a finger's tap is told by distance, and from a hold by
    // time. The browser moves the focus for a click, and a refused touch has none.
    const still = Math.hypot(dx, e.clientY - d.y0) <= HOLD_SLOP;
    const tap = !d.mouse && still && e.timeStamp - d.t0 < HOLD_MS;
    if (tap) this.focus({ preventScroll: true });
    // A finger's tap with a bubble open is about that bubble: on a highlight it opens that
    // one's, and anywhere else it only closes it, so putting a highlight away never turns the
    // page or follows a link (Norman: forgiveness).
    if (tap && this.#active != null) {
      this.#clickGone = Date.now() + CLICK_AFTER_MS;
      const on = e.target.closest?.("mark");
      if (on) this.#openBubble(on.dataset.id);
      else this.#closeBubble();
      return;
    }
    // A link is followed by its own click, the one a refused touch does not send. A click
    // the browser sends after it anyway must not follow the link a second time.
    const link = tap && e.target.closest?.("a[href]");
    if (link) {
      this.#closeBubble();
      this.#clickGone = 0;
      link.click();
      this.#clickGone = Date.now() + CLICK_AFTER_MS;
      return;
    }
    if (d.dragging || d.abandoned) return; // a drag that is neither a swipe nor a clean tap
    // A click that ends on a selection (a double-click on a word) is about the text.
    if (d.mouse && !(this.renderRoot.getSelection?.() ?? document.getSelection())?.isCollapsed) return;
    // A tap on a picture opens it in the viewer, wherever on the page it lands, so a
    // picture at the edge is never a page turn.
    const img = e.target.closest?.("img");
    if (img && this.#isPicture(img)) {
      this.#closeBubble();
      this.#openFigure(img);
      return;
    }
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

  // A touch the system took: as if lifted, so a passage being dragged is made as painted.
  #pointercancel() {
    this.#cancelHold();
    if (this.#finger) this.#lift();
    this.#drag = null;
  }

  // The fragment and the owed place are the actor's; apply them here after each render,
  // when they change. A new chapter rebuilds the strip and opens its pending block; a
  // pending place in the open chapter re-opens it.
  updated() {
    this.#keepFocus();
    this.#paintFigure();
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return;
    const reading = snapshot.matches("reading");
    const clip = this.renderRoot.querySelector(".page");
    // First in .page: Lit clears every node after the page's last part whenever that part
    // changes, so a strip after it was taken out and put back each time the bubble came or
    // went.
    if (clip && this.#strip.parentNode !== clip) clip.prepend(this.#strip);
    if (!reading) {
      // Nothing to read: drop the fragment so a return starts clean.
      if (this.#lastHtml !== null) {
        this.#setFragment("");
        this.#lastHtml = null;
        this.#lastHighlightKey = null;
      }
      this.#syncSpeech();
      return;
    }
    // While a chapter is fetched the actor already names it but still holds the old
    // fragment; the page keeps showing the old chapter, whole, until the new one lands,
    // rather than the old text under the new title.
    if (!snapshot.matches({ reading: "ready" })) {
      this.#syncSpeech();
      return;
    }
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
    const repainted = rebuilt || highlightKey !== this.#lastHighlightKey;
    if (repainted) {
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
    // A followed source link glows its highlight once (machine one-shot, per nonce).
    const glow = snapshot.context.glow;
    if (glow && glow.n !== this.#lastGlow) {
      this.#lastGlow = glow.n;
      this.#glowing = glow.id;
      clearTimeout(this.#glowTimer);
      const ms = 3 * toMs(getComputedStyle(this).getPropertyValue("--duration-slide"), 300);
      this.#glowTimer = setTimeout(() => {
        this.#glowing = null;
        this.#reflectGlow();
      }, ms + 100);
    }
    this.#reflectGlow();
    // The open bubble is placed after the marks are painted. A highlight the fact has
    // removed closes the bubble.
    // The boxes of a finished drag give way once the mark shows the new ends, in the same
    // render, so neither end is ever seen to jump back.
    if (this.#moving?.sent) this.#dropMoving();
    if (this.#active != null) {
      if (snapshot.context.highlights.some((h) => h.id === this.#active)) {
        this.#activeSeen = true;
        this.#afterComment(snapshot.context);
        this.#positionBubble();
        this.#placeHandles();
      } else if (this.#activeSeen) this.#closeBubble();
    }
    // Reading aloud follows the actor, painted after the marks, which move the text nodes.
    this.#syncSpeech(repainted);
    const notice = snapshot.context.notice;
    if (notice && notice.n !== this.#lastNotice) {
      this.#lastNotice = notice.n;
      this.#why = notice.text;
      this.#flashCopied("why", notice.ms ?? COPIED_MS);
    }
  }

  // The bubble for the open highlight (session 3): Copy, Copy link, Add to note (while Slip-Box is shown), Comment and Remove. Rendered inside .page so it is placed
  // against the same box #positionBubble measures; a press on it never turns the page. The
  // Comment and its box are copied from journal-entry's view.js, because components never
  // import each other (11.2).
  #bubble(snapshot) {
    if (this.#active == null) return nothing;
    const h = snapshot.context.highlights.find((x) => x.id === this.#active);
    if (!h) return nothing;
    const open = snapshot.context.comment?.id === h.id;
    return html`
      <div class="bubble ${this.#moving ? "moving" : ""}" role="group" aria-label="Highlight" @pointerdown=${(e) => e.stopPropagation()} @keydown=${(e) => this.#bubbleKey(e)}>
        <button class="act copy" type="button" @click=${() => this.#copy("text", h)}>
          ${this.#copied === "text" ? "Copied" : "Copy"}
        </button>
        <button class="act copy-link" type="button" @click=${() => this.#copy("link", h)}>
          ${this.#copied === "link" ? "Copied" : "Copy link"}
        </button>
        ${this.#addButton(snapshot, h)}
        <button class="act comment" type="button" aria-expanded=${open} @click=${() => this.#toggleComment(open, h.id)}>Comment</button>
        <button class="act remove" type="button" @click=${() => this.#removeActive()}>Remove</button>
        ${open
          ? html`<textarea aria-label="Your comment on this passage" placeholder="Your comment on this passage" .value=${snapshot.context.comment.body} @blur=${() => this.#saveComment()}></textarea>`
          : nothing}
      </div>
    `;
  }

  // The two handles of the open highlight (#placeHandles places them). They come before the
  // bubble, which is drawn over them where it has to be.
  #handles(snapshot) {
    if (this.#active == null || !snapshot.context.highlights.some((x) => x.id === this.#active)) return nothing;
    const handle = (end) => html`<span
      class="handle ${end}"
      data-end=${end}
      aria-hidden="true"
      hidden
      @pointerdown=${(e) => this.#grab(e, end)}
      @pointermove=${(e) => this.#moveHandle(e)}
      @pointerup=${(e) => {
        e.stopPropagation();
        this.#release();
      }}
      @pointercancel=${(e) => {
        e.stopPropagation();
        this.#release();
      }}
      @mousedown=${(e) => {
        e.stopPropagation();
        e.preventDefault();
      }}
      @contextmenu=${(e) => e.preventDefault()}
    ></span>`;
    return [handle("start"), handle("end")];
  }

  #toggleComment(open, id) {
    if (open) {
      this.#saveComment();
      this.#actor.send({ type: "_commentClose" });
    } else this.#actor.send({ type: "_commentOpen", id });
  }

  // A letter typed in the comment box is typed text, never the reader's key. Escape leaves
  // the box, keeping what was written, for its Comment button; the next one closes the bubble.
  #bubbleKey(e) {
    if (e.composedPath()[0]?.localName !== "textarea") return;
    e.stopPropagation();
    if (e.key !== "Escape") return;
    e.preventDefault();
    this.#saveComment();
    this.#actor.send({ type: "_commentClose" });
    this.#commentBack = true;
  }

  // Set when the comment box closes by Escape, which hands the keyboard to Comment.
  #commentBack = false;
  #boxFor = null;

  // A comment box just opened gets the keyboard; one closed by Escape hands it to Comment.
  #afterComment(context) {
    const id = context.comment?.id ?? null;
    if (id !== this.#boxFor) {
      this.#boxFor = id;
      if (id) this.renderRoot.querySelector(".bubble textarea")?.focus({ preventScroll: true });
    }
    if (this.#commentBack && !id) {
      this.#commentBack = false;
      this.renderRoot.querySelector(".bubble .comment")?.focus({ preventScroll: true });
    }
  }

  // Add to note, only while Slip-Box is shown (addToNote). Greyed with its reason as the
  // tooltip; once pressed it reads "Added" for a moment, then greys, since the note now
  // holds the passage.
  #addButton(snapshot, h) {
    const add = addToNote(snapshot.context, h.id);
    if (!add) return nothing;
    return html`
      <button
        class="act add"
        type="button"
        aria-disabled=${add.enabled ? "false" : "true"}
        title=${add.why ?? nothing}
        @click=${() => this.#addActive(h, add)}
      >
        ${this.#copied === "note" ? "Added" : "Add to note"}
      </button>
    `;
  }

  // A greyed Add to note still takes the press and says why over the footer, so a finger,
  // which never sees the tooltip, learns it too (Norman: feedback).
  #addActive(h, add) {
    if (!add.enabled) {
      this.#why = add.why ?? "";
      this.#flashCopied("why");
      return;
    }
    this.#actor.send({ type: "_addToNote", id: h.id });
    this.#flashCopied("note");
  }

  // The margin speaker and its Stop (placed in #placeAt). A press on either is never a
  // page turn, and leaves the keyboard on the page.
  #sayButtons(snapshot) {
    if (!canRead(snapshot.context)) return nothing;
    const keep = (e) => e.stopPropagation();
    const still = (e) => e.preventDefault();
    return html`<button
        class="say read"
        type="button"
        hidden
        aria-label="Read this paragraph aloud"
        title="Read aloud"
        @pointerdown=${keep}
        @mousedown=${still}
        @click=${() => this.#hovered != null && this.#say(this.#items([this.#hovered]))}
      >
        ${icon("speaker-high")}</button
      ><button class="say stop" type="button" hidden aria-label="Stop reading" title="Stop" @pointerdown=${keep} @mousedown=${still} @click=${() => this.#hush()}>
        ${icon("stop")}
      </button>`;
  }

  // Read page, and while anything is read Pause or Resume and Stop (Norman: every control
  // visible, the one that undoes the last beside it).
  #speakControls(snapshot) {
    if (!canRead(snapshot.context)) return nothing;
    const mode = speechMode(snapshot);
    const still = (e) => e.preventDefault();
    if (mode === "idle")
      return html`<span class="speakctl"
        ><button class="speak page-read" type="button" @mousedown=${still} @click=${() => this.#readPage()}>${icon("speaker-high")}<span>Read page</span></button></span
      >`;
    return html`<span class="speakctl"
      >${mode === "reading"
        ? html`<button class="speak pause" type="button" @mousedown=${still} @click=${() => this.#pauseOrResume()}>${icon("pause")}<span>Pause</span></button>`
        : html`<button class="speak resume" type="button" @mousedown=${still} @click=${() => this.#pauseOrResume()}>${icon("play")}<span>Resume</span></button>`}<button
        class="speak stop"
        type="button"
        @mousedown=${still}
        @click=${() => this.#hush()}
      >
        ${icon("stop")}<span>Stop</span>
      </button></span
    >`;
  }

  #command({ command, notACommand }) {
    if (command != null) return html`<div class="command" role="status">:${command}<span class="caret" aria-hidden="true"></span></div>`;
    if (notACommand != null) return html`<div class="command refused" role="status">Not a command: ${notACommand}</div>`;
    // Text copied with Vim keys, said where Vim says it: over the footer.
    if (this.#copied === "passage") return html`<div class="command copied" role="status">Copied</div>`;
    if (this.#copied === "why") return html`<div class="command why" role="status">${this.#why}</div>`;
    return nothing;
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

  // A picture of the book, not a glyph in running text (the emoji rule above) and not
  // the label of a link, which keeps opening its link.
  #isPicture(img) {
    return this.#strip.contains(img) && !img.closest("a") && !img.matches(":is(p, pre, li, td, th, blockquote) img");
  }

  #openFigure(img) {
    this.#figure = { src: img.currentSrc || img.src, alt: img.alt, turn: 0, zoom: 1, x: 0, y: 0 };
    this.#figurePointers.clear();
    this.#figureGesture = null;
    this.#lastTap = null;
    this.requestUpdate();
    // The keyboard goes with the eye, to the viewer; closing it gives the page back the
    // keyboard (#keepFocus), on the page it was on.
    this.updateComplete.then(() => this.renderRoot.querySelector(".figure .rotate")?.focus({ preventScroll: true }));
  }

  #closeFigure() {
    if (!this.#figure) return;
    this.#figure = null;
    this.#figurePointers.clear();
    this.#figureGesture = null;
    this.requestUpdate();
  }

  // A quarter turn clockwise, counted on from the last, so the fourth turn goes on to a
  // full circle rather than spinning back. Each turn starts from the fitted picture.
  #turnFigure() {
    const f = this.#figure;
    if (!f) return;
    Object.assign(f, { turn: f.turn + 1, zoom: 1, x: 0, y: 0 });
    this.requestUpdate();
  }

  // Zoom to z about a point given from the box's centre, so what is under the finger or
  // the pointer stays there, and keep the picture within the box.
  #zoomFigure(z, px = 0, py = 0) {
    const f = this.#figure;
    if (!f) return;
    const zoom = Math.min(ZOOM_MAX, Math.max(1, z));
    const k = zoom / f.zoom;
    f.x = px - (px - f.x) * k;
    f.y = py - (py - f.y) * k;
    f.zoom = zoom;
    this.#clampFigure();
    this.#paintFigure();
  }

  // The drawn picture, not the letterbox its element keeps around it: its size on screen
  // at fit, from its own size, the box and the turn, beside the box's.
  #drawn() {
    const box = this.renderRoot.querySelector(".figure");
    const img = box?.querySelector("img");
    if (!this.#figure || !img) return null;
    const w = box.clientWidth;
    const h = box.clientHeight;
    const odd = this.#figure.turn % 2 === 1;
    const [bw, bh] = odd ? [h, w] : [w, h];
    const nw = img.naturalWidth || bw;
    const nh = img.naturalHeight || bh;
    const fit = Math.min(bw / nw, bh / nh);
    const [sw, sh] = odd ? [nh * fit, nw * fit] : [nw * fit, nh * fit];
    return { w, h, sw, sh };
  }

  // The pan stops where the drawn picture's edge meets the box's.
  #clampFigure() {
    const f = this.#figure;
    const d = this.#drawn();
    if (!d) return;
    const mx = Math.max(0, (d.sw * f.zoom - d.w) / 2);
    const my = Math.max(0, (d.sh * f.zoom - d.h) / 2);
    f.x = Math.min(mx, Math.max(-mx, f.x));
    f.y = Math.min(my, Math.max(-my, f.y));
  }

  // Whether a point, from the box's centre, falls on the drawn picture.
  #onPicture(at) {
    const f = this.#figure;
    const d = this.#drawn();
    return Boolean(d) && Math.abs(at.x - f.x) <= (d.sw * f.zoom) / 2 && Math.abs(at.y - f.y) <= (d.sh * f.zoom) / 2;
  }

  // The turn, the zoom and the pan as the box's custom properties, set straight on it so a
  // finger's move needs no render.
  #paintFigure() {
    const f = this.#figure;
    const box = this.renderRoot.querySelector(".figure");
    if (!f || !box) return;
    box.style.setProperty("--turn", f.turn);
    box.style.setProperty("--zoom", f.zoom);
    box.style.setProperty("--x", `${f.x}px`);
    box.style.setProperty("--y", `${f.y}px`);
    box.toggleAttribute("data-odd", f.turn % 2 === 1);
    box.toggleAttribute("data-zoomed", f.zoom > 1);
  }

  // A point of the viewer from its centre, where zoom and pan are counted from.
  #fromCentre(box, x, y) {
    const r = box.getBoundingClientRect();
    return { x: x - (r.left + r.width / 2), y: y - (r.top + r.height / 2) };
  }

  #figureDown(e) {
    if (e.target.closest(".bar") || (e.button != null && e.button !== 0)) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    this.#figurePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const f = this.#figure;
    const points = [...this.#figurePointers.values()];
    if (points.length === 2) {
      const [a, b] = points;
      this.#figureGesture = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: f.zoom };
    } else if (points.length === 1) {
      const at = this.#fromCentre(e.currentTarget, e.clientX, e.clientY);
      this.#figureGesture = { kind: "tap", x0: e.clientX, y0: e.clientY, fx: f.x, fy: f.y, onPicture: this.#onPicture(at) };
    }
    e.currentTarget.toggleAttribute("data-moving", true);
  }

  #figureMove(e) {
    const p = this.#figurePointers.get(e.pointerId);
    const g = this.#figureGesture;
    if (!p || !g) return;
    p.x = e.clientX;
    p.y = e.clientY;
    const f = this.#figure;
    if (g.kind === "pinch") {
      const [a, b] = [...this.#figurePointers.values()];
      const mid = this.#fromCentre(e.currentTarget, (a.x + b.x) / 2, (a.y + b.y) / 2);
      this.#zoomFigure((g.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0, mid.x, mid.y);
      return;
    }
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (g.kind === "tap" && Math.hypot(dx, dy) > SLOP) g.kind = "pan";
    if (g.kind === "pan" && f.zoom > 1) {
      f.x = g.fx + dx;
      f.y = g.fy + dy;
      this.#clampFigure();
      this.#paintFigure();
    }
  }

  #figureUp(e) {
    if (!this.#figurePointers.delete(e.pointerId)) return;
    const g = this.#figureGesture;
    if (this.#figurePointers.size > 0) {
      // One finger of a pinch lifted: what is left is a pan from here, never a tap.
      const [rest] = this.#figurePointers.values();
      if (g?.kind === "pinch") this.#figureGesture = { kind: "pan", x0: rest.x, y0: rest.y, fx: this.#figure.x, fy: this.#figure.y };
      return;
    }
    this.#figureGesture = null;
    e.currentTarget.toggleAttribute("data-moving", false);
    if (e.type !== "pointerup" || g?.kind !== "tap") return;
    // A tap beside the picture closes the viewer; two taps on it go between the fitted
    // picture and twice that, about the place tapped.
    if (!g.onPicture) {
      this.#closeFigure();
      return;
    }
    const at = this.#fromCentre(e.currentTarget, e.clientX, e.clientY);
    const last = this.#lastTap;
    if (last && e.timeStamp - last.t < DOUBLE_TAP_MS && Math.hypot(at.x - last.x, at.y - last.y) < SWIPE) {
      this.#lastTap = null;
      this.#zoomFigure(this.#figure.zoom > 1 ? 1 : 2, at.x, at.y);
    } else this.#lastTap = { t: e.timeStamp, ...at };
  }

  // The wheel, and a Mac trackpad's pinch, which Chromium sends as a wheel with Ctrl.
  #figureWheel(e) {
    e.preventDefault();
    const f = this.#figure;
    const box = e.currentTarget;
    const at = this.#fromCentre(box, e.clientX, e.clientY);
    box.toggleAttribute("data-moving", true);
    this.#zoomFigure(f.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), at.x, at.y);
    clearTimeout(this.#wheelTimer);
    this.#wheelTimer = setTimeout(() => box.toggleAttribute("data-moving", false), 150);
  }

  // Safari's trackpad pinch. On a touch screen the same pinch also arrives as two
  // pointers, which already zoom, so then these only keep the page from zooming.
  #figureGestureEvent(e) {
    e.preventDefault();
    if (this.#figurePointers.size > 0 || !this.#figure) return;
    if (e.type === "gesturestart") this.#gestureZoom = this.#figure.zoom;
    else this.#zoomFigure(this.#gestureZoom * e.scale);
  }

  #figureView() {
    const f = this.#figure;
    if (!f) return nothing;
    return html`
      <div
        class="figure"
        role="dialog"
        aria-label="Picture"
        @pointerdown=${(e) => this.#figureDown(e)}
        @pointermove=${(e) => this.#figureMove(e)}
        @pointerup=${(e) => this.#figureUp(e)}
        @pointercancel=${(e) => this.#figureUp(e)}
        @wheel=${{ handleEvent: (e) => this.#figureWheel(e), passive: false }}
        @gesturestart=${(e) => this.#figureGestureEvent(e)}
        @gesturechange=${(e) => this.#figureGestureEvent(e)}
      >
        <img src=${f.src} alt=${f.alt} @load=${() => this.#clampFigure()} />
        <span class="bar">
          <button class="turn rotate" type="button" aria-label="Turn the picture" title="Turn" @click=${() => this.#turnFigure()}>
            ${icon("arrow-clockwise")}
          </button>
          <button class="turn close" type="button" aria-label="Close the picture" title="Close" @click=${() => this.#closeFigure()}>
            ${icon("x")}
          </button>
        </span>
      </div>
    `;
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
          @pointercancel=${() => this.#pointercancel()}
          @selectstart=${(e) => this.#noNative(e)}
          @contextmenu=${(e) => this.#noNative(e)}
          @dragstart=${(e) => this.#noNative(e)}
        >
          <div class="page" @pointerleave=${() => this.#unhover()}><span class="cursor" aria-hidden="true" hidden></span><div class="passage" aria-hidden="true"></div>${this.#sayButtons(snapshot)}${this.#handles(snapshot)}${this.#bubble(snapshot)}</div>
        </div>
        <div class="footer">
          <span class="chap">${title}</span>
          ${this.#speakControls(snapshot)}
          <span class="pageno">Page ${this.#page + 1} of ${this.#pages}</span>
          <span class="turns">
            <button class="turn" type="button" aria-label="Previous page" ?disabled=${atFirst} @click=${() => this.#prev()}>
              ${icon("caret-left")}
            </button>
            <button class="turn" type="button" aria-label="Next page" ?disabled=${atLast} @click=${() => this.#next()}>
              ${icon("caret-right")}
            </button>
          </span>
          ${this.#command(snapshot.context)}
        </div>
        ${this.#figureView()}
      </div>
    `;
  }
}

customElements.define("book-reader", BookReader);
