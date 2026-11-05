import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, chapterLabelOf, canStage, isStaged, vimAction, scrollFor, parseMarkdown, userParagraphs, pieces, lastAnswer, savedMarks, marks, highlightable, highlightsOf, notSynced, askedFor, lengthWords, dateWords, openingOf, shelfOf, spineOf } from "./machine.js";
import marksEdited from "./events/marks.edited.json" with { type: "json" };
import highlightsEdited from "./events/highlights.edited.json" with { type: "json" };
import relinked from "./events/conversation.relinked.json" with { type: "json" };
import staged from "./events/conversation.staged.json" with { type: "json" };
import noteStaged from "./events/note.staged.json" with { type: "json" };
import daySelected from "./events/day.selected.json" with { type: "json" };
import chapterSelected from "./events/chapter.selected.json" with { type: "json" };
import bookSelected from "./events/book.selected.json" with { type: "json" };
import passageSelected from "./events/passage.selected.json" with { type: "json" };
import lookupFollowed from "./events/lookup.followed.json" with { type: "json" };
import expertPicked from "./events/expert.picked.json" with { type: "json" };
import load from "./commands/load.json" with { type: "json" };

// The gap between a passage's last line and the comment box under it, in px; the box is
// placed in JS, so the value is not a style (7.4 covers styles).
const POPOVER_GAP = 6;
// How long a finger's selection must stay still before its comment box opens: a touch
// selection is adjusted with handles that send no pointer events, only selection changes.
const TOUCH_SETTLE_MS = 700;

// Whether the experts shelf is folded, kept in this browser (3.1) under the component's
// name; losing it only opens the shelf again. Wrapped, so a browser refusing storage
// reads it open and drops the write.
const FOLDED_KEY = "chat-thread.experts-folded";
const readFolded = () => {
  try {
    return localStorage.getItem(FOLDED_KEY) === "1";
  } catch {
    return false;
  }
};
const writeFolded = (folded) => {
  try {
    localStorage.setItem(FOLDED_KEY, folded ? "1" : "0");
  } catch {}
};

// The comments of an answer, numbered in reading order; its highlights carry no number.
const numberedOf = (marking) => (marking.highlights ? marking.list.filter((m) => !marking.highlights.has(m.id)) : marking.list);

// Section 10: a reactive controller is the home for attaching an actor to a view.
class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    // 4.1: a page may hold this view twice (the Chats panel and the stage), so each
    // mounts and asks under its own id.
    const instance = this.host.id || undefined;
    this.actor = mount(machine, {
      instance,
      commands: { load },
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload, instance),
        mint: ulid,
        // Parsed by the time hostConnected runs, so the actor is born knowing it.
        staged: this.host.hasAttribute("stage"),
      },
      events: { "marks.edited": marksEdited, "highlights.edited": highlightsEdited, "conversation.relinked": relinked, "conversation.staged": staged, "note.staged": noteStaged, "day.selected": daySelected, "chapter.selected": chapterSelected, "book.selected": bookSelected, "passage.selected": passageSelected, "lookup.followed": lookupFollowed, "expert.picked": expertPicked },
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

// A failed answer's `error` in plain words. Known short codes get a sentence; anything
// else — a rate limit, an overload, a provider's own 400 message — is shown as it came,
// so the reader always sees the real cause rather than a generic apology.
const errorText = (error) => {
  switch (error) {
    case "unavailable":
      return "The model could not be reached.";
    case "bad-key":
      return "Your API key was rejected.";
    case "signed-out":
      return "Sign in to chat.";
    case "no-key":
      return "Add your API key in Settings.";
    // Ollama on the user's own Mac did not answer (3.4); chat-input offers Try again.
    case "local-off":
      return "Ollama isn't running. Open the Ollama app, or get it at ollama.com.";
    case "busy":
      return "The model is finishing another answer — try again in a moment.";
    case "truncated":
      return "The answer was cut off — it reached the length limit.";
    case "refused":
      return "The model declined to answer.";
    case "too-many-lookups":
      return "Stopped after too many lookups — try a more specific question.";
    default:
      return error || "Something went wrong.";
  }
};

// How near the bottom counts as "at the bottom", so a small drift does not unstick the
// transcript while an answer streams. A length, but one that sizes nothing on the page,
// so it is a plain constant rather than a token (7.4).
const STICK_SLOP = 24;

