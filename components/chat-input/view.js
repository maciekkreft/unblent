import { LitElement, html, css, nothing } from "lit";
import { mount, unmount, ask } from "bus";
import { monotonicFactory } from "ulid";
import { icon } from "icons";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap, drawSelection, placeholder } from "@codemirror/view";
import { history, historyKeymap, insertNewline } from "@codemirror/commands";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { machine, draftKey, chatDraftKey, inputState, pendingTurn, canContinue, retryText } from "./machine.js";
import submitted from "./events/turn.submitted.json" with { type: "json" };
import steered from "./events/turn.steered.json" with { type: "json" };

// The question box (3.1): a CodeMirror document owning only its draft. The box is one
// editor for both modes: Vim lives in a compartment the "Vim keys" preference (12) turns
// on and off in place, so the draft and the history survive the switch, and the box is
// never torn down — even disabled it stays mounted, so a sign-out keeps the draft (12).

// The drafts, kept across reloads (3.1): the view's own UI state, one entry per
// `draftKey`, under a key named for the component, so they follow the browser, not the
// account, and losing them loses nothing. Wrapped like settings/store.js: a browser
// refusing storage reads nothing and drops the write.
const KEY = "chat-input.drafts";
// The single draft kept before there was one per chat; it moves to the first key used.
const OLD_KEY = "chat-input.draft";
const readAll = () => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
};
const draftStore = {
  read(key) {
    const text = readAll()[key];
    return typeof text === "string" ? text : "";
  },
  write(key, text) {
    try {
      const all = readAll();
      if (text) all[key] = text;
      else delete all[key];
      if (Object.keys(all).length) localStorage.setItem(KEY, JSON.stringify(all));
      else localStorage.removeItem(KEY);
    } catch {
      // No persistence available; the draft lives only for this page.
    }
  },
  adoptOld(key) {
    try {
      const old = localStorage.getItem(OLD_KEY);
      if (old == null) return;
      if (old && !this.read(key)) this.write(key, old);
      localStorage.removeItem(OLD_KEY);
    } catch {
      // As above.
    }
  },
};

// A CSS duration token as milliseconds, for the moment the Send/Stop button ignores
// clicks after it changes; the token is the one clock (7.4), the same --duration-slide
// the row animations use.
const toMs = (text, fallback = 300) => {
  const t = (text || "").trim();
  const n = parseFloat(t);
  if (Number.isNaN(n)) return fallback;
  return t.endsWith("ms") ? n : n * 1000;
};

// The structural theme, keyed to tokens like the note editors'; line spacing is padding,
// never margin. The box grows from one line to six, then scrolls inside, so it never
// pushes the transcript off screen.
const editorTheme = EditorView.theme({
  "&": { color: "var(--color-ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-sans)",
    lineHeight: "var(--leading-normal)",
    overflowY: "auto",
    maxHeight: "calc(var(--text-body) * var(--leading-normal) * 6)",
  },
  ".cm-content": {
    caretColor: "var(--color-accent)",
    padding: "var(--space-xs) var(--space-sm)",
    minHeight: "calc(var(--text-body) * var(--leading-normal))",
  },
  ".cm-line": { fontSize: "var(--text-body)", padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "var(--color-accent-selection)" },
  ".cm-placeholder": { color: "var(--color-mute)" },
});

// The Vim block cursor, keyed to tokens, copied from note-editor (components never
// import each other, 11.2). The plugin ships its own Prec.highest theme, so this raises
// precedence and marks the competing properties !important to win regardless of order.
// Focused, it fills with the accent; unfocused, it is hollowed with an inset shadow,
// which no edge clip can reach — the plugin draws an outline outside an absolutely
// positioned span, and Safari clips its top and left.
const fatCursorTheme = Prec.highest(
  EditorView.theme({
    ".cm-fat-cursor": {
      background: "var(--color-accent) !important",
      color: "var(--color-accent-text) !important",
    },
    "&:not(.cm-focused) .cm-fat-cursor": {
      background: "none !important",
      outline: "none !important",
      color: "var(--color-ink) !important",
      boxShadow: "inset 0 0 0 var(--border-width) var(--color-accent)",
    },
  }),
);

