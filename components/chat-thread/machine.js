import { setup, assign, emit, fromPromise, enqueueActions } from "xstate";

// The view that shows the open conversation (architecture.md 3.1): headless of the
// fact, it owns only its own UI state (the transcript scroll, which thinking records
// are open — all in the view). It asks `conversations` which chat
// is open and reads it for the starting picture (4.3), then follows the conversation
// events for everything after. The question box is a separate view shown through a
// default slot (6.3). Everything with a side effect — the queries, the id source —
// arrives through input, so this stays a pure definition importable in Node. Two
// gestures are its own. The pin (12): it asks `pins` for the pinned chat, follows
// pins.changed, and emits pin.toggled; `conversations` keeps a pinned chat open, and
// `pins` moves an "on" pin to whichever chat opens. The comments on the last answer:
// every change is emitted as the whole list in marks.edited (4.3, fifth rule), and
// `conversations`, which keeps them with the chat, echoes them in conversation.changed.

// A conversation.changed payload is the whole conversation with a `type` on it; the
// read reply is the same shape without the `type`. One helper, so both feed the view
// the same object.
const asConversation = (event) => {
  const { type, ...rest } = event;
  return rest;
};

// Render an assistant answer's markdown to a tree of blocks and inline runs, so the view
// draws bold, headings, lists and tables as formatting rather than raw # and * (10). It is
// ours, small and pure — no vendored library — the reverse of the HTML-to-markdown
// converter in `conversations` (7.7). It returns only data: `text` runs stay text, so the
// view can interpolate every one through Lit as an escaped text node and nothing the model
// wrote ever reaches the page as HTML. A link becomes its text alone, as our other
// converter drops a link's target. Every text run carries `s`, its offset in the answer,
// so a selection over the drawn answer maps back to the answer's exact characters (a
// comment is a range of the answer's text, never of the page). A copy of redline-editor's
// parser, not an import, because components never touch each other (11.2). Every text run
// is an exact substring of the answer: text.slice(s, s + value.length) === value.
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const FENCE = /^\s*```/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)\d+\.\s+(.*)$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const listItem = (line) => UL_ITEM.exec(line.text) || OL_ITEM.exec(line.text);

// A line is { text, at }, `at` being the offset of its first character in the source.
// `tail` is the rest of a line after a stripped prefix; every pattern above captures its
// rest to the end of the line, so the rest's offset is the line's end less its length.
const toLines = (source) => {
  const lines = [];
  let at = 0;
  for (const raw of source.split("\n")) {
    // A "\r" before the break is not text, but still counts in the offsets: an answer is
    // stored as the model wrote it, and a comment's offsets are into that.
    lines.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, at });
    at += raw.length + 1;
  }
  return lines;
};
const tail = (line, rest) => ({ text: rest, at: line.at + line.text.length - rest.length });

// The cells of one table row, each trimmed and keeping its own offset. A `\|` is text.
const cellsOf = (line) => {
  const text = line.text;
  const bounds = [];
  let from = 0;
  for (let k = 0; k <= text.length; k++) {
    if (k === text.length || (text[k] === "|" && text[k - 1] !== "\\")) {
      bounds.push([from, k]);
      from = k + 1;
    }
  }
  if (bounds.length > 1 && text.slice(...bounds[0]).trim() === "") bounds.shift();
  if (bounds.length > 1 && text.slice(...bounds[bounds.length - 1]).trim() === "") bounds.pop();
  return bounds.map(([a, b]) => {
    while (a < b && /\s/.test(text[a])) a += 1;
    while (b > a && /\s/.test(text[b - 1])) b -= 1;
    return { text: text.slice(a, b), at: line.at + a };
  });
};

const isTable = (lines, i) =>
  i + 1 < lines.length &&
  lines[i].text.includes("|") &&
  lines[i + 1].text.includes("-") &&
  DELIMITER.test(lines[i + 1].text) &&
  cellsOf(lines[i]).length === cellsOf(lines[i + 1]).length;

const isBlockStart = (lines, i) => {
  const line = lines[i];
  return HEADING.test(line.text) || QUOTE.test(line.text) || FENCE.test(line.text) || RULE.test(line.text) || Boolean(listItem(line)) || isTable(lines, i);
};

// The parts (one per source line) joined with "\n", with the source offset of every
// character of the joined string; a joining "\n" maps to -1, and becomes a break.
const joined = (parts) => {
  let text = "";
  const map = [];
  parts.forEach((part, k) => {
    if (k) {
      text += "\n";
      map.push(-1);
    }
    for (let j = 0; j < part.text.length; j++) map.push(part.at + j);
    text += part.text;
  });
  return { text, map };
};

// Emphasis and inline code, over [from, to) of the joined text. A `*`/`_` marker only
// opens a span when the character just inside it is not a space (standard markdown), so
// arithmetic like `a * b` and a lone `_` are left as text. Inline code stays on one line,
// so its run is one contiguous stretch of the source. A link becomes its text.
const parseRange = (text, map, from, to) => {
  const nodes = [];
  const find = (marker, at) => {
    const k = text.indexOf(marker, at);
    return k >= 0 && k + marker.length <= to ? k : -1;
  };
  let b = from;
  const flush = (i) => {
    if (i > b) nodes.push({ type: "text", value: text.slice(b, i), s: map[b] });
  };
  let i = from;
  while (i < to) {
    const c = text[i];
    if (c === "\n") {
      flush(i);
      nodes.push({ type: "break" });
      i += 1;
      b = i;
      continue;
    }
    if (c === "`") {
      const end = find("`", i + 1);
      if (end > i + 1 && !text.slice(i + 1, end).includes("\n")) {
        flush(i);
        nodes.push({ type: "code", value: text.slice(i + 1, end), s: map[i + 1] });
        i = end + 1;
        b = i;
        continue;
      }
    }
    if ((c === "*" || c === "_") && text[i + 1] === c && i + 2 < to && text[i + 2] !== " ") {
      const end = find(c + c, i + 2);
      if (end > i + 2 && text[end - 1] !== " ") {
        flush(i);
        nodes.push({ type: "strong", inline: parseRange(text, map, i + 2, end) });
        i = end + 2;
        b = i;
        continue;
      }
    }
    if ((c === "*" || c === "_") && i + 1 < to && text[i + 1] !== " ") {
      const end = find(c, i + 1);
      if (end > i + 1 && text[end - 1] !== " ") {
        flush(i);
        nodes.push({ type: "em", inline: parseRange(text, map, i + 1, end) });
        i = end + 1;
        b = i;
        continue;
      }
    }
    if (c === "[") {
      const close = find("]", i + 1);
      if (close > i && text[close + 1] === "(" && close + 1 < to) {
        const paren = find(")", close + 2);
        if (paren > close) {
          flush(i);
          nodes.push(...parseRange(text, map, i + 1, close));
          i = paren + 1;
          b = i;
          continue;
        }
      }
    }
    i += 1;
  }
  flush(to);
  return nodes;
};

