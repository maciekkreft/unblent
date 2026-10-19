import { setup, assign, emit, fromPromise } from "xstate";

// The view that shows the open conversation (architecture.md 3.1): headless of the
// fact, it owns only its own UI state (the transcript scroll, which thinking records
// are open — all in the view). It asks `conversations` which chat
// is open and reads it for the starting picture (4.3), then follows the conversation
// events for everything after. The question box is a separate view shown through a
// default slot (6.3), so this component emits nothing. Everything with a side effect —
// the queries — arrives through input, so this stays a pure definition importable in
// Node. Its one gesture is the pin (12): it asks `pins` for the pinned chat, follows
// pins.changed, and emits pin.toggled; `conversations` keeps a pinned chat open, and
// `pins` moves an "on" pin to whichever chat opens.

// A conversation.changed payload is the whole conversation with a `type` on it; the
// read reply is the same shape without the `type`. One helper, so both feed the view
// the same object.
const asConversation = (event) => {
  const { type, ...rest } = event;
  return rest;
};

// Render an assistant answer's markdown to a tree of blocks and inline runs, so the view
// draws bold, headings and lists as formatting rather than raw # and * (10). It is ours,
// small and pure — no vendored library — the reverse of the HTML-to-markdown converter in
// `conversations` (7.7). It returns only data: `text` runs stay text, so the view can
// interpolate every one through Lit as an escaped text node and nothing the model wrote
// ever reaches the page as HTML. A link becomes its text alone, as our other converter
// drops a link's target.
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^\s*```/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)\d+\.\s+(.*)$/;
const listItem = (line) => UL_ITEM.exec(line) || OL_ITEM.exec(line);
const isBlockStart = (line) => HEADING.test(line) || QUOTE.test(line) || FENCE.test(line) || Boolean(listItem(line));

// Emphasis and inline code inside one line. A `*`/`_` marker only opens a span when the
// character just inside it is not a space (standard markdown), so arithmetic like `a * b`
// and a lone `_` are left as text.
const parseInline = (text) => {
  const nodes = [];
  let buf = "";
  const flush = () => {
    if (buf) nodes.push({ type: "text", value: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      flush();
      nodes.push({ type: "break" });
      i += 1;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        nodes.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((c === "*" || c === "_") && text[i + 1] === c && text[i + 2] && text[i + 2] !== " ") {
      const marker = c + c;
      const end = text.indexOf(marker, i + 2);
      if (end > i + 2 && text[end - 1] !== " ") {
        flush();
        nodes.push({ type: "strong", inline: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === "*" || c === "_") && text[i + 1] && text[i + 1] !== " ") {
      const end = text.indexOf(c, i + 1);
      if (end > i + 1 && text[end - 1] !== " ") {
        flush();
        nodes.push({ type: "em", inline: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (c === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren > close) {
          flush();
          nodes.push(...parseInline(text.slice(i + 1, close)));
          i = paren + 1;
          continue;
        }
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return nodes;
};

// One list, ordered or not, from `start`; nested items (indented further) recurse and hang
// under the item above them. Blank lines between items keep one list, because models
// often space their points apart and each would otherwise be numbered 1. A numbered
// list keeps the number it starts at. Returns the list block and the line after it.
const parseList = (lines, start) => {
  const baseIndent = listItem(lines[start])[1].length;
  const ordered = !UL_ITEM.test(lines[start]);
  const first = ordered ? Number(/\d+/.exec(lines[start])[0]) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (lines[i].trim() === "") {
      let j = i;
      while (j < lines.length && lines[j].trim() === "") j += 1;
      const after = j < lines.length && listItem(lines[j]);
      if (!after || after[1].length < baseIndent) break;
      i = j;
      continue;
    }
    const m = listItem(lines[i]);
    if (!m) break;
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const nested = parseList(lines, i);
      if (items.length) items[items.length - 1].blocks.push(nested.list);
      i = nested.next;
      continue;
    }
    if (!UL_ITEM.test(lines[i]) !== ordered) break; // a switch between ordered and not ends the list
    items.push({ blocks: [{ type: "paragraph", inline: parseInline(m[2]) }] });
    i += 1;
  }
  // Trailing blank lines stay outside the list, for the block after it.
  while (i > start && lines[i - 1].trim() === "") i -= 1;
  return { list: { type: "list", ordered, start: first, items }, next: i };
};

const parseBlocks = (lines) => {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (FENCE.test(line)) {
      i += 1;
      const code = [];
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // the closing fence, if any
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: h[1].length, inline: parseInline(h[2].trim()) });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      blocks.push({ type: "quote", blocks: parseBlocks(quoted) });
      continue;
    }
    if (listItem(line)) {
      const { list, next } = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join("\n")) });
  }
  return blocks;
};

export const parseMarkdown = (text) => parseBlocks(String(text).replace(/\r\n?/g, "\n").split("\n"));

// The reader's own message as the editor kit draws it (10): paragraphs apart by a gap,
// one gap per blank line, so a message reads as it was typed. A paragraph keeps its
// single line breaks; "" stands for a gap. Blank lines at either end are dropped, since
// they separate nothing. Only data: the view draws each paragraph as an escaped text node.
export function userParagraphs(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let para = null;
  for (const line of lines) {
    if (line === "") {
      if (para !== null) blocks.push(para);
      para = null;
      if (blocks.length) blocks.push("");
    } else para = para === null ? line : `${para}\n${line}`;
  }
  if (para !== null) blocks.push(para);
  while (blocks.at(-1) === "") blocks.pop();
  return blocks;
}

// Whether the open chat can be pinned: only once it has its first message, because
// `conversations` keeps a pinned chat only when it has one (12). Read by the view too,
// so the button is unavailable exactly when a press would do nothing.
export const canPin = (context) =>
  context.openId != null && context.conversation?.id === context.openId && (context.conversation.turns?.length ?? 0) > 0;

export const machine = setup({
  actors: {
    // The starting picture (4.3): which chat is open, then that chat. conversation.opened
    // is held for us until the open reply lands (open's supersededBy), and
    // conversation.changed until the read reply lands (read's supersededBy), so a change
    // that races the start is applied after it, in order.
    open: fromPromise(({ input }) => input.ask("conversations", "open", {})),
    read: fromPromise(({ input }) => input.ask("conversations", "read", { id: input.id })),
    // pins.changed is held for us until this reply lands (pins: read supersededBy).
    pins: fromPromise(({ input }) => input.ask("pins", "read", {})),
  },
}).createMachine({
  id: "chat-thread",
  meta: {
    description:
      "Shows the open chat: the questions, the answers as they arrive, the model's thinking, " +
      "which can be opened, and the lookups the model made, each named by what it read. Answers " +
      "are written in markdown and drawn as formatted text by a small renderer of our own, " +
      "always as escaped text, so nothing the model writes reaches the page as HTML. It holds " +
      "only the scroll position and which thinking records are open; the chat itself belongs to " +
      "`conversations`. A pin at the top right, on unless the user turns it off, keeps the open " +
      "chat when the subject changes; opening another chat while it is on moves the pin to it, " +
      "and the pin is kept by `pins`, so it survives a reload. A chat with no message yet " +
      "cannot be pinned: its pin is shown unavailable, saying why, until the first message " +
      "is sent, and then it is on unless the user turned pins off.",
    kind: "view",
    attributes: ["height", "markdown"],
    emits: ["pin.toggled"],
    asks: ["conversations: open", "conversations: read", "pins: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // Which chat is open on this device, and its contents, or null when none is open.
    openId: null,
    conversation: null,
    // The chat `pins` holds pinned; the open chat is pinned while the two are the same.
    pin: null,
    pinsObserved: false,
  }),
  initial: "starting",
  invoke: {
    src: "pins",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: {
      guard: ({ context }) => !context.pinsObserved,
      actions: assign({ pin: ({ event }) => (typeof event.output?.chat === "string" ? event.output.chat : null) }),
    },
    onError: { actions: [] },
  },
  on: {
    "pins.changed": { actions: assign({ pin: ({ event }) => event.chat ?? null, pinsObserved: true }) },
    // The user pressed the pin: the gesture goes to `pins` (4.3, fifth rule), and the
    // button turns at once. Nothing to pin until the open chat has its first message.
    _togglePin: {
      guard: ({ context }) => canPin(context),
      actions: [
        assign({ pin: ({ context }) => (context.pin === context.openId ? null : context.openId) }),
        emit(({ context }) => ({ type: "pin.toggled", what: "chat", id: context.pin })),
      ],
    },
    // The open chat changed on this device (12): load the new one, or clear to the
    // empty page when nothing is open.
    "conversation.opened": [
      {
        guard: ({ event }) => event.id == null,
        target: ".empty",
        actions: assign({ openId: null, conversation: null }),
      },
      { target: ".loading", actions: assign({ openId: ({ event }) => event.id }) },
    ],
    // The fact's news about the open chat (4.3, fourth rule): adopt it whole. A change
    // for another chat is left to the bus to record as ignored. Held until the read
    // reply lands (4.2), so it never overtakes the starting picture.
    "conversation.changed": {
      guard: ({ context, event }) => event.id === context.openId,
      actions: assign({ conversation: ({ event }) => asConversation(event) }),
    },
    // The open chat was deleted (4.3): fall back to the empty page.
    "conversation.deleted": {
      guard: ({ context, event }) => event.id === context.openId,
      target: ".empty",
      actions: assign({ openId: null, conversation: null }),
    },
  },
  states: {
    starting: {
      invoke: {
        src: "open",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => event.output?.id == null, target: "empty" },
          { target: "loading", actions: assign({ openId: ({ event }) => event.output.id }) },
        ],
        onError: "empty",
      },
    },
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.openId }),
        onDone: [
          {
            guard: ({ event }) => "conversation" in event.output,
            target: "showing",
            actions: assign({ conversation: ({ event }) => event.output.conversation }),
          },
          { guard: ({ event }) => event.output.error === "unavailable", target: "unavailable" },
          // A chat the server has no record of is an empty new chat (12): the empty page.
          { target: "empty", actions: assign({ conversation: null }) },
        ],
        onError: "unavailable",
      },
    },
    // The chat is on screen; conversation.changed keeps it current from the root.
    showing: {},
    // No chat is open, or an id with no record: the transcript is blank and the box
    // invites a first message.
    empty: {},
    // The server could not be reached (5): the chat says so.
    unavailable: {},
  },
});