// Vim and its block cursor, or nothing: what the Vim compartment holds for the
// "Vim keys" preference (12).
const vimExtensions = (on) => (on ? [vim(), fatCursorTheme] : []);

class ActorController {
  constructor(host) {
    this.host = host;
    host.addController(this);
  }

  hostConnected() {
    this.actor = mount(machine, {
      input: {
        ask: (target, name, payload) => ask(machine, target, name, payload),
        // Monotonic ids, so two turns minted in the same millisecond keep the order they
        // were made in.
        mint: monotonicFactory(),
      },
      events: { "turn.submitted": submitted, "turn.steered": steered },
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

class ChatInput extends LitElement {
  static styles = css`
    :host {
      display: block;
    }
    .box {
      display: flex;
      flex-direction: column;
      gap: var(--space-xs);
      padding: var(--space-sm);
    }
    /* The one contextual action, when the chat was left hanging: Continue an
       interrupted answer, or Try again a failed one. */
    .actions {
      display: flex;
      gap: var(--space-sm);
    }
    .action {
      appearance: none;
      background: none;
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-full);
      padding: var(--space-2xs) var(--space-sm);
      font: inherit;
      font-size: var(--text-sm);
      cursor: pointer;
      color: var(--color-body);
    }
    .action:hover {
      background: var(--color-surface-hover);
      color: var(--color-ink);
    }
    .action:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .row {
      display: flex;
      align-items: flex-end;
      gap: var(--space-sm);
    }
    /* CM6 owns everything inside .region; the frame is drawn here, around it. */
    .region {
      flex: 1;
      min-width: 0;
      color: var(--color-ink);
      background: var(--color-canvas-soft);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
      box-sizing: border-box;
      overflow: hidden;
    }
    .region:focus-within {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    ::selection {
      background: var(--color-accent-selection);
    }
    /* The send/stop button: a round accent button, so it reads as the one action. */
    .send {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      appearance: none;
      border: 0;
      border-radius: var(--radius-full);
      width: var(--space-xl);
      height: var(--space-xl);
      padding: 0;
      font: inherit;
      font-size: var(--text-subtitle);
      cursor: pointer;
      color: var(--color-accent-text);
      background: var(--color-accent);
    }
    .send svg {
      display: block;
    }
    .send:hover:not(:disabled) {
      background: var(--color-accent-hover);
    }
    .send:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .send:disabled {
      background: var(--color-border);
      color: var(--color-mute);
      cursor: default;
    }
    .notice {
      margin: 0;
      padding: var(--space-sm);
      font-size: var(--text-sm);
      color: var(--color-body-mid);
    }
  `;

  #actor = new ActorController(this);
  #draft = "";
  // Which draft the box shows; null until the starting picture names it, so nothing is
  // loaded or saved under a wrong key before then.
  #key = null;
  #deletedSeen = 0;
  #view = null;
  // Vim lives in a compartment so the "Vim keys" preference (12) turns it on or off in
  // place, keeping the draft and the history. A second compartment carries editable, so
  // a disabled box (signed out, no key) is still the same mounted editor (12).
  #vim = new Compartment();
  #vimOn = false;
  #editable = new Compartment();
  #editableOn = false;
  // The Send/Stop button ignores clicks for a moment after it changes role, so a click
  // aimed at Send does not land on the freshly-appeared Stop, and vice versa.
  #pendingWas = false;
  #focusSeen = 0;
  #guardUntil = 0;
  #guardMs = null;

  #guard() {
    if (this.#guardMs == null) this.#guardMs = toMs(getComputedStyle(this).getPropertyValue("--duration-slide"));
    return this.#guardMs;
  }

  #extensions() {
    this.#vimOn = this.#actor.snapshot?.context.vimKeys === true;
    this.#editableOn = !inputState(this.#actor.snapshot?.context.llm).disabled;
    return [
      // First: the Vim plugin must see a key before any other keymap at its level does.
      this.#vim.of(vimExtensions(this.#vimOn)),
      this.#keys(),
      // Vim hides the native selection (its own theme paints ::selection transparent), so
      // the visual-mode range shows only through CM6's own selection layer.
      drawSelection(),
      history(),
      keymap.of(historyKeymap),
      EditorView.lineWrapping,
      this.#editable.of(EditorView.editable.of(this.#editableOn)),
      editorTheme,
      placeholder("Ask about your library…"),
      EditorView.updateListener.of(this.#onUpdate),
      // WebKit keeps the document's selection inside a blurred editor, and a later key
      // whose default nobody cancels is typed there although the focus sits on a list
      // row or the bare page; dropping it on blur leaves the editor nothing to type into.
      EditorView.domEventHandlers({ blur: () => void document.getSelection()?.removeAllRanges() }),
    ];
  }

  // Enter, Shift+Enter and Escape (12). A keydown handler at Prec.highest, not a keymap:
  // CM6 runs every keymap from one default-precedence handler, which the Vim plugin's own
  // handler precedes, so Vim would take Enter in normal mode before a keymap saw it.
  // getCM reports insert mode only while Vim is on; guarded by the preference so a stale
  // handle never reads true.
  #keys() {
    const vimOn = () => this.#actor.snapshot?.context.vimKeys === true;
    const inserting = (view) => vimOn() && getCM(view)?.state?.vim?.insertMode === true;
    return Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          // An Enter that confirms an input-method composition is not a send.
          if (event.isComposing) return false;
          if (event.key === "Enter" && event.shiftKey) {
            if (vimOn() && !inserting(view)) return false; // Vim normal mode: Vim's own
            // Made here, because WebKit's native line break doubles at the end of the text.
            event.preventDefault();
            return insertNewline(view);
          }
          if (event.key === "Enter") {
            if (inserting(view)) return false; // Vim insert mode: Vim's own new line
            event.preventDefault(); // a doomed Enter never drops a stray newline
            this.#send();
            return true;
          }
          if (event.key === "Escape") {
            if (inserting(view)) return false; // the first Escape leaves insert, Vim's own
            if (!pendingTurn(this.#actor.snapshot?.context.conversation)) return false;
            event.preventDefault();
            this.#actor.send({ type: "_stop" });
            return true;
          }
          return false;
        },
      }),
    );
  }

  #onUpdate = (update) => {
    if (!update.docChanged) return;
    this.#draft = update.state.doc.toString();
    if (this.#key != null) draftStore.write(this.#key, this.#draft);
    this.requestUpdate(); // enable/disable Send as the draft gains or loses text
  };

  firstUpdated() {
    const parent = this.renderRoot.querySelector(".region");
    this.#view = new EditorView({
      parent,
      // Shadow-DOM: CM6 reads the selection through the root and style-mod mounts its
      // sheet there, not on document (7.5), so it must know the shadow root.
      root: this.renderRoot,
      state: EditorState.create({ doc: this.#draft, extensions: this.#extensions() }),
    });
  }

  // Another chat or subject: keep the text typed so far under the old key and show the
  // new key's text in a fresh state, so Undo never brings back another chat's words. The
  // fresh state carries the compartments as the preference and the account now set them.
  #swapDraft(snapshot) {
    if (!snapshot.matches("ready")) return;
    const key = draftKey(snapshot.context);
    if (key == null || key === this.#key) return;
    if (this.#key == null) {
      draftStore.adoptOld(key);
      // Text typed before the picture arrived is kept unless a stored draft is waiting.
      if (this.#draft && !draftStore.read(key)) draftStore.write(key, this.#draft);
    } else draftStore.write(this.#key, this.#draft);
    this.#key = key;
    this.#draft = draftStore.read(key);
    const focused = this.#view.hasFocus;
    this.#view.setState(EditorState.create({ doc: this.#draft, extensions: this.#extensions() }));
    if (focused) this.#view.focus();
    this.requestUpdate(); // Send follows the text now shown
  }

  updated() {
    const snapshot = this.#actor.snapshot;
    if (snapshot && this.#view) {
      this.#swapDraft(snapshot);
      // After the swap, which saved the text of a chat that may be the one deleted.
      const deleted = snapshot.context.deleted;
      for (; this.#deletedSeen < deleted.length; this.#deletedSeen++) draftStore.write(chatDraftKey(deleted[this.#deletedSeen]), "");
      const vimKeys = snapshot.context.vimKeys === true;
      if (vimKeys !== this.#vimOn) {
        this.#vimOn = vimKeys;
        this.#view.dispatch({ effects: this.#vim.reconfigure(vimExtensions(vimKeys)) });
      }
      const editableOn = !inputState(snapshot.context.llm).disabled;
      if (editableOn !== this.#editableOn) {
        this.#editableOn = editableOn;
        this.#view.dispatch({ effects: this.#editable.reconfigure(EditorView.editable.of(editableOn)) });
      }
    }
    if (snapshot && snapshot.context.focusRequest !== this.#focusSeen) {
      this.#focusSeen = snapshot.context.focusRequest;
      // Next frame: list-then-item may not have shown the chat yet (12, ordering).
      requestAnimationFrame(() => this.#focusToType());
    }
    const pending = Boolean(pendingTurn(snapshot?.context.conversation));
    if (pending !== this.#pendingWas) {
      this.#pendingWas = pending;
      this.#guardUntil = performance.now() + this.#guard();
    }
  }

  // A new chat was picked (12): the cursor goes to the box, in insert mode under Vim, so
  // the first key typed is text.
  #focusToType() {
    const view = this.#view;
    if (!view || !this.#editableOn) return;
    view.focus();
    const cm = this.#vimOn ? getCM(view) : null;
    if (cm && cm.state?.vim?.insertMode !== true) Vim.handleKey(cm, "i", "user");
  }

  disconnectedCallback() {
    this.#view?.destroy();
    this.#view = null;
    super.disconnectedCallback();
  }

  #send() {
    // Keep the draft when the machine cannot send it: while an answer is arriving (the
    // button is Stop) or before the machine is ready. Otherwise a doomed Enter would
    // clear the box, though 12 says the box stays editable while an answer arrives.
    const snapshot = this.#actor.snapshot;
    if (!snapshot?.matches("ready")) return;
    if (pendingTurn(snapshot.context.conversation)) return;
    if (!this.#draft.trim()) return;
    this.#actor.send({ type: "_send", text: this.#draft });
    this.#clearDraft();
  }

  #clearDraft() {
    this.#draft = "";
    if (this.#key != null) draftStore.write(this.#key, "");
    if (this.#view) this.#view.dispatch({ changes: { from: 0, to: this.#view.state.doc.length, insert: "" } });
    this.requestUpdate();
  }

  #primary(pending) {
    if (performance.now() < this.#guardUntil) return; // ignore a click during the guard
    if (pending) this.#actor.send({ type: "_stop" });
    else this.#send();
  }

  // dock-desk's Ctrl+h/j/k/l (12) and list-then-item focus a panel by its host: land
  // in the editor, where the typing goes.
  focus(options) {
    if (this.#view) this.#view.focus();
    else super.focus(options);
  }

  render() {
    const snapshot = this.#actor.snapshot;
    if (!snapshot) return nothing;
    const context = snapshot.context;
    const { disabled, notice } = inputState(context.llm);
    // Signed out or no key: show the line, but keep the box mounted and hide its row, so
    // the one editor survives sign-out and sign-in with its draft (12).
    const blocked = disabled && notice;

    const pending = Boolean(pendingTurn(context.conversation));
    const showContinue = !blocked && !pending && canContinue(context.conversation);
    const showRetry = !blocked && !pending && retryText(context.conversation) != null;
    const canSend = pending || (!disabled && Boolean(this.#draft.trim()));

    return html`
      <div class="box">
        ${blocked ? html`<p class="notice">${notice}</p>` : nothing}
        ${showContinue || showRetry
          ? html`<div class="actions">
              ${showContinue
                ? html`<button class="action" type="button" @click=${() => this.#actor.send({ type: "_continue" })}>
                    Continue
                  </button>`
                : nothing}
              ${showRetry
                ? html`<button class="action" type="button" @click=${() => this.#actor.send({ type: "_retry" })}>
                    Try again
                  </button>`
                : nothing}
            </div>`
          : nothing}
        <div class="row" ?hidden=${blocked}>
          <div class="region" role="textbox" aria-label="Message"></div>
          <button
            class="send"
            type="button"
            aria-label=${pending ? "Stop" : "Send"}
            ?disabled=${!canSend}
            @click=${() => this.#primary(pending)}
          >
            ${pending ? icon("stop") : icon("arrow-up")}
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define("chat-input", ChatInput);