const parseInline = (parts) => {
  const { text, map } = joined(parts);
  return parseRange(text, map, 0, text.length);
};

// One list, ordered or not, from `start`; nested items (indented further) recurse and hang
// under the item above them. Blank lines between items keep one list. A numbered list
// keeps the number it starts at. Returns the list block and the line after it.
const parseList = (lines, start) => {
  const baseIndent = listItem(lines[start])[1].length;
  const ordered = !UL_ITEM.test(lines[start].text);
  const first = ordered ? Number(/\d+/.exec(lines[start].text)[0]) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    if (lines[i].text.trim() === "") {
      let j = i;
      while (j < lines.length && lines[j].text.trim() === "") j += 1;
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
    if (!UL_ITEM.test(lines[i].text) !== ordered) break; // a switch between ordered and not ends the list
    items.push({ blocks: [{ type: "paragraph", inline: parseInline([tail(lines[i], m[2])]) }] });
    i += 1;
  }
  // Trailing blank lines stay outside the list, for the block after it.
  while (i > start && lines[i - 1].text.trim() === "") i -= 1;
  return { list: { type: "list", ordered, start: first, items }, next: i };
};

const parseBlocks = (lines) => {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.text.trim() === "") {
      i += 1;
      continue;
    }
    if (FENCE.test(line.text)) {
      i += 1;
      const code = [];
      while (i < lines.length && !FENCE.test(lines[i].text)) {
        code.push({ value: lines[i].text, s: lines[i].at });
        i += 1;
      }
      i += 1; // the closing fence, if any
      blocks.push({ type: "code", lines: code });
      continue;
    }
    const h = HEADING.exec(line.text);
    if (h) {
      const rest = tail(line, h[2]);
      blocks.push({ type: "heading", level: h[1].length, inline: parseInline([{ text: rest.text.trimEnd(), at: rest.at }]) });
      i += 1;
      continue;
    }
    if (RULE.test(line.text)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line.text)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i].text)) {
        quoted.push(tail(lines[i], QUOTE.exec(lines[i].text)[1]));
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
    if (isTable(lines, i)) {
      const width = cellsOf(line).length;
      const row = (l) => {
        const cells = cellsOf(l).slice(0, width);
        while (cells.length < width) cells.push(null);
        return cells.map((cell) => (cell ? parseInline([cell]) : []));
      };
      const head = row(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].text.trim() !== "" && lines[i].text.includes("|")) {
        rows.push(row(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].text.trim() !== "" && !isBlockStart(lines, i)) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para) });
  }
  return blocks;
};