class ChatThread extends LitElement {
  // The one attribute the tag understands: height="fill" makes the thread take the
  // height its container leaves, so a docked chat fills its dock and scrolls inside.
  static properties = {
    height: { type: String, reflect: true },
    // When set, an answer's markdown is rendered as formatting (10). Set first on the
    // chat stem page; it reaches the product page only after the owner approves it (9).
    markdown: { type: Boolean, reflect: true },
    // The chat the stage shows for a chat tab: it shows only what `load` names.
    stage: { type: Boolean, reflect: true },
  };

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    :host([height="fill"]) {
      flex: 1;
    }
    /* The experts shelf above a new chat: a heading that folds it, and the spines standing
       on a shelf line, each title running up its spine. The picked one is lifted and ringed
       in the accent; No expert is a dashed neutral spine. */
    .experts {
      flex: none;
      border-bottom: var(--border-width) solid var(--color-border);
      padding: var(--space-xs) var(--space-md) var(--space-sm);
    }
    .ex-head {
      display: flex;
      align-items: center;
      gap: var(--space-xs);
      appearance: none;
      border: 0;
      background: none;
      padding: var(--space-2xs) 0;
      cursor: pointer;
      font: inherit;
      font-size: var(--text-caption);
      line-height: var(--leading-normal);
      color: var(--color-body-mid);
      width: 100%;
      text-align: left;
      border-radius: var(--radius-sm);
    }
    .ex-head:hover {
      color: var(--color-ink);
    }
    .ex-head:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .ex-head svg {
      display: block;
      transition: transform var(--duration-fast) var(--ease);
    }
    .ex-head[aria-expanded="true"] svg {
      transform: rotate(90deg);
    }
    .ex-head .chosen {
      color: var(--color-ink);
      margin-left: var(--space-2xs);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ex-row {
      display: flex;
      gap: var(--space-xs);
      align-items: flex-end;
      overflow-x: auto;
      min-height: calc(var(--space-2xl) + var(--space-xl) + var(--space-md) - var(--space-2xs));
      padding: var(--space-sm) var(--space-2xs) 0;
      border-bottom: calc(var(--border-width) * 3) solid var(--color-border-strong);
    }
    .ex {
      flex: none;
      appearance: none;
      width: calc(var(--space-lg) + var(--space-sm) + var(--space-2xs));
      height: calc(var(--space-2xl) + var(--space-lg) + var(--space-xs));
      border: 0;
      padding: var(--space-sm) 0;
      border-radius: var(--radius-sm) var(--radius-sm) var(--space-2xs) var(--space-2xs);
      cursor: pointer;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font: inherit;
      font-size: calc(var(--text-caption) - var(--space-2xs));
      font-weight: var(--weight-semibold);
      line-height: var(--leading-tight);
      /* Dark text in both schemes: on every feature colour it reads far better than white. */
      color: light-dark(var(--color-ink), var(--color-canvas));
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      transition: transform var(--duration-fast) var(--ease);
    }
    .ex.h1 {
      height: calc(var(--space-2xl) + var(--space-lg) + var(--space-xs) + var(--space-2xs) * 3);
    }
    .ex.h2 {
      height: calc(var(--space-2xl) + var(--space-lg) + var(--space-xs) + var(--space-2xs) * 5);
    }
    .ex.h3 {
      height: calc(var(--space-2xl) + var(--space-lg) + var(--space-xs) + var(--space-2xs) * 8);
    }
    .ex.c0 { background: var(--color-feature-journal); }
    .ex.c1 { background: var(--color-feature-reading); }
    .ex.c2 { background: var(--color-feature-highlights); }
    .ex.c3 { background: var(--color-feature-notes); }
    .ex.c4 { background: var(--color-feature-chats); }
    .ex.c5 { background: var(--color-feature-evaluators); }
    .ex.c6 { background: var(--color-feature-choice); }
    .ex.c7 { background: var(--color-feature-values); }
    .ex.none {
      height: calc(var(--space-2xl) + var(--space-lg) - var(--space-2xs));
      background: var(--color-canvas-soft);
      color: var(--color-body-mid);
      border: var(--border-width) dashed var(--color-border-strong);
      font-weight: var(--weight-normal);
    }
    .ex:hover,
    .ex[aria-pressed="true"] {
      transform: rotate(180deg) translateY(var(--space-sm));
    }
    .ex[aria-pressed="true"] {
      box-shadow: 0 0 0 var(--space-2xs) var(--color-canvas), 0 0 0 var(--space-xs) var(--color-accent);
    }
    .ex:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .ex[aria-pressed="true"]:focus-visible {
      box-shadow: 0 0 0 var(--space-2xs) var(--color-canvas), 0 0 0 var(--space-xs) var(--color-accent);
    }
    /* The header: the chapter label at the left. */
    /* Open on stage: muted, accent while the chat has a tab on the stage, as the note
       editor draws it. One icon, sized by the body type. */
    button.open {
      flex: none;
      display: inline-flex;
      appearance: none;
      background: none;
      border: var(--border-width) solid transparent;
      border-radius: var(--radius-sm);
      padding: var(--space-2xs);
      margin: 0 0 0 auto;
      font: inherit;
      font-size: var(--text-body);
      cursor: pointer;
      color: var(--color-body-mid);
    }
    button.open svg {
      display: block;
    }
    /* The arrow points towards the stage: up-left from a dock right of the middle. */
    button.open.mirrored svg {
      transform: scaleX(-1);
    }
    button.open:hover:not(:disabled):not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    button.open[aria-pressed="true"] {
      color: var(--color-accent);
    }
    button.open:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    button.open:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .header {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-md) 0;
    }
    /* The chapter label, as the note editor draws it: plain muted text naming the
       chapter the chat is linked to, its Link or Unlink button shown only while the pointer
       or the keyboard is on the label. Hidden, the button keeps its room, and the header
       keeps its height whether or not the label shows, so the transcript never jumps. A tap
       on a phone puts the keyboard on the label, which shows the button. */
    .place {
      flex: 1;
      min-width: 0;
      display: flex;
      min-height: calc(var(--text-caption) * var(--leading-tight) + 2 * var(--border-width));
    }
    .chapter {
      flex: 0 1 auto;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      color: var(--color-mute);
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      white-space: nowrap;
      outline: none;
    }
    .chapter > span {
      flex: 0 10 auto;
    }
    .chapter > span,
    .relink {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .relink {
      flex: 0 1 auto;
      appearance: none;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-sm);
      padding: 0 var(--space-2xs);
      margin: 0;
      background: transparent;
      color: var(--color-body-mid);
      font: inherit;
      white-space: nowrap;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
    }
    /* The whole line is the label's hover area, so a button that turns narrower under
       the pointer (Link to … into Unlink) stays shown and pressing again reverses it. */
    .place:hover .relink,
    .place:focus-within .relink {
      opacity: 1;
      pointer-events: auto;
    }
    .relink:hover {
      color: var(--color-ink);
    }
    .relink:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The transcript scrolls inside its own box so the question box below stays in
       view and the page never scrolls. */
    .transcript {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: var(--space-md);
      padding: var(--space-md);
    }
    /* The frame that says the keyboard is on the conversation, drawn inside its edge: the
       panel around it clips anything outside, on the phone. It is a layer over the box,
       not the box's own outline: an answer is positioned and its comment box sits above
       it, so either, scrolled under the edge, painted over the outline. The layer sits
       in its own positioned box after the transcript, so it paints above what the
       transcript holds, stays put while it scrolls, and lets every press through. */
    .frame {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .transcript:focus-visible {
      outline: none;
    }
    .frame:has(> .transcript:focus-visible)::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
      border: calc(2 * var(--border-width)) solid var(--color-accent);
    }
    .composer {
      flex: none;
      border-top: var(--border-width) solid var(--color-border);
    }
    /* The reader's own message: a bubble at the trailing edge, so the two voices read
       apart at a glance. */
    .turn.user {
      align-self: flex-end;
      max-width: 85%;
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-md);
      background: var(--color-accent-subtle);
      color: var(--color-ink);
      overflow-wrap: anywhere;
    }
    .turn.user .para {
      margin: 0;
      white-space: pre-wrap;
    }
    /* The editor kit's gap (10), so a message shows here as it did in the box. */
    .turn.user .gap {
      height: calc((var(--space-sm) + var(--space-md)) / 2);
    }
    /* The model's answer, across the width. Without the markdown attribute it is plain
       text with its line breaks kept; with it (10) the same text is rendered as
       formatting by the prose rules below. */
    .turn.assistant {
      align-self: stretch;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      color: var(--color-body);
    }
    .answer {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    /* A rendered answer (10): blocks stacked with breathing room, its own white-space so
       the source line breaks between blocks do not double up. Type and spacing are tokens
       only (7.4); every text run is an escaped Lit text node, never model HTML. */
    .answer.prose {
      white-space: normal;
      display: flex;
      flex-direction: column;
      gap: var(--space-sm);
      line-height: var(--leading-normal);
    }
    .answer.prose .md-p {
      margin: 0;
    }
    .answer.prose .md-h {
      margin: 0;
      line-height: var(--leading-tight);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    .answer.prose h1.md-h {
      font-size: var(--text-heading);
    }
    .answer.prose h2.md-h {
      font-size: var(--text-subtitle);
    }
    .answer.prose h3.md-h,
    .answer.prose h4.md-h,
    .answer.prose h5.md-h,
    .answer.prose h6.md-h {
      font-size: var(--text-body);
    }
    .answer.prose .md-list {
      margin: 0;
      padding-left: var(--space-lg);
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .answer.prose .md-quote {
      margin: 0;
      padding-left: var(--space-sm);
      border-left: var(--border-width) solid var(--color-border-strong);
      color: var(--color-body-mid);
    }
    .answer.prose .md-code {
      margin: 0;
      padding: var(--space-sm);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
      overflow-x: auto;
      font-family: var(--font-mono);
      font-size: var(--text-sm);
    }
    .answer.prose .md-code code {
      font-family: inherit;
    }
    .answer.prose .md-code-inline {
      padding: 0 var(--space-2xs);
      background: var(--color-canvas-soft);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: var(--text-sm);
    }
    .answer.prose strong {
      font-weight: var(--weight-semibold);
    }
    .answer.prose .md-rule {
      margin: 0;
      border: 0;
      border-top: var(--border-width) solid var(--color-border);
    }
    .answer.prose .md-table {
      overflow-x: auto;
    }
    .answer.prose table {
      border-collapse: collapse;
      font-size: var(--text-sm);
    }
    .answer.prose th,
    .answer.prose td {
      border: var(--border-width) solid var(--color-border);
      padding: var(--space-xs) var(--space-sm);
      text-align: left;
      vertical-align: top;
    }
    .answer.prose th {
      background: var(--color-canvas-soft);
      font-weight: var(--weight-semibold);
      color: var(--color-ink);
    }
    /* An answer holds its comment box or its highlight's bubble, placed inside it. */
    .turn.assistant {
      position: relative;
    }
    /* A commented passage: the marker yellow books use (7.4), with its number raised
       after it. The one being written carries the accent underline; one in its undo
       window fades. */
    mark {
      background: var(--color-highlight);
      color: inherit;
      border-radius: var(--radius-sm);
      box-decoration-break: clone;
      -webkit-box-decoration-break: clone;
    }
    .markable mark,
    mark.hl {
      cursor: pointer;
    }
    mark.open {
      box-shadow: inset 0 calc(var(--border-width) * -2) 0 var(--color-accent);
    }
    sup.num {
      padding-left: var(--space-2xs);
      font-size: var(--text-caption);
      font-weight: var(--weight-semibold);
      line-height: 0;
      color: var(--color-accent);
      user-select: none;
      -webkit-user-select: none;
    }
    /* The comments under the answer: number, the passage, the comment. */
    .comments {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      font-size: var(--text-sm);
    }
    .comments li {
      display: flex;
      align-items: flex-start;
      gap: var(--space-xs);
      padding: var(--space-xs) var(--space-sm);
      border-radius: var(--radius-sm);
      background: var(--color-canvas-soft);
    }
    .comments .n {
      flex: none;
      font-weight: var(--weight-semibold);
      color: var(--color-accent);
    }
    .comments .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
    }
    .comments .quote {
      color: var(--color-body-mid);
      overflow: hidden;
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .comments .text {
      appearance: none;
      margin: 0;
      padding: 0;
      border: 0;
      background: none;
      font: inherit;
      text-align: left;
      color: var(--color-ink);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    button.text {
      cursor: pointer;
    }
    button.text:hover {
      text-decoration: underline;
    }
    .comments .removed {
      color: var(--color-body-mid);
    }
    .act {
      flex: none;
      appearance: none;
      font: inherit;
      cursor: pointer;
      border: 0;
      border-radius: var(--radius-sm);
      padding: 0 var(--space-2xs);
      background: transparent;
      color: var(--color-body-mid);
    }
    .act:hover {
      color: var(--color-danger);
      background: var(--color-surface-hover);
    }
    .act:focus-visible,
    button.text:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The comment box: under the passage's last line, placed by --bx/--by set in JS. */
    .popover {
      position: absolute;
      top: 0;
      left: 0;
      translate: var(--bx, 0) var(--by, 0);
      z-index: 1;
      box-sizing: border-box;
      width: calc(var(--space-2xl) * 5);
      max-width: 100%;
      display: flex;
      align-items: flex-start;
      gap: var(--space-2xs);
      padding: var(--space-xs);
      background: var(--color-canvas);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-card);
    }
    /* One line to start, growing with what is typed (#fit sets --h). */
    .popover textarea {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      height: var(--h, auto);
      overflow: hidden;
      resize: none;
      border: 0;
      outline: none;
      background: transparent;
      font: inherit;
      font-size: var(--text-sm);
      line-height: var(--leading-normal);
      color: var(--color-ink);
      padding: var(--space-2xs) var(--space-xs);
    }
    .popover .remove {
      display: inline-flex;
      padding: var(--space-2xs);
      color: var(--color-mute);
    }
    /* A highlight's bubble: one action, Remove. */
    .popover.bubble {
      width: auto;
      align-items: center;
      padding: var(--space-2xs);
      font-size: var(--text-sm);
    }
    .bubble .act {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2xs);
      padding: var(--space-2xs) var(--space-xs);
    }
    /* A message sent with comments says so above its text. */
    .turn.user .sent-marks {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-body-mid);
    }
    /* The waiting line before any text: a neutral pulse while the model works, and the
       word "Thinking" only when the model is actually thinking (not while it merely
       processes the request). */
    .working {
      margin: 0;
      color: var(--color-mute);
      font-size: var(--text-sm);
    }
    .dots {
      display: inline-block;
      animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 0.3;
      }
      50% {
        opacity: 1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .dots {
        animation: none;
      }
    }
    /* What the model did, as records (12, 7.7): its thinking and each lookup, one quiet
       column of closed lines that each open on their own. One rule set for every kind,
       so a turn with thinking and three lookups reads as one list of four. */
    .records {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .record summary {
      cursor: pointer;
      list-style: none;
      display: inline-flex;
      gap: var(--space-xs);
      align-items: baseline;
      border-radius: var(--radius-sm);
      padding: 0 var(--space-xs);
      margin-left: calc(-1 * var(--space-xs));
      color: var(--color-body-mid);
      /* A click toggles the record; it must not select the label as a side effect. */
      user-select: none;
      -webkit-user-select: none;
    }
    .record summary::-webkit-details-marker {
      display: none;
    }
    .record summary::before {
      content: "›";
      display: inline-block;
      transition: transform var(--duration-fast) var(--ease);
    }
    .record[open] summary::before {
      transform: rotate(90deg);
    }
    .record summary:hover {
      background: var(--color-surface-hover);
      color: var(--color-body);
    }
    .record summary:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .record .opened {
      margin: var(--space-xs) 0 var(--space-sm) var(--space-md);
      padding-left: var(--space-md);
      border-left: var(--border-width) solid var(--color-border);
      color: var(--color-body);
      overflow-wrap: anywhere;
    }
    .thinking .opened {
      white-space: pre-wrap;
      color: var(--color-body-mid);
    }
    /* A lookup opens to say what was asked for and what came back (7.7). */
    .got {
      display: grid;
      gap: var(--space-xs);
    }
    .got dt {
      font-size: var(--text-caption);
      color: var(--color-body-mid);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .got dd {
      margin: 0;
    }
    .got .items {
      display: grid;
      gap: var(--space-2xs);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    /* A name that opens what it names: drawn as a link (7.7), a button so Tab reaches it. */
    .got .open {
      font: inherit;
      color: var(--color-accent);
      background: none;
      border: 0;
      padding: 0;
      cursor: pointer;
      text-align: start;
      text-decoration: underline;
      text-underline-offset: var(--space-2xs);
      border-radius: var(--radius-sm);
    }
    .got .open:hover {
      color: var(--color-ink);
    }
    .got .open:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .got .excerpt {
      color: var(--color-body-mid);
    }
    .got .more {
      color: var(--color-body-mid);
      font-size: var(--text-caption);
    }
    .got .err {
      color: var(--color-danger);
    }
    @media (prefers-reduced-motion: reduce) {
      .record summary::before {
        transition: none;
      }
    }
    /* A finished answer's footer: a status word when the answer was stopped or failed. */
    .foot {
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .status.failed {
      color: var(--color-danger);
    }
    /* The chat's finished turns have waited too long for the server (5): a quiet caption
       so the reader knows not to close the page yet. */
    .unsaved {
      margin: 0;
      font-size: var(--text-caption);
      color: var(--color-mute);
    }
    .offline {
      margin: auto;
      padding: var(--space-md);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
      text-align: center;
    }
  `;

  #actor = new ActorController(this);
  // Which thinking records are open (ephemeral view state, closed by default).
  #openThinking = new Set();
  // Which lookup lines are open, by call id (ephemeral view state, closed by default).
  #openLookups = new Set();
  // Whether the transcript is pinned to the bottom, so it follows a streaming answer
  // but leaves the reader where they scrolled if they scrolled up.
  #stick = true;
  // The pointer that pressed last on the last answer, and the comment box last focused.
  #pointer = null;
  #focused = null;
  #settle;
  // The results of the chat being drawn, by call id, gathered once per render.
  #results = new Map();
  // Answers parsed once per text, not per keystroke in the comment box.
  #parsed = new Map();

  #onSelectionChange = () => {
    if (this.#pointer !== "touch") return;
    clearTimeout(this.#settle);
    this.#settle = setTimeout(() => this.#sendSelection(), TOUCH_SETTLE_MS);
  };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener("selectionchange", this.#onSelectionChange);
    this.addEventListener("keydown", this.#onBoxEscape);
    this.#resized.observe(this);
    globalThis.addEventListener("resize", this.#place);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("selectionchange", this.#onSelectionChange);
    this.removeEventListener("keydown", this.#onBoxEscape);
    this.#resized.disconnect();
    globalThis.removeEventListener("resize", this.#place);
    clearTimeout(this.#settle);
  }

  #onScroll(event) {
    const el = event.currentTarget;
    this.#stick = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLOP;
  }

  updated() {
    // A desk layout change (dock.changed counted in `layouts`) may move the dock without a resize.
    this.#place();
    this.#afterComment();
    if (!this.#stick) return;
    const el = this.renderRoot.querySelector(".transcript");
    if (el) el.scrollTop = el.scrollHeight;
  }

  #toggleLookup(id) {
    if (this.#openLookups.has(id)) this.#openLookups.delete(id);
    else this.#openLookups.add(id);
    this.requestUpdate();
  }

  #toggleThinking(id) {
    if (this.#openThinking.has(id)) this.#openThinking.delete(id);
    else this.#openThinking.add(id);
    this.requestUpdate();
  }

  #box() {
    return this.renderRoot?.querySelector("slot")?.assignedElements()[0] ?? null;
  }

  // Vim keys on the conversation (12, "Vim keys"): only while the preference is on and
  // never in the comment box, where a letter is typed text. gg is two presses, so a first
  // g waits a moment for the second, as in the lists.
  #gAt = 0;
  #transcriptKey(event) {
    if (this.#actor.snapshot?.context.vimKeys !== true) return;
    if (event.isComposing) return;
    const target = event.composedPath()[0];
    if (target?.isContentEditable || ["INPUT", "TEXTAREA"].includes(target?.tagName)) return;
    const afterG = event.key === "g" && Date.now() - this.#gAt < 1000;
    const action = vimAction(event, afterG);
    this.#gAt = action === "g" ? Date.now() : 0;
    if (!action) return;
    event.preventDefault();
    if (action === "g") return;
    // i hands the keyboard to the box slotted below in Vim's insert mode, the way a
    // container focuses its child (list-then-item); the box decides whether it can type.
    if (action === "type") return this.#box()?.focus({ insert: true });
    const el = event.currentTarget;
    const style = getComputedStyle(el);
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const top = scrollFor(action, { top: el.scrollTop, height: el.clientHeight, max: el.scrollHeight - el.clientHeight, line });
    if (top != null) el.scrollTop = top;
  }

  // An Escape the box left unhandled (Vim's normal mode: the first Escape after typing
  // leaves insert mode and is used there) comes back to the conversation, and is used
  // here so list-then-item does not take it as Back. Without Vim keys it stays Back.
  #onBoxEscape = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (this.#actor.snapshot?.context.vimKeys !== true) return;
    const box = this.#box();
    if (!box || !event.composedPath().includes(box)) return;
    const transcript = this.renderRoot.querySelector(".transcript");
    if (!transcript) return;
    event.preventDefault();
    transcript.focus({ preventScroll: true });
  };

  // dock-desk's Ctrl+h/j/k/l (12) and list-then-item focus a panel by its host: land
  // in the box the page slotted below the transcript, where the next question is typed.
  focus(options) {
    const box = this.#box();
    if (box) box.focus(options);
    else super.focus(options);
  }

  // The experts shelf (machine.js: shelfOf decides whether it shows and what is picked).
  #folded = readFolded();

  #fold() {
    this.#folded = !this.#folded;
    writeFolded(this.#folded);
    this.requestUpdate();
  }

  // A pick lands the keyboard in the box below, where the first question is typed.
  #pick(book) {
    this.#actor.send({ type: "_pick", book });
    this.#box()?.focus();
  }

  // The spines are one stop of Tab (the picked one); the arrows, and h and l with Vim keys,
  // move along them, never past either end (12, "Vim keys").
  #shelfKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const vim = this.#actor.snapshot?.context.vimKeys === true;
    const step = { ArrowLeft: -1, ArrowRight: 1, ...(vim ? { h: -1, l: 1 } : {}) }[event.key];
    if (!step) return;
    const spines = [...event.currentTarget.querySelectorAll(".ex")];
    const at = spines.indexOf(this.renderRoot.activeElement);
    if (at < 0) return;
    event.preventDefault();
    spines[Math.max(0, Math.min(spines.length - 1, at + step))].focus();
  }

  #shelf(snapshot) {
    const shelf = snapshot ? shelfOf(snapshot) : null;
    if (!shelf) return nothing;
    const picked = shelf.items.find((x) => x.book === shelf.picked) ?? null;
    return html`<div class="experts">
      <button class="ex-head" type="button" aria-expanded=${this.#folded ? "false" : "true"} aria-controls="ex-row" @click=${() => this.#fold()}>
        ${icon("caret-right")}Book experts${picked ? html`<span class="chosen">· ${picked.title}</span>` : nothing}
      </button>
      ${this.#folded
        ? nothing
        : html`<div class="ex-row" id="ex-row" role="group" aria-label="Book experts" @keydown=${(e) => this.#shelfKey(e)}>
            <button
              class="ex none"
              type="button"
              aria-pressed=${picked ? "false" : "true"}
              aria-label="No expert, a plain chat"
              tabindex=${picked ? "-1" : "0"}
              @click=${() => this.#pick(null)}
            >
              No expert
            </button>
            ${shelf.items.map((x) => {
              const spine = spineOf(x.book, x.title);
              const on = x.book === shelf.picked;
              return html`<button
                class=${`ex c${spine.colour}${spine.height ? ` h${spine.height}` : ""}`}
                type="button"
                aria-pressed=${on ? "true" : "false"}
                aria-label=${`Expert on ${x.title}`}
                title=${x.title}
                tabindex=${on ? "0" : "-1"}
                @click=${() => this.#pick(x.book)}
              >
                ${x.title}
              </button>`;
            })}
          </div>`}
    </div>`;
  }

  render() {
    const snapshot = this.#actor.snapshot;
    return html`
      ${this.#shelf(snapshot)}
      ${this.#header(snapshot)}
      <div class="frame">
        <div
          class="transcript"
          tabindex="0"
          role="region"
          aria-label="Conversation"
          @keydown=${(e) => this.#transcriptKey(e)}
          @scroll=${(e) => this.#onScroll(e)}
          @pointerdown=${(e) => this.#pointerdown(e)}
          @pointerup=${(e) => this.#pointerup(e)}
        >
          ${this.#body(snapshot)}
        </div>
      </div>
      <div class="composer"><slot></slot></div>
    `;
  }

  // The header: the chapter label (12), and, outside the stage, Open on stage. It is
  // disabled until the chat has its first message; its label names the action for
  // assistive tech, and says Show while the chat has a tab there.
  #header(snapshot) {
    if (!snapshot) return nothing;
    const { context } = snapshot;
    const onStage = isStaged(context);
    const label = `${onStage ? "Show on stage" : "Open on stage"}${context.vimKeys ? " (:tab split)" : ""}`;
    return html`
      <div class="header">
        <div class="place">${this.#chapter(chapterLabelOf(snapshot))}</div>
        ${context.staged
          ? nothing
          : html`<button
              class=${this.#mirrored ? "open mirrored" : "open"}
              type="button"
              aria-pressed=${onStage}
              aria-label=${label}
              title=${label}
              ?disabled=${!canStage(context)}
              @mousedown=${(e) => e.preventDefault()}
              @click=${() => this.#actor.send({ type: "_stage" })}
            >
              ${icon("arrow-square-out")}
            </button>`}
      </div>
    `;
  }

  // Whether the arrow is mirrored: layout reading only. The left edge, not the centre,
  // tells a dock right of the middle, as the note editor reads it.
  #mirrored = false;
  #resized = new ResizeObserver(() => this.#place());
  #place = () => {
    const mirrored = this.getBoundingClientRect().left >= globalThis.innerWidth / 2;
    if (mirrored === this.#mirrored) return;
    this.#mirrored = mirrored;
    this.requestUpdate();
  };

  // The chapter label (machine.js: chapterLabelOf decides what it says and offers).
  #chapter(label) {
    if (!label) return nothing;
    return html`<span class="chapter" tabindex=${label.action ? "-1" : nothing}
      ><span>${label.text}</span>${label.action
        ? html`<button
            class="relink"
            type="button"
            title=${label.action}
            @mousedown=${(e) => e.preventDefault()}
            @click=${() => this.#actor.send({ type: "_relink" })}
          >
            ${label.action}
          </button>`
        : nothing}</span
    >`;
  }

  #body(snapshot) {
    if (!snapshot) return nothing;
    if (snapshot.matches("unavailable")) return html`<p class="offline">Chats need a connection.</p>`;
    const { context } = snapshot;
    const chat = context.conversation;
    const turns = chat?.turns ?? [];
    const last = snapshot.matches("showing") ? lastAnswer(chat) : null;
    // A lookup's result rides the user turn after the call (7.7), by its call id.
    this.#results = new Map();
    for (const t of turns) for (const r of t.results ?? []) this.#results.set(r.callId, r);
    return html`
      ${turns.map((turn, k) => {
        if (turn.role === "user") return this.#user(turn);
        if (turn === last) return this.#assistant(turn, this.#editable(snapshot));
        // An answer whose comments went with the next message shows them read only.
        const next = turns[k + 1];
        const sent = next?.role === "user" && next.marks?.length ? [...next.marks].sort((a, b) => a.start - b.start) : null;
        if (snapshot.matches("showing") && highlightable(chat, turn.id)) return this.#assistant(turn, this.#highlighting(snapshot, turn.id, sent ?? []));
        return this.#assistant(turn, sent ? { list: sent, comments: sent, markable: false } : null);
      })}
      ${notSynced(context) ? html`<p class="unsaved">Not synced</p>` : nothing}
    `;
  }

  // What the last answer paints: every comment and the one being written, and the
  // saved ones listed under it, the open one as it is being typed; and its highlights.
  #editable(snapshot) {
    const { context } = snapshot;
    const draft = snapshot.matches({ showing: "commenting" }) ? context.draft : null;
    const answerId = lastAnswer(context.conversation)?.id;
    const byStart = (a, b) => a.start - b.start;
    const own = highlightsOf(context.conversation, answerId);
    const list = [...marks({ conversation: context.conversation, draft }), ...own].sort(byStart);
    const comments = savedMarks(context.conversation).map((m) => (m.id === draft?.id ? { ...m, comment: draft.comment } : m)).sort(byStart);
    const highlights = new Set(own.map((h) => h.id));
    const chosen = highlights.has(context.chosen) ? context.chosen : null;
    return { list, comments, markable: true, selectable: true, draft, highlights, chosen };
  }

  // What an earlier answer paints: its highlights, beside
  // the comments that went with the next message, which stay numbered and read only.
  #highlighting(snapshot, answerId, sent) {
    const { context } = snapshot;
    const own = highlightsOf(context.conversation, answerId);
    const list = [...sent, ...own].sort((a, b) => a.start - b.start);
    const chosen = own.some((h) => h.id === context.chosen) ? context.chosen : null;
    return { list, comments: sent, markable: false, selectable: true, highlights: new Set(own.map((h) => h.id)), chosen };
  }

  // The reader's own message. A turn that only carries tool results has no text (7.7): it
  // is for the model, not the reader, so it shows nothing rather than an empty bubble.
  // One sent with comments says how many, even with no text of its own.
  #user(turn) {
    const count = turn.marks?.length ?? 0;
    if (!turn.text && !count) return nothing;
    return html`<div class="turn user">
      ${count ? html`<p class="sent-marks">${count === 1 ? "1 comment" : `${count} comments`} on the answer above</p>` : nothing}
      ${turn.text
        ? userParagraphs(turn.text).map((block) => (block ? html`<p class="para">${block}</p>` : html`<div class="gap"></div>`))
        : nothing}
    </div>`;
  }

  #assistant(turn, marking = null) {
    const pending = turn.status === "pending";
    const hasText = Boolean(turn.text);
    // Before any text: a neutral pulse, or "Thinking…" only when the model is really
    // thinking (12: a live line says what the model is doing).
    const waiting =
      pending && !hasText
        ? turn.thinking
          ? html`<p class="working">Thinking…</p>`
          : html`<p class="working"><span class="dots">● ● ●</span></p>`
        : nothing;
    this.#marking = marking;
    const markable = Boolean(marking?.markable);
    const selectable = Boolean(marking?.selectable);
    const cls = `answer${this.markdown ? " prose" : ""}${markable ? " markable" : ""}`;
    const answer = hasText
      ? html`<div class=${cls} data-answer=${selectable ? turn.id : nothing}>
          ${this.markdown ? this.#parse(turn.text).map((block) => this.#block(block)) : this.#run(turn.text, 0)}
        </div>`
      : nothing;
    const out = html`
      <div class="turn assistant${markable ? " last" : ""}">
        ${this.#records(turn, pending && !hasText)}
        ${waiting}
        ${answer}
        ${this.#foot(turn)}
        ${marking ? this.#comments(marking) : nothing}
        ${marking?.draft ? this.#popover(marking.draft, marking) : nothing}
        ${marking?.chosen ? this.#bubble(marking) : nothing}
      </div>
    `;
    this.#marking = null;
    return out;
  }

  #parse(text) {
    let blocks = this.#parsed.get(text);
    if (!blocks) {
      if (this.#parsed.size > 100) this.#parsed.clear();
      blocks = parseMarkdown(text);
      this.#parsed.set(text, blocks);
    }
    return blocks;
  }

  // What this answer did, as one column of records: its thinking, once the live
  // "Thinking…" line has given way, then each lookup it asked for (7.7). A call the
  // system did not recognise (`invalid`) is not named as a lookup — it was rejected, not
  // run.
  #records(turn, live) {
    const thinking = turn.thinking && !live;
    const named = (turn.calls ?? []).filter((call) => !call.invalid);
    if (!thinking && !named.length) return nothing;
    return html`<div class="records">
      ${thinking ? this.#thinking(turn) : nothing}${named.map((call) => this.#lookup(call))}
    </div>`;
  }

  // One lookup line: closed, its label; open, what was asked for and what came back. A
  // result not yet back shows only what was asked for.
  #lookup(call) {
    const open = this.#openLookups.has(call.id);
    const result = this.#results.get(call.id);
    const asked = askedFor(call.payload);
    return html`
      <details
        class="record lookup"
        ?open=${open}
        @toggle=${(e) => {
          if (e.currentTarget.open !== open) this.#toggleLookup(call.id);
        }}
      >
        <summary>${call.label}</summary>
        ${open
          ? html`<dl class="opened got">
              ${asked ? html`<dt>Asked for</dt><dd>${asked}</dd>` : nothing}
              ${result ? this.#got(result) : nothing}
            </dl>`
          : nothing}
      </details>
    `;
  }

  #got(result) {
    if (result.isError) return html`<dt>Got</dt><dd class="err">Nothing: this lookup failed, and the chat was told.</dd>`;
    const length = html`<dd class="more">${lengthWords(result.size)}</dd>`;
    if (result.items || result.count !== undefined) {
      const items = result.items ?? [];
      const count = result.count ?? items.length;
      const of = result.total !== undefined ? `${count} of ${result.total}` : String(count);
      return html`<dt>Got</dt>
        ${items.length ? html`<dd><ul class="items">${items.map((item) => html`<li>${this.#named(item, dateWords(item.name))}${item.excerpt ? html` <span class="excerpt">${item.excerpt}</span>` : nothing}</li>`)}</ul></dd>` : nothing}
        <dd class="more">${of} · ${lengthWords(result.size)}</dd>`;
    }
    if (result.name) {
      return html`<dt>Got</dt><dd>${this.#named(result, result.name)}</dd>
        ${result.excerpt ? html`<dd>“${result.excerpt}”</dd>` : nothing}
        ${length}`;
    }
    return html`<dt>Got</dt>${length}`;
  }

  // A name in an opened lookup: a link that opens what it names (7.7), or plain text
  // when there is nothing it can open.
  #named(thing, text) {
    if (!openingOf(thing)) return text;
    return html`<button
      class="open"
      type="button"
      @click=${() => this.#actor.send({ type: "_open", opens: thing.opens, id: thing.id, chapter: thing.chapter })}
    >${text}</button>`;
  }

  // One markdown block (10). Every text run interpolates through Lit as an escaped text
  // node, so nothing the model wrote reaches the page as HTML; only these known tags are
  // real elements. A heading uses its own level's tag for meaning; the level is bounded to
  // 1–6 by the parser.
  #block(block) {
    switch (block.type) {
      case "heading":
        return this.#heading(block);
      case "list": {
        const items = block.items.map((item) => html`<li>${item.blocks.map((b) => this.#block(b))}</li>`);
        return block.ordered ? html`<ol class="md-list" start=${block.start}>${items}</ol>` : html`<ul class="md-list">${items}</ul>`;
      }
      case "quote":
        return html`<blockquote class="md-quote">${block.blocks.map((b) => this.#block(b))}</blockquote>`;
      case "code":
        return html`<pre class="md-code"><code>${block.lines.map((l, k) => [k ? "\n" : "", this.#run(l.value, l.s)])}</code></pre>`;
      case "rule":
        return html`<hr class="md-rule" />`;
      case "table":
        return html`<div class="md-table">
          <table>
            <thead><tr>${block.head.map((cell) => html`<th>${this.#inline(cell)}</th>`)}</tr></thead>
            <tbody>${block.rows.map((row) => html`<tr>${row.map((cell) => html`<td>${this.#inline(cell)}</td>`)}</tr>`)}</tbody>
          </table>
        </div>`;
      default:
        return html`<p class="md-p">${this.#inline(block.inline)}</p>`;
    }
  }

  #heading(block) {
    const inner = this.#inline(block.inline);
    switch (block.level) {
      case 1:
        return html`<h1 class="md-h">${inner}</h1>`;
      case 2:
        return html`<h2 class="md-h">${inner}</h2>`;
      case 3:
        return html`<h3 class="md-h">${inner}</h3>`;
      case 4:
        return html`<h4 class="md-h">${inner}</h4>`;
      case 5:
        return html`<h5 class="md-h">${inner}</h5>`;
      default:
        return html`<h6 class="md-h">${inner}</h6>`;
    }
  }

  #inline(nodes) {
    return nodes.map((node) => {
      switch (node.type) {
        case "break":
          return html`<br />`;
        case "code":
          return html`<code class="md-code-inline">${this.#run(node.value, node.s)}</code>`;
        case "strong":
          return html`<strong>${this.#inline(node.inline)}</strong>`;
        case "em":
          return html`<em>${this.#inline(node.inline)}</em>`;
        default:
          return this.#run(node.value, node.s);
      }
    });
  }

  // The comments of the answer being drawn, set by #assistant for its own runs.
  #marking = null;

  // One text run. In the last answer, a span per piece carries its offset in the answer,
  // so a selection maps back to the text; a commented piece sits in its mark, the
  // comment's number raised after its last piece. Every run is an escaped text node.
  #run(value, s) {
    const marking = this.#marking;
    if (!marking) return value;
    const list = marking.list;
    return pieces(value, s, list).map((p) => {
      const text = marking.selectable ? html`<span data-s=${p.s}>${p.text}</span>` : p.text;
      if (!p.id) return text;
      // A highlight carries no number; it is the user's own, not a comment.
      if (marking.highlights?.has(p.id)) {
        const state = p.id === marking.chosen ? " open" : "";
        return html`<mark data-id=${p.id} class=${`hl${state}`}>${text}</mark>`;
      }
      const numbered = numberedOf(marking);
      const n = numbered.findIndex((m) => m.id === p.id);
      const end = p.s + p.text.length >= numbered[n].end;
      const cls = p.id === marking.draft?.id ? "open" : "";
      return html`<mark data-id=${p.id} class=${cls}>${text}</mark>${end ? html`<sup class="num">${n + 1}</sup>` : nothing}`;
    });
  }

  // The list under the answer: number, passage, comment. On the last answer a comment
  // opens to be edited and has Remove (the global Undo takes it back, 12); a sent
  // answer's list is read only.
  #comments(marking) {
    const { list, comments, markable } = marking;
    if (!comments.length) return nothing;
    const number = (id) => numberedOf(marking).findIndex((m) => m.id === id) + 1;
    return html`<ol class="comments" aria-label="Comments on this answer">
      ${comments.map((m) => {
        const comment = markable
          ? html`<button class="text" title="Edit comment" @click=${() => this.#actor.send({ type: "_opened", id: m.id })}>${m.comment}</button>`
          : html`<p class="text">${m.comment}</p>`;
        return html`<li data-id=${m.id}>
          <span class="n">${number(m.id)}</span>
          <div class="body">
            <span class="quote">${m.quote}</span>
            ${comment}
          </div>
          ${markable ? html`<button class="act remove" @click=${() => this.#actor.send({ type: "_remove", id: m.id })}>Remove</button>` : nothing}
        </li>`;
      })}
    </ol>`;
  }

  // A highlight's bubble: Remove (the global Undo takes it back, 12).
  #bubble(marking) {
    const id = marking.chosen;
    return html`
      <div
        class="popover bubble"
        data-for=${id}
        @mousedown=${(e) => e.preventDefault()}
        @keydown=${(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          this.#actor.send({ type: "_highlightClosed" });
          this.renderRoot.querySelector(".transcript")?.focus({ preventScroll: true });
        }}
      >
        <button class="act remove" @click=${() => this.#actor.send({ type: "_unhighlight", id })}>
          ${icon("trash-simple")} Remove highlight
        </button>
      </div>
    `;
  }

  #popover(draft, marking) {
    const saved = marking.comments.some((m) => m.id === draft.id);
    return html`
      <div class="popover" @mousedown=${(e) => e.target.localName !== "textarea" && e.preventDefault()}>
        <textarea
          rows="1"
          aria-label="Comment"
          placeholder="Your comment on this passage"
          .value=${draft.comment}
          @input=${(e) => {
            this.#fit(e.currentTarget);
            this.#actor.send({ type: "_typed", text: e.currentTarget.value });
          }}
          @keydown=${(e) => {
            e.stopPropagation();
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
              e.preventDefault();
              this.#actor.send({ type: "_closed" });
            }
          }}
          @blur=${() => this.#actor.send({ type: "_closed" })}
        ></textarea>
        <button
          class="act remove"
          aria-label="Remove comment"
          title="Remove comment"
          @click=${() => this.#actor.send({ type: "_remove", id: draft.id })}
        >
          ${icon("trash-simple")}
        </button>
      </div>
    `;
  }

  // --- Gestures on the last answer ----------------------------------------------------

  #pointerdown(e) {
    this.#pointer = e.pointerType;
    clearTimeout(this.#settle);
  }

  // A selection in the last answer ends: its comment box opens; in an earlier answer it
  // becomes a highlight. A click on a comment's passage opens the comment, on a
  // highlight its bubble; a click anywhere else closes the bubble.
  #pointerup(e) {
    if (e.composedPath().some((el) => el.classList?.contains("popover"))) return;
    if (this.#sendSelection()) return;
    const path = e.composedPath();
    const hl = path.find((el) => el.localName === "mark" && el.classList?.contains("hl"));
    if (hl) return this.#actor.send({ type: "_highlightOpened", id: hl.dataset.id });
    if (this.#actor.snapshot?.context.chosen) this.#actor.send({ type: "_highlightClosed" });
    const mark = path.find((el) => el.localName === "mark" && el.closest?.(".markable"));
    if (mark) this.#actor.send({ type: "_opened", id: mark.dataset.id });
  }

  // The selection as offsets into one answer, sent as _selected with that answer; false
  // when there is none in an answer. A selection across answers keeps to the first one.
  // The machine decides whether it becomes a comment, a highlight, or nothing.
  #sendSelection() {
    const range = this.#selectionRange();
    if (!range) return false;
    const answer = [...this.renderRoot.querySelectorAll("[data-answer]")].find((el) => range.intersectsNode(el));
    if (!answer) return false;
    const start = this.#offsetOf(range, "start", answer);
    const end = this.#offsetOf(range, "end", answer);
    if (start == null || end == null || end <= start) return false;
    this.#clearSelection();
    this.#actor.send({ type: "_selected", answerId: answer.dataset.answer, start, end });
    return true;
  }

  // A boundary of the range as an offset into the answer. Inside a text run it is exact;
  // elsewhere (a line break, a list item, a number, outside the answer) it is the edge
  // of the first or last run the range touches.
  #offsetOf(range, edge, answer) {
    const node = edge === "start" ? range.startContainer : range.endContainer;
    const offset = edge === "start" ? range.startOffset : range.endOffset;
    const span = node.nodeType === Node.TEXT_NODE ? node.parentElement : null;
    if (span?.dataset?.s != null && answer.contains(span)) return Number(span.dataset.s) + offset;
    const spans = [...answer.querySelectorAll("[data-s]")].filter((el) => range.intersectsNode(el));
    if (!spans.length) return null;
    if (edge === "start") return Number(spans[0].dataset.s);
    const last = spans[spans.length - 1];
    return Number(last.dataset.s) + last.textContent.length;
  }

  // The current selection inside the thread as a DOM range, or null. getComposedRanges
  // reaches across the shadow boundary (WebKit); a scoped getSelection is the fallback
  // (Chromium). A collapsed range is no selection.
  #selectionRange() {
    const doc = document.getSelection();
    if (doc && typeof doc.getComposedRanges === "function") {
      const [range] = doc.getComposedRanges({ shadowRoots: [this.renderRoot] });
      if (range && !(range.startContainer === range.endContainer && range.startOffset === range.endOffset)) return this.#live(range);
    }
    const scoped = this.renderRoot.getSelection?.();
    if (scoped && !scoped.isCollapsed && scoped.rangeCount) return scoped.getRangeAt(0);
    return null;
  }

  // A StaticRange as a Range, for intersectsNode.
  #live(range) {
    if (typeof range.intersectsNode === "function") return range;
    const live = document.createRange();
    live.setStart(range.startContainer, range.startOffset);
    live.setEnd(range.endContainer, range.endOffset);
    return live;
  }

  #clearSelection() {
    document.getSelection()?.removeAllRanges?.();
    this.renderRoot.getSelection?.()?.removeAllRanges?.();
  }

  // After each render: a newly opened comment box is placed under its passage and takes
  // the keys, its caret at the end of what it holds.
  #afterComment() {
    const snapshot = this.#actor.snapshot;
    this.#afterBubble(snapshot);
    const draft = snapshot?.matches({ showing: "commenting" }) ? snapshot.context.draft : null;
    if (!draft) {
      this.#focused = null;
      return;
    }
    this.#positionPopover(draft.id, ".popover:not(.bubble)");
    if (this.#focused === draft.id) return;
    this.#focused = draft.id;
    const box = this.renderRoot.querySelector(".popover textarea");
    if (box) {
      this.#fit(box);
      box.focus({ preventScroll: true });
      box.setSelectionRange(box.value.length, box.value.length);
    }
  }

  // The comment box as tall as what it holds; set as a custom property (7.4).
  #fit(box) {
    box.style.setProperty("--h", "auto");
    box.style.setProperty("--h", `${box.scrollHeight}px`);
  }

  // A highlight's bubble is placed under it too, and takes the keys when it opens, so
  // Escape closes it and Enter removes.
  #bubbleFor = null;
  #afterBubble(snapshot) {
    const chosen = snapshot?.matches("showing") ? snapshot.context.chosen : null;
    if (!chosen) {
      this.#bubbleFor = null;
      return;
    }
    this.#positionPopover(chosen, ".bubble");
    if (this.#bubbleFor === chosen) return;
    this.#bubbleFor = chosen;
    this.renderRoot.querySelector(".bubble button")?.focus({ preventScroll: true });
  }

  // Under the passage's last line, aligned with that line's start, clamped inside the
  // answer; placed with custom properties so no length is a literal style (7.4).
  #positionPopover(id, selector) {
    const marked = this.renderRoot.querySelectorAll(`[data-answer] mark[data-id="${id}"]`);
    const turn = marked[0]?.closest(".turn.assistant");
    const popover = turn?.querySelector(selector);
    if (!popover || !turn || !marked.length) return;
    const last = marked[marked.length - 1];
    const rects = last.getClientRects();
    const line = rects[rects.length - 1] ?? last.getBoundingClientRect();
    const box = turn.getBoundingClientRect();
    const width = popover.offsetWidth;
    let x = line.left - box.left;
    x = Math.max(0, Math.min(Math.max(0, box.width - width), x));
    const y = line.bottom - box.top + POPOVER_GAP;
    popover.style.setProperty("--bx", `${Math.round(x)}px`);
    popover.style.setProperty("--by", `${Math.round(y)}px`);
  }

  #thinking(turn) {
    const open = this.#openThinking.has(turn.id);
    return html`
      <details
        class="record thinking"
        ?open=${open}
        @toggle=${(e) => {
          if (e.currentTarget.open !== open) this.#toggleThinking(turn.id);
        }}
      >
        <summary>Thinking</summary>
        <div class="opened text">${turn.thinking}</div>
      </details>
    `;
  }

  // A stopped or failed answer names what happened; a done answer needs no footer.
  #foot(turn) {
    if (turn.status === "stopped") return html`<div class="foot"><span class="status">Stopped.</span></div>`;
    if (turn.status === "failed") return html`<div class="foot"><span class="status failed">${errorText(turn.error)}</span></div>`;
    return nothing;
  }
}

customElements.define("chat-thread", ChatThread);
