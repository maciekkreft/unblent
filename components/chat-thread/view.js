import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { ulid } from "ulid";
import { icon } from "icons";
import { machine, chapterLabelOf, canPin, vimAction, scrollFor, parseMarkdown, userParagraphs, pieces, lastAnswer, savedMarks, marks, highlightable, highlightsOf } from "./machine.js";
import pinToggled from "./events/pin.toggled.json" with { type: "json" };
import marksEdited from "./events/marks.edited.json" with { type: "json" };
import highlightsEdited from "./events/highlights.edited.json" with { type: "json" };
import relinked from "./events/conversation.relinked.json" with { type: "json" };

// The gap between a passage's last line and the comment box under it, in px; the box is
// placed in JS, so the value is not a style (7.4 covers styles).
const POPOVER_GAP = 6;
// How long a finger's selection must stay still before its comment box opens: a touch
// selection is adjusted with handles that send no pointer events, only selection changes.
const TOUCH_SETTLE_MS = 700;

// A CSS duration token ("3s", "300ms") as milliseconds, for the machine's undo window;
// the token is the one clock (7.4).
const toMs = (text, fallback = 3000) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
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
    const undoMs = toMs(getComputedStyle(this.host).getPropertyValue("--duration-undo"));
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        mint: ulid,
        undoMs,
      },
      events: { "pin.toggled": pinToggled, "marks.edited": marksEdited, "highlights.edited": highlightsEdited, "conversation.relinked": relinked },
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
    /* The header: the chapter label at the left, the pin at the top right, where the
       note editor has its pin, so the two panels pin the same way. */
    .header {
      flex: none;
      display: flex;
      align-items: center;
      gap: var(--space-sm);
      padding: var(--space-xs) var(--space-md) 0;
    }
    /* The chapter label, as the note editor draws it: a rounded tag naming the chapter
       the chat is linked to, accent while linked to one, holding the Link or Unlink
       button. The header keeps its height whether or not it shows, and the label is as
       tall without its button as with it, so the transcript never jumps. On a narrow
       panel the chapter's name gives way before the button that acts. */
    .place {
      flex: 1;
      min-width: 0;
      display: flex;
      min-height: calc(var(--text-caption) * var(--leading-tight) + 4 * var(--space-2xs) + 2 * var(--border-width));
    }
    .chapter {
      flex: 0 1 auto;
      min-width: 0;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      gap: var(--space-xs);
      padding: var(--space-2xs);
      padding-inline-start: var(--space-sm);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      background: var(--color-canvas-soft);
      color: var(--color-body-mid);
      font-size: var(--text-caption);
      line-height: var(--leading-tight);
      white-space: nowrap;
    }
    .chapter:not(:has(button)) {
      padding-inline-end: var(--space-sm);
    }
    .chapter.linked {
      border-color: var(--color-accent);
      background: var(--color-accent-subtle);
      color: var(--color-ink);
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
      border: none;
      border-radius: var(--radius-full);
      padding: var(--space-2xs) var(--space-xs);
      margin: 0;
      background: var(--color-canvas);
      color: var(--color-ink);
      font: inherit;
      font-weight: var(--weight-semibold);
      white-space: nowrap;
      cursor: pointer;
    }
    .relink:hover {
      background: var(--color-surface-hover);
    }
    .relink:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    /* The pin: a toggle, muted while following, accent when pinned, as the note
       editor's. */
    .pin {
      flex: none;
      display: inline-flex;
      appearance: none;
      background: none;
      border: var(--border-width) solid transparent;
      border-radius: var(--radius-sm);
      padding: var(--space-2xs);
      margin: 0;
      font: inherit;
      font-size: var(--text-body);
      cursor: pointer;
      color: var(--color-body-mid);
    }
    .pin svg {
      display: block;
    }
    .pin:hover:not(:disabled):not([aria-pressed="true"]) {
      color: var(--color-ink);
    }
    .pin[aria-pressed="true"] {
      color: var(--color-accent);
    }
    .pin:disabled {
      color: var(--color-mute);
      cursor: default;
    }
    .pin:focus-visible {
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
    /* Drawn inside the box: the panel around it clips anything outside, on the phone. */
    .transcript:focus-visible {
      outline: calc(2 * var(--border-width)) solid var(--color-accent);
      outline-offset: calc(-2 * var(--border-width));
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
    mark.removing,
    .comments li.removing .body {
      opacity: 0.4;
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
    .act.undo {
      color: var(--color-accent);
    }
    .act.undo:hover {
      color: var(--color-accent);
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
    /* A highlight's bubble: one action, Remove, then Undo for the undo window. */
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
    .bubble .removed {
      padding-left: var(--space-xs);
      color: var(--color-body-mid);
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
    /* The thinking record: a dim disclosure, closed by default, that opens to read what
       the model thought (12: a live line while the model works, then a dim record). */
    .thinking {
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
    .thinking summary {
      cursor: pointer;
      color: var(--color-mute);
      list-style: none;
      /* A click toggles the record; it must not select the word as a side effect. */
      user-select: none;
      -webkit-user-select: none;
    }
    .thinking summary::-webkit-details-marker {
      display: none;
    }
    .thinking .text {
      margin-top: var(--space-2xs);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: var(--color-body-mid);
    }
    /* What the model is reading, or read, during a round of lookups (7.7): a dim line per
       recognised tool call, naming the lookup by its owner's label. It reads as a live
       line while the round runs (the pending answer follows it) and stays as a quiet
       record after. A call the system did not recognise is not shown as a lookup. */
    .lookups {
      display: flex;
      flex-direction: column;
      gap: var(--space-2xs);
      font-size: var(--text-sm);
      color: var(--color-mute);
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
    /* The whole chat has finished turns not yet on the server (5): a quiet caption so
       the reader knows not to close the page yet. */
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
  // Whether the transcript is pinned to the bottom, so it follows a streaming answer
  // but leaves the reader where they scrolled if they scrolled up.
  #stick = true;
  // The pointer that pressed last on the last answer, and the comment box last focused.
  #pointer = null;
  #focused = null;
  #settle;
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
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("selectionchange", this.#onSelectionChange);
    this.removeEventListener("keydown", this.#onBoxEscape);
    clearTimeout(this.#settle);
  }

  #onScroll(event) {
    const el = event.currentTarget;
    this.#stick = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLOP;
  }

  updated() {
    this.#afterComment();
    if (!this.#stick) return;
    const el = this.renderRoot.querySelector(".transcript");
    if (el) el.scrollTop = el.scrollHeight;
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

  render() {
    const snapshot = this.#actor.snapshot;
    return html`
      ${this.#header(snapshot)}
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
      <div class="composer"><slot></slot></div>
    `;
  }

  // The pin keeps the open chat when the subject changes (12). Unavailable until the
  // open chat has its first message, and the tooltip and label say so; otherwise the
  // label names the action for assistive tech.
  #header(snapshot) {
    if (!snapshot) return nothing;
    const { openId, pin } = snapshot.context;
    const available = canPin(snapshot.context);
    const pinned = available && pin === openId;
    const label = !available ? "Pin chat: available after the first message" : pinned ? "Unpin chat" : "Pin chat";
    return html`
      <div class="header">
        <div class="place">${this.#chapter(chapterLabelOf(snapshot))}</div>
        <button
          class="pin"
          type="button"
          aria-pressed=${pinned}
          aria-label=${label}
          title=${label}
          ?disabled=${!available}
          @click=${() => this.#actor.send({ type: "_togglePin" })}
        >
          ${icon("push-pin")}
        </button>
      </div>
    `;
  }

  // The chapter label (machine.js: chapterLabelOf decides what it says and offers).
  #chapter(label) {
    if (!label) return nothing;
    return html`<span class=${label.linked ? "chapter linked" : "chapter"}
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
      ${chat?.pending ? html`<p class="unsaved">Not saved yet</p>` : nothing}
    `;
  }

  // What the last answer paints: every comment and the one being written, and the
  // saved ones listed under it, the open one as it is being typed.
  #editable(snapshot) {
    const { context } = snapshot;
    const draft = snapshot.matches({ showing: "commenting" }) ? context.draft : null;
    // A removed comment is already off the saved list; it stays dimmed until its undo
    // window ends.
    const answerId = lastAnswer(context.conversation)?.id;
    const removed = [...context.discarding.values()].filter((d) => d.answerId === answerId).map((d) => d.mark);
    const byStart = (a, b) => a.start - b.start;
    const list = [...marks({ conversation: context.conversation, draft }), ...removed].sort(byStart);
    const comments = [...savedMarks(context.conversation).map((m) => (m.id === draft?.id ? { ...m, comment: draft.comment } : m)), ...removed].sort(byStart);
    return { list, comments, markable: true, selectable: true, draft, discarding: context.discarding };
  }

  // What an earlier answer paints: its highlights, one in its undo window dimmed, beside
  // the comments that went with the next message, which stay numbered and read only.
  #highlighting(snapshot, answerId, sent) {
    const { context } = snapshot;
    const removed = [...context.unhighlighting.values()].filter((h) => h.answerId === answerId);
    const own = [...highlightsOf(context.conversation, answerId), ...removed];
    const list = [...sent, ...own].sort((a, b) => a.start - b.start);
    const chosen = own.some((h) => h.id === context.chosen) ? context.chosen : null;
    return { list, comments: sent, markable: false, selectable: true, highlights: new Set(own.map((h) => h.id)), chosen, discarding: context.unhighlighting };
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
        ${turn.thinking && !(pending && !hasText) ? this.#thinking(turn) : nothing}
        ${waiting}
        ${answer}
        ${this.#lookups(turn)}
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

  // The lookups this answer asked for (7.7): a dim line per recognised tool call. A call
  // the system did not recognise (`invalid`) is not named as a lookup — it was rejected,
  // not run.
  #lookups(turn) {
    const named = (turn.calls ?? []).filter((call) => !call.invalid);
    if (!named.length) return nothing;
    return html`<div class="lookups">${named.map((call) => html`<span>${call.label}</span>`)}</div>`;
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
        return html`<mark data-id=${p.id} class=${`hl${state}${marking.discarding.has(p.id) ? " removing" : ""}`}>${text}</mark>`;
      }
      const numbered = numberedOf(marking);
      const n = numbered.findIndex((m) => m.id === p.id);
      const end = p.s + p.text.length >= numbered[n].end;
      const cls = p.id === marking.draft?.id ? "open" : marking.discarding?.has(p.id) ? "removing" : "";
      return html`<mark data-id=${p.id} class=${cls}>${text}</mark>${end ? html`<sup class="num">${n + 1}</sup>` : nothing}`;
    });
  }

  // The list under the answer: number, passage, comment. On the last answer a comment
  // opens to be edited and has Remove, which waits out the undo window with Undo; a
  // sent answer's list is read only.
  #comments(marking) {
    const { list, comments, markable } = marking;
    if (!comments.length) return nothing;
    const number = (id) => numberedOf(marking).findIndex((m) => m.id === id) + 1;
    return html`<ol class="comments" aria-label="Comments on this answer">
      ${comments.map((m) => {
        const removing = markable && marking.discarding.has(m.id);
        const comment = markable
          ? html`<button class="text" title="Edit comment" @click=${() => this.#actor.send({ type: "_opened", id: m.id })}>${m.comment}</button>`
          : html`<p class="text">${m.comment}</p>`;
        return html`<li class=${removing ? "removing" : ""} data-id=${m.id}>
          <span class="n">${number(m.id)}</span>
          <div class="body">
            <span class="quote">${m.quote}</span>
            ${comment}
          </div>
          ${!markable
            ? nothing
            : removing
              ? html`<span class="removed">Removed.</span><button class="act undo" @click=${() => this.#actor.send({ type: "_undo", id: m.id })}>Undo</button>`
              : html`<button class="act remove" @click=${() => this.#actor.send({ type: "_remove", id: m.id })}>Remove</button>`}
        </li>`;
      })}
    </ol>`;
  }

  // A highlight's bubble: Remove, and while the removal can be taken back, Undo.
  #bubble(marking) {
    const id = marking.chosen;
    const removing = marking.discarding.has(id);
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
        ${removing
          ? html`<span class="removed">Removed.</span
              ><button class="act undo" @click=${() => this.#actor.send({ type: "_rehighlight", id })}>Undo</button>`
          : html`<button class="act remove" @click=${() => this.#actor.send({ type: "_unhighlight", id })}>
              ${icon("trash-simple")} Remove highlight
            </button>`}
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
          @click=${() => this.#actor.send({ type: saved ? "_remove" : "_closed", id: draft.id })}
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
    // Remove and Undo replace each other, so the keys follow to the new button.
    const shown = `${chosen}:${snapshot.context.unhighlighting.has(chosen)}`;
    if (this.#bubbleFor === shown) return;
    this.#bubbleFor = shown;
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
        class="thinking"
        ?open=${open}
        @toggle=${(e) => {
          if (e.currentTarget.open !== open) this.#toggleThinking(turn.id);
        }}
      >
        <summary>Thinking</summary>
        <div class="text">${turn.thinking}</div>
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