export const parseMarkdown = (text) => parseBlocks(toLines(String(text)));

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

// One text run split at the edges of the marks (the comments and the one being written,
// sorted, never overlapping), so the view wraps each commented piece in a mark.
export const pieces = (value, s, marks) => {
  const out = [];
  let i = 0;
  for (const m of marks) {
    if (m.end <= s + i || m.start >= s + value.length) continue;
    const a = Math.max(m.start - s, i);
    const b = Math.min(m.end - s, value.length);
    if (a > i) out.push({ text: value.slice(i, a), s: s + i, id: null });
    out.push({ text: value.slice(a, b), s: s + a, id: m.id });
    i = b;
  }
  if (i < value.length) out.push({ text: value.slice(i), s: s + i, id: null });
  return out;
};

// A selected range less the white space at its ends, or null when nothing is left, so a
// double-clicked "word " comments on "word".
export const trimRange = (text, start, end) => {
  let a = Math.max(0, start);
  let b = Math.min(text.length, end);
  while (a < b && /\s/.test(text[a])) a += 1;
  while (b > a && /\s/.test(text[b - 1])) b -= 1;
  return a < b ? { start: a, end: b } : null;
};

export const overlaps = (comments, start, end) => comments.some((c) => c.start < end && start < c.end);

// --- Comments on the last answer ------------------------------------------------------------

// The answer the user may comment on: the chat's last turn, when it is a finished answer
// with text and no lookups pending (the same test `conversations` applies to marks.edited).
// Only the last one, so every earlier part of the chat stays as the model saw it.
export const lastAnswer = (conversation) => {
  const turn = conversation?.turns?.at(-1);
  return turn?.role === "assistant" && turn.status === "done" && turn.text && !turn.calls?.length ? turn : null;
};

// The comments kept with the chat for its last answer; none when they belong to an
// answer that is no longer the last.
export const savedMarks = (conversation) => {
  const answer = lastAnswer(conversation);
  return answer && conversation.marks?.answerId === answer.id ? conversation.marks.marks : [];
};

// The comments to paint: the saved ones, with the one being written in its place (it
// may not be saved yet, or be newer than what was saved), in reading order.
export const marks = ({ conversation, draft }) => {
  const saved = savedMarks(conversation);
  const all = draft ? [...saved.filter((m) => m.id !== draft.id), draft] : saved;
  return [...all].sort((a, b) => a.start - b.start);
};

const asMark = (draft) => ({ id: draft.id, start: draft.start, end: draft.end, quote: draft.quote, comment: draft.comment });
const withMark = (list, draft) => [...list.filter((m) => m.id !== draft.id), asMark(draft)].sort((a, b) => a.start - b.start);
const withoutMark = (list, id) => list.filter((m) => m.id !== id);

// What closing the open comment saves, or null when nothing changes: an empty comment is
// no comment, so one that was saved is removed and a new one is dropped.
const closing = ({ conversation, draft }) => {
  if (!draft || lastAnswer(conversation)?.id !== draft.answerId) return null;
  const list = savedMarks(conversation);
  const saved = list.find((m) => m.id === draft.id);
  if (draft.comment.trim() === "") return saved ? withoutMark(list, draft.id) : null;
  if (saved && saved.comment === draft.comment) return null;
  return withMark(list, draft);
};

// The ranges a new comment may not overlap: every saved comment but the open one, and the
// open one while it holds any text.
const occupied = ({ conversation, draft, discarding }) => [
  ...savedMarks(conversation).filter((m) => m.id !== draft?.id),
  ...[...(discarding?.values() ?? [])].filter((d) => d.answerId === lastAnswer(conversation)?.id).map((d) => d.mark),
  ...(draft && draft.comment.trim() !== "" ? [draft] : []),
];

// The whole list goes to `conversations` (4.3, fifth rule; third rule: self-contained),
// and the chat on screen takes it at once, so the highlight never waits for the echo.
const store = (enqueue, context, list) => {
  const answerId = lastAnswer(context.conversation).id;
  const { marks: _, ...rest } = context.conversation;
  enqueue.assign({ conversation: list.length ? { ...rest, marks: { answerId, marks: list } } : rest });
  enqueue.emit({ type: "marks.edited", conversationId: context.conversation.id, answerId, marks: list });
};

const save = enqueueActions(({ context, enqueue }) => {
  const next = closing(context);
  if (next) store(enqueue, context, next);
});
// Close the open comment, saving what it holds.
const closeDraft = enqueueActions(({ context, enqueue }) => {
  const next = closing(context);
  if (next) store(enqueue, context, next);
  enqueue.assign({ draft: null });
});
const openSelection = assign({
  draft: ({ context, event }) => {
    const answer = lastAnswer(context.conversation);
    const range = trimRange(answer.text, event.start, event.end);
    return { id: context.mint(), ...range, quote: answer.text.slice(range.start, range.end), comment: event.text ?? "", answerId: answer.id };
  },
});
const openComment = assign({
  draft: ({ context, event }) => ({
    ...savedMarks(context.conversation).find((m) => m.id === event.id),
    answerId: lastAnswer(context.conversation).id,
  }),
});
const canSelect = ({ context, event }) => {
  const answer = lastAnswer(context.conversation);
  if (!answer) return false;
  const range = trimRange(answer.text, event.start, event.end);
  return range != null && !overlaps(occupied(context), range.start, range.end);
};
const isComment = ({ context, event }) =>
  savedMarks(context.conversation).some((m) => m.id === event.id) && !context.discarding.has(event.id);
const isDiscarding = ({ context, event }) => context.discarding.has(event.id);
// Undo puts a comment back only on the answer it was removed from.
const canRestore = ({ context, event }) =>
  context.discarding.get(event.id)?.answerId === lastAnswer(context.conversation)?.id;
const typed = assign({ draft: ({ context, event }) => ({ ...context.draft, comment: event.text }) });

const without = (map, id) => {
  const next = new Map(map);
  next.delete(id);
  return next;
};
// A removed comment leaves the saved list at once, so a message sent inside the undo
// window does not carry it; Undo stores it again.
const undo = enqueueActions(({ context, event, enqueue }) => {
  enqueue.cancel(`undo:${event.id}`);
  const { mark } = context.discarding.get(event.id);
  enqueue.assign({ discarding: without(context.discarding, event.id) });
  store(enqueue, context, withMark(savedMarks(context.conversation), mark));
});

// Leaving the chat: what is being written is saved and every undo window ends now,
// because its timer would end on another chat.
const settle = enqueueActions(({ context, enqueue }) => {
  if (lastAnswer(context.conversation)) {
    const next = closing(context);
    if (next) store(enqueue, context, next);
  }
  for (const id of context.discarding.keys()) enqueue.cancel(`undo:${id}`);
  enqueue.assign({ draft: null, discarding: new Map() });
});

// Whether the open chat can be pinned: only once it has its first message, because
// `conversations` keeps a pinned chat only when it has one (12). Read by the view too,
// so the button is unavailable exactly when a press would do nothing.
export const canPin = (context) =>
  context.openId != null && context.conversation?.id === context.openId && (context.conversation.turns?.length ?? 0) > 0;

// The conversation's Vim keys (12, "Vim keys"): what a key pressed on the conversation
// asks for. Ctrl+d and Ctrl+u are the only ones with a modifier; a letter with Ctrl, Alt
// or Cmd belongs to the browser and the desk. `afterG` is whether a g was pressed just
// before, which makes this g the second of gg. "g" alone waits for its second press.
export const vimAction = ({ key, ctrlKey, metaKey, altKey }, afterG = false) => {
  if (metaKey || altKey) return null;
  if (ctrlKey) return { d: "halfDown", u: "halfUp" }[key] ?? null;
  if (key === "g") return afterG ? "top" : "g";
  return { j: "down", k: "up", G: "bottom", i: "type" }[key] ?? null;
};

// Where a scroll action leaves the conversation: a line's height for j and k, half the
// box for Ctrl+d and Ctrl+u, never past either end. Half the box is whole pixels, so
// Ctrl+u undoes Ctrl+d exactly where the browser snaps a scroll to the pixel grid.
export const scrollFor = (action, { top, height, max, line }) => {
  const half = Math.round(height / 2);
  const to = {
    down: top + line,
    up: top - line,
    halfDown: top + half,
    halfUp: top - half,
    top: 0,
    bottom: max,
  }[action];
  return to === undefined ? null : Math.max(0, Math.min(max, to));
};

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
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "chat-thread",
  meta: {
    description:
      "Shows the open chat: the questions, the answers as they arrive, the model's thinking, " +
      "which can be opened, and the lookups the model made, each named by what it read. Answers " +
      "are written in markdown and drawn as formatted text by a small renderer of our own, " +
      "always as escaped text, so nothing the model writes reaches the page as HTML. It holds " +
      "only the scroll position, which thinking records are open, and the comment being " +
      "written; the chat itself belongs to `conversations`. A pin at the top right, on unless " +
      "the user turns it off, keeps the open " +
      "chat when the subject changes; opening another chat while it is on moves the pin to it, " +
      "and the pin is kept by `pins`, so it survives a reload. A chat with no message yet " +
      "cannot be pinned: its pin is shown unavailable, saying why, until the first message " +
      "is sent, and then it is on unless the user turned pins off. In the last finished " +
      "answer the user selects a passage and writes a comment on it, as in Redline: the " +
      "passage is highlighted with a number and the comments are listed under the answer, " +
      "kept with the chat by `conversations` and sent with the next message, after which they " +
      "show read only. The answer's text never changes; removing a comment waits out the undo window. " +
      "The conversation can hold the keyboard, with the focus ring on it. With Vim keys on, " +
      "while it does, j and k scroll it a line, gg and G go to the top and the bottom, Ctrl+d " +
      "and Ctrl+u scroll half the box, and i moves the keyboard into the chat box under it in " +
      "insert mode; Escape in the chat box's normal mode, the second Escape after typing, puts " +
      "the keyboard back on the conversation. These keys never act while the user types in the " +
      "comment box.",
    kind: "view",
    attributes: ["height", "markdown"],
    emits: ["pin.toggled", "marks.edited", "conversation.relinked"],
    asks: ["conversations: open", "conversations: read", "pins: read", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    undoMs: input.undoMs ?? 3000,
    throttleMs: input.throttleMs ?? 200,
    // Which chat is open on this device, and its contents, or null when none is open.
    openId: null,
    conversation: null,
    // The chat `pins` holds pinned; the open chat is pinned while the two are the same.
    pin: null,
    pinsObserved: false,
    // The "Vim keys" preference (12): off until settings says otherwise, and off on a
    // page without a settings fact.
    vimKeys: false,
    // The comment being written on the last answer, and the comments in their undo window.
    draft: null,
    discarding: new Map(),
  }),
  initial: "starting",
  invoke: [
    {
      src: "pins",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ context }) => !context.pinsObserved,
        actions: assign({ pin: ({ event }) => (typeof event.output?.chat === "string" ? event.output.chat : null) }),
      },
      onError: { actions: [] },
    },
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
  ],
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
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
        actions: [settle, assign({ openId: null, conversation: null })],
      },
      { target: ".loading", actions: [settle, assign({ openId: ({ event }) => event.id })] },
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
      actions: assign({ openId: null, conversation: null, draft: null, discarding: new Map() }),
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
    // The chat is on screen; conversation.changed keeps it current. Its last finished
    // answer takes comments, the way Redline's text does.
    showing: {
      initial: "idle",
      on: {
        // A new last answer (a message was sent, or another answer began) ends the
        // comment being written: it belonged to the answer before.
        "conversation.changed": [
          {
            guard: ({ context, event }) =>
              event.id === context.openId && context.draft != null && lastAnswer(event)?.id !== context.draft.answerId,
            target: ".idle",
            actions: assign({ conversation: ({ event }) => asConversation(event), draft: null }),
          },
          {
            guard: ({ context, event }) => event.id === context.openId,
            actions: assign({ conversation: ({ event }) => asConversation(event) }),
          },
        ],
        // A comment's Remove: the box closes, the comment leaves the saved list and stays
        // dimmed for the undo window. A comment never saved is simply dropped.
        _remove: [
          {
            guard: isComment,
            target: ".idle",
            actions: enqueueActions(({ context, event, enqueue }) => {
              const list = savedMarks(context.conversation);
              const mark = list.find((m) => m.id === event.id);
              const answerId = lastAnswer(context.conversation).id;
              enqueue.assign({ draft: null, discarding: new Map(context.discarding).set(event.id, { mark, answerId }) });
              store(enqueue, context, withoutMark(list, event.id));
              enqueue.raise({ type: "_elapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `undo:${event.id}` });
            }),
          },
          { guard: ({ context, event }) => context.draft?.id === event.id, target: ".idle", actions: assign({ draft: null }) },
        ],
        _undo: [
          { guard: canRestore, actions: undo },
          { guard: isDiscarding, actions: assign({ discarding: ({ context, event }) => without(context.discarding, event.id) }) },
        ],
        _elapsed: { guard: isDiscarding, actions: assign({ discarding: ({ context, event }) => without(context.discarding, event.id) }) },
      },
      states: {
        idle: {
          on: {
            _selected: [
              { guard: ({ context, event }) => canSelect({ context, event }) && Boolean(event.text), target: "commenting.dirty", actions: openSelection },
              { guard: canSelect, target: "commenting", actions: openSelection },
            ],
            // A click on a comment's highlight opens it; on a dimmed one, it is the undo.
            _opened: [
              { guard: canRestore, actions: undo },
              { guard: isComment, target: "commenting", actions: openComment },
            ],
          },
        },
        commenting: {
          initial: "clean",
          on: {
            _closed: { target: "idle", actions: closeDraft },
            _selected: [
              { guard: ({ context, event }) => canSelect({ context, event }) && Boolean(event.text), target: "commenting.dirty", reenter: true, actions: [closeDraft, openSelection] },
              { guard: canSelect, target: "commenting", reenter: true, actions: [closeDraft, openSelection] },
            ],
            _opened: [
              { guard: canRestore, actions: undo },
              { guard: ({ context, event }) => event.id === context.draft?.id },
              { guard: isComment, target: "commenting", reenter: true, actions: [closeDraft, openComment] },
            ],
          },
          states: {
            clean: { on: { _typed: { target: "dirty", actions: typed } } },
            dirty: {
              on: {
                // Targetless so the `after` window is not restarted: keystrokes made
                // within it join the one save at its end, a throttle, not a debounce.
                _typed: { actions: typed },
              },
              after: { throttle: { target: "clean", actions: save } },
            },
          },
        },
      },
    },
    // No chat is open, or an id with no record: the transcript is blank and the box
    // invites a first message.
    empty: {},
    // The server could not be reached (5): the chat says so.
    unavailable: {},
  },
});
