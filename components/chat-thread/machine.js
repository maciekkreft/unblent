import { setup, assign, emit, fromPromise, fromCallback, enqueueActions, spawnChild, stopChild } from "xstate";

// The view that shows the open conversation (architecture.md 3.1): headless of the
// fact, it owns only its own UI state (the transcript scroll, which thinking records
// are open — all in the view). It asks `conversations` which chat
// is open and reads it for the starting picture (4.3), then follows the conversation
// events for everything after. The question box is a separate view shown through a
// default slot (6.3). Everything with a side effect — the queries, the id source —
// arrives through input, so this stays a pure definition importable in Node. The
// comments on the last answer:
// every change is emitted as the whole list in marks.edited (4.3, fifth rule), and
// `conversations`, which keeps them with the chat, echoes them in conversation.changed.
// The highlights the same way, in highlights.edited: a selection in an earlier answer, or
// a comment box on the last one left empty; they carry no comment and never go to the model.

// A conversation.changed payload is the whole conversation with a `type` on it; the
// read reply is the same shape without the `type`. One helper, so both feed the view
// the same object.
const asConversation = (event) => {
  const { type, ...rest } = event;
  return rest;
};

// How long a chat's finished turns may wait for the server before the thread says Not
// synced: longer than a save's round trip, so the words show only while the device is
// offline or the server keeps failing, never during an ordinary save (5).
export const NOT_SYNCED_MS = 5000;

// conversations' pending flag for any chat, from a conversation.changed or a read reply:
// each pending news restarts the wait, and the server's acknowledgement ends it.
const watchSync = (of) =>
  enqueueActions(({ context, event, enqueue }) => {
    const chat = of(event);
    if (!chat?.id) return;
    enqueue.cancel(`unsynced:${chat.id}`);
    if (chat.pending === true) enqueue.raise({ type: "_unsynced", id: chat.id }, { delay: NOT_SYNCED_MS, id: `unsynced:${chat.id}` });
    else if (context.unsynced.includes(chat.id)) enqueue.assign({ unsynced: context.unsynced.filter((id) => id !== chat.id) });
  });
const syncOfChange = watchSync((event) => event);
const syncOfRead = watchSync((event) => event.output?.conversation);

// Whether the open chat's finished turns have waited too long for the server.
export const notSynced = (context) => context.openId != null && context.unsynced.includes(context.openId);

// Whether the open chat can go on the stage: only once it has its first message, since a
// chat with none is not kept by `conversations` and a stage tab could not show it again.
// Read by the view too, so Open on stage is disabled exactly when a press would do nothing.
export const canStage = (context) =>
  !context.staged && context.openId != null && context.conversation?.id === context.openId && (context.conversation.turns?.length ?? 0) > 0;

// Whether the open chat has a tab on a stage, from the stages' tabs.shown.
export const isStaged = (context) =>
  context.openId != null && Object.values(context.stageTabs).some((ids) => ids.includes(context.openId));

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

const asHighlight = (draft) => ({ id: draft.id, answerId: draft.answerId, start: draft.start, end: draft.end, quote: draft.quote });

// What closing the open comment saves, or null when nothing changes: the comments, and
// a highlight when the box is left empty. An empty comment is no comment, so one that
// was saved is removed; its passage stays highlighted, kept with the chat and never sent.
const closing = ({ conversation, draft }) => {
  if (!draft || lastAnswer(conversation)?.id !== draft.answerId) return null;
  const list = savedMarks(conversation);
  const saved = list.find((m) => m.id === draft.id);
  if (draft.comment.trim() === "") return { marks: saved ? withoutMark(list, draft.id) : null, highlight: asHighlight(draft) };
  if (saved && saved.comment === draft.comment) return null;
  return { marks: withMark(list, draft), highlight: null };
};

// The ranges a new comment may not overlap: every saved comment but the open one, the
// open one while it holds any text, and the answer's highlights.
const occupied = ({ conversation, draft, discarding, unhighlighting }) => {
  const answerId = lastAnswer(conversation)?.id;
  return [
    ...savedMarks(conversation).filter((m) => m.id !== draft?.id),
    ...[...(discarding?.values() ?? [])].filter((d) => d.answerId === answerId).map((d) => d.mark),
    ...(draft && draft.comment.trim() !== "" ? [draft] : []),
    ...highlightsOf(conversation, answerId),
    ...[...(unhighlighting?.values() ?? [])].filter((h) => h.answerId === answerId),
  ];
};

const markedChat = (conversation, list) => {
  const answerId = lastAnswer(conversation).id;
  const { marks: _, ...rest } = conversation;
  return list.length ? { ...rest, marks: { answerId, marks: list } } : rest;
};

// The whole list goes to `conversations` (4.3, fifth rule; third rule: self-contained),
// and the chat on screen takes it at once, so the highlight never waits for the echo.
const store = (enqueue, context, list) => {
  enqueue.assign({ conversation: markedChat(context.conversation, list) });
  enqueue.emit({ type: "marks.edited", conversationId: context.conversation.id, answerId: lastAnswer(context.conversation).id, marks: list });
};

// What closing saves, in one change of the chat on screen: the comments, then the
// highlight an empty box leaves, once. While the box is still open (the throttle) only
// the comments are saved, since an empty box may yet be typed in.
const keep = (enqueue, context, next, withHighlight = true) => {
  if (!next) return;
  let { conversation } = context;
  if (next.marks) {
    conversation = markedChat(conversation, next.marks);
    enqueue.emit({ type: "marks.edited", conversationId: conversation.id, answerId: lastAnswer(conversation).id, marks: next.marks });
  }
  const made = withHighlight && next.highlight && !(conversation.highlights ?? []).some((h) => h.id === next.highlight.id);
  if (made) {
    const list = [...(conversation.highlights ?? []), next.highlight];
    conversation = highlightedChat(conversation, list);
    enqueue.emit({ type: "highlights.edited", conversationId: conversation.id, highlights: list });
  }
  enqueue.assign({ conversation });
};

const save = enqueueActions(({ context, enqueue }) => keep(enqueue, context, closing(context), false));
// Close the open comment, saving what it holds.
const closeDraft = enqueueActions(({ context, enqueue }) => {
  keep(enqueue, context, closing(context));
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
  if (event.answerId != null && event.answerId !== answer.id) return false;
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
  if (lastAnswer(context.conversation)) keep(enqueue, context, closing(context));
  for (const id of context.discarding.keys()) enqueue.cancel(`undo:${id}`);
  for (const id of context.unhighlighting.keys()) enqueue.cancel(`unhl:${id}`);
  enqueue.assign({ draft: null, discarding: new Map(), chosen: null, unhighlighting: new Map() });
});

// --- Highlights -------------------------------------------------------------------------------

// An answer that can hold highlights: a finished answer with text.
const holdsHighlights = (conversation, answerId) => {
  const turn = conversation?.turns?.find((t) => t.id === answerId);
  return Boolean(turn) && turn.role === "assistant" && turn.status === "done" && Boolean(turn.text);
};

// An answer where a selection is a highlight at once: any but the last one, where a
// selection opens a comment and a box left empty is the highlight.
export const highlightable = (conversation, answerId) =>
  holdsHighlights(conversation, answerId) && answerId !== lastAnswer(conversation)?.id;

export const highlightsOf = (conversation, answerId) => (conversation?.highlights ?? []).filter((h) => h.answerId === answerId);

// The comments that went to the model with the message after an answer, read only.
export const sentMarks = (conversation, answerId) => {
  const turns = conversation?.turns ?? [];
  const k = turns.findIndex((t) => t.id === answerId);
  const next = k >= 0 ? turns[k + 1] : null;
  return next?.role === "user" ? (next.marks ?? []) : [];
};

const answerText = (conversation, answerId) => conversation.turns.find((t) => t.id === answerId).text;

// A highlight never overlaps another one, one in its undo window, or a sent comment.
const canHighlight = ({ context, event }) => {
  const { conversation } = context;
  if (!highlightable(conversation, event.answerId)) return false;
  const range = trimRange(answerText(conversation, event.answerId), event.start, event.end);
  if (!range) return false;
  const removed = [...context.unhighlighting.values()].filter((h) => h.answerId === event.answerId);
  return !overlaps([...highlightsOf(conversation, event.answerId), ...removed, ...sentMarks(conversation, event.answerId)], range.start, range.end);
};

// The whole list goes to `conversations` (4.3, fifth rule), and the chat on screen takes
// it at once, as the comments do.
const highlightedChat = (conversation, list) => {
  const { highlights: _, ...rest } = conversation;
  return list.length ? { ...rest, highlights: list } : rest;
};
const storeHighlights = (enqueue, context, list) => {
  enqueue.assign({ conversation: highlightedChat(context.conversation, list) });
  enqueue.emit({ type: "highlights.edited", conversationId: context.conversation.id, highlights: list });
};

const highlight = enqueueActions(({ context, event, enqueue }) => {
  const text = answerText(context.conversation, event.answerId);
  const range = trimRange(text, event.start, event.end);
  const made = { id: context.mint(), answerId: event.answerId, ...range, quote: text.slice(range.start, range.end) };
  enqueue.assign({ chosen: null });
  storeHighlights(enqueue, context, [...(context.conversation.highlights ?? []), made]);
});

const isHighlight = ({ context, event }) => (context.conversation?.highlights ?? []).some((h) => h.id === event.id);
const isUnhighlighting = ({ context, event }) => context.unhighlighting.has(event.id);

// Undo puts a highlight back while its answer is still there to hold it.
const canRehighlight = ({ context, event }) =>
  context.unhighlighting.has(event.id) && holdsHighlights(context.conversation, context.unhighlighting.get(event.id).answerId);

const rehighlight = enqueueActions(({ context, event, enqueue }) => {
  enqueue.cancel(`unhl:${event.id}`);
  const back = context.unhighlighting.get(event.id);
  enqueue.assign({ unhighlighting: without(context.unhighlighting, event.id) });
  storeHighlights(enqueue, context, [...(context.conversation.highlights ?? []), back]);
});

// The conversation's Vim keys (12, "Vim keys"): what a key pressed on the conversation
// asks for. Ctrl+d and Ctrl+u are the only ones with a modifier; a letter with Ctrl, Alt
// or Cmd belongs to the browser and the desk. `afterG` is whether a g was pressed just
// before, which makes this g the second of gg. "g" alone waits for its second press.
// What a lookup asked for, in plain words (7.7): each payload field as a readable word and
// its value, dates as dates, a chapter counted from 1 as people count it (the payloads
// count from 0), an id as "by its id" since the chat holds no name for it. Pure, so it is
// tested in Node; an empty payload asks for nothing worth saying and gives "".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const dateWords = (text) => {
  const m = DATE.exec(text);
  return m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : text;
};
const FIELD_WORDS = { limit: "at most", contains: "containing", id: "one" };
const fieldWords = (key) => FIELD_WORDS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
const valueWords = (key, value) => {
  if (typeof value === "string") {
    if (ULID.test(value)) return "by its id";
    if (DATE.test(value)) return dateWords(value);
    return `“${value}”`;
  }
  if (key === "chapter" && Number.isInteger(value)) return String(value + 1);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map((v) => valueWords("", v)).join(", ");
  if (value && typeof value === "object") return Object.entries(value).map(([k, v]) => `${fieldWords(k)} ${valueWords(k, v)}`).join(", ");
  return String(value);
};
export const askedFor = (payload) => {
  const parts = Object.entries(payload ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${fieldWords(k)} ${valueWords(k, v)}`);
  const text = parts.join(", ");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
};

// A result's length as people read it: its size is in characters, about six to a word.
export const lengthWords = (size) => {
  const n = Math.round((size ?? 0) / 6);
  return n === 1 ? "About 1 word" : `About ${n} words`;
};

// What a lookup's link opens (7.7), as the event that opens it where the user normally
// sees it: a journal day in the journal (day.selected), a chapter in its book
// (chapter.selected), a book at its saved reading place, as the shelf opens it
// (book.selected). A note or a highlight is asked of `notes` first, since only the
// reply says whether it is a highlight and where its passage is: "ask". Anything else,
// or a link missing what its kind needs, opens nothing: null.
export const openingOf = ({ opens, id, chapter } = {}) => {
  if (typeof id !== "string" || !id) return null;
  if (opens === "journal-day") return { type: "day.selected", id };
  if (opens === "chapter") return Number.isInteger(chapter) && chapter >= 0 ? { type: "chapter.selected", id, chapter } : null;
  if (opens === "book") return { type: "book.selected", id };
  if (opens === "note" || opens === "highlight") return { type: "ask", id };
  return null;
};

// A note read for a link: a highlight (a link to a book with a place) opens in its book at
// the passage, any other note on the stage as a tab of its own; a note that is gone opens
// nothing. The same reading of a highlight as note-editor's passageOf, copied because
// components never import each other (11.2).
export const noteOpening = (reply, id) => {
  const note = reply?.note;
  if (!note || note.id !== id) return null;
  const link = (Array.isArray(note.about) ? note.about : []).find((l) => l.kind === "book" && l.place);
  return link ? { type: "passage.selected", book: link.id, id, place: link.place } : { type: "note.staged", id };
};

// The Journal's book id, fixed by `books` (5), copied because components never import
// each other (11.2): a journal day opens in the Journal, so that is the subject that follows.
const JOURNAL = "00000000000000000000000JRN";

// What a followed link brings in front, as `subject` names a thing (kind and id), so
// `conversations` can keep this chat when the subject that follows is that thing (12).
// A note opens on the stage beside the subject and is named as a note.
export const followedOf = (opening) => {
  if (opening.type === "day.selected") return { kind: "book", id: JOURNAL };
  if (opening.type === "chapter.selected" || opening.type === "book.selected") return { kind: "book", id: opening.id };
  if (opening.type === "passage.selected") return { kind: "book", id: opening.book };
  return { kind: "note", id: opening.id };
};

// The follow, announced just before the event that opens it (4.3, fifth rule).
const follow = (opening) =>
  enqueueActions(({ context, event, enqueue }) => {
    const opens = opening(event);
    if (context.openId) enqueue.emit({ type: "lookup.followed", conversation: context.openId, ...followedOf(opens) });
    enqueue.emit(opens);
  });

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

// A Journal chapter is a day, named by its date (13, Link); a book's never has that
// shape, so the date alone tells the Journal apart without the thread learning about books.
const isDay = (chapter) => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(chapter ?? "");

// A link's chapter fields, taken from the subject when it has an open chapter.
const chapterPart = (subject) =>
  subject?.chapter ? { chapter: subject.chapter, chapterTitle: subject.chapterTitle } : {};

// What the Link or Unlink button would make of the open chat's links, or null when it
// shows none: only on a chat with a message, so with a record, whose first link is to the subject, while the
// subject has an open chapter. Linked to the open chapter, it unlinks to the whole book;
// otherwise it links to the open chapter, which also moves a chat from another chapter.
// Pure, so it is tested in Node; the same rule as the note editor's label.
export function relinkOf(context) {
  const { conversation, subject, openId } = context;
  if (openId == null || !conversation || conversation.id !== openId || !conversation.turns?.length || !subject?.chapter) return null;
  const list = conversation.about ?? [];
  const first = list[0];
  if (!first || first.kind !== subject.kind || first.id !== subject.id) return null;
  const { chapter, chapterTitle, ...whole } = first;
  const unlink = chapter === subject.chapter;
  const next = unlink ? whole : { ...whole, ...chapterPart(subject) };
  return {
    about: [next, ...list.slice(1)],
    label: unlink ? "Unlink" : "Link to " + subject.chapterTitle,
  };
}

// The chapter label at the top of the chat: the chapter the chat's first link names, as
// its title read when it was linked, so it shows whichever chapter is open; or the whole
// book; and the button relinkOf offers. A new chat shows the chapter it will be linked to
// at its first message, without a button, since there is no chat yet to change. Null for a
// chat linked to nothing, while no subject is known for a new chat, and while a chat loads.
export function chapterLabelOf(snapshot) {
  const { conversation, subject } = snapshot.context;
  const whole = (journal) => (journal ? "Whole Journal" : "Whole book");
  // A chat with no message yet is new too: `conversations` answers an id it has no chat
  // for with an empty one, and its links are written with the first message.
  if (snapshot.matches("empty") || (snapshot.matches("showing") && !conversation?.turns?.length)) {
    if (!subject) return null;
    return { text: subject.chapterTitle ?? whole(isDay(subject.chapter)), linked: Boolean(subject.chapter), action: null };
  }
  if (!snapshot.matches("showing")) return null;
  const link = conversation?.about?.[0];
  if (!link) return null;
  const ofSubject = subject != null && link.kind === subject.kind && link.id === subject.id;
  const journal = isDay(link.chapter) || (ofSubject && isDay(subject.chapter));
  return {
    text: link.chapterTitle ?? whole(journal),
    linked: Boolean(link.chapter),
    action: relinkOf(snapshot.context)?.label ?? null,
  };
}

export const machine = setup({
  actors: {
    // The starting picture (4.3): which chat is open, then that chat. conversation.opened
    // is held for us until the open reply lands (open's supersededBy), and
    // conversation.changed until the read reply lands (read's supersededBy), so a change
    // that races the start is applied after it, in order.
    open: fromPromise(({ input }) => input.ask("conversations", "open", {})),
    read: fromPromise(({ input }) => input.ask("conversations", "read", { id: input.id })),
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // What is on the stage, for the chapter label (12). subject.changed that races it is
    // held for us until the reply lands (subject: read supersededBy).
    subject: fromPromise(({ input }) => input.ask("subject", "read", {})),
    // A link to a note or a highlight asks notes for it beside whatever the thread is
    // doing; the reply comes back as _noteRead.
    note: fromCallback(({ input, sendBack }) => {
      input.ask("notes", "read", { id: input.id }).then(
        (reply) => sendBack({ type: "_noteRead", id: input.id, reply }),
        () => sendBack({ type: "_noteRead", id: input.id, reply: null }),
      );
    }),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
  },
}).createMachine({
  id: "chat-thread",
  meta: {
    description:
      "Shows the open chat: the questions, the answers as they arrive, the model's thinking, " +
      "which can be opened, and the lookups the model made, each named by what it read; a lookup " +
      "opens like the thinking to show what was asked for and what came back, each entry with its " +
      "short text, and a name in it is a link, reached with Tab, that opens what it names where it " +
      "is normally seen while the chat keeps its place: a note on the stage as a tab of its own, a " +
      "highlight in its book at its passage, a journal day in the journal, a chapter in its book, and " +
      "the book of Where you are in it at its saved reading place, as the shelf opens it. Just " +
      "before it opens one it says which chat the link was in and what it brings in front, so " +
      "`conversations` keeps that chat open when the subject changes to it. Answers " +
      "are written in markdown and drawn as formatted text by a small renderer of our own, " +
      "always as escaped text, so nothing the model writes reaches the page as HTML. It holds " +
      "only the scroll position, which thinking records are open, and the comment being " +
      "written; the chat itself belongs to `conversations`. At the top left plain muted " +
      "text names the chapter the chat is linked to, as the chapter's title read when it " +
      "was linked, or \"Whole book\" (\"Whole Journal\") when it is linked to no chapter; " +
      "a new chat shows the chapter it will be linked to. While the chat's book is the " +
      "subject and a chapter is open, the label offers one button, shown only while the pointer " +
      "or the keyboard is on the label (a tap on a phone): Unlink, when the chat is " +
      "linked to the open chapter, which links it to the whole book, or \"Link to\" and the " +
      "open chapter's title otherwise, which also moves it from another chapter; the label " +
      "turns at once, and pressing again reverses it. A muted \"Not synced\" shows under the " +
      "chat only while its finished turns have waited more than five seconds for the server " +
      "(offline, or the server failing), and goes when the server has them. In the last finished " +
      "answer the user selects a passage and writes a comment on it, as in Redline: the " +
      "passage is highlighted with a number and the comments are listed under the answer, " +
      "kept with the chat by `conversations` and sent with the next message, after which they " +
      "show read only. A comment box left empty leaves its passage highlighted instead, and " +
      "in every earlier answer a selection is a highlight at once; a highlight has no comment " +
      "and no number, and the highlights are kept with the chat by `conversations` " +
      "and never sent to the model. A click on one offers Remove, which waits out the undo window. " +
      "The answer's text never changes; removing a comment waits out the undo window. " +
      "A failed answer says why in plain words under it; when Ollama on the user's Mac did not " +
      "answer, it reads \"Ollama isn't running. Open the Ollama app, or get it at ollama.com.\" " +
      "The conversation can hold the keyboard, with the focus ring on it. With Vim keys on, " +
      "while it does, j and k scroll it a line, gg and G go to the top and the bottom, Ctrl+d " +
      "and Ctrl+u scroll half the box, and i moves the keyboard into the chat box under it in " +
      "insert mode; Escape in the chat box's normal mode, the second Escape after typing, puts " +
      "the keyboard back on the conversation. These keys never act while the user types in the " +
      "comment box. Its header also has Open on stage, at the top right, which shows the chat on " +
      "the stage as a tab of its own (and `:tab split` or `:tab sp` in the chat box while Vim " +
      "keys is on); the button is accent while the chat has a tab there, its arrow points towards " +
      "the stage, also after the desk moves its dock, and it is disabled until the chat has its " +
      "first message. With `stage` it is the chat a stage shows for a chat tab: it follows no " +
      "chat opened elsewhere, has no Open on stage, and shows the chat the stage names by `load`; " +
      "the chat itself is the same as in the Chats panel.",
    kind: "view",
    attributes: ["height", "markdown", "stage"],
    emits: ["marks.edited", "highlights.edited", "conversation.relinked", "conversation.staged", "note.staged", "day.selected", "chapter.selected", "book.selected", "passage.selected", "lookup.followed"],
    asks: ["conversations: open", "conversations: read", "settings: read", "subject: read", "notes: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    // The `stage` attribute: the chat a stage shows for a chat tab, told what to show by
    // `load` alone.
    staged: Boolean(input.staged),
    // The tab ids each stage last announced (tabs.shown), by the stage's address, so the
    // Open on stage button knows whether the open chat is there already.
    stageTabs: {},
    // How many desk layouts it has seen (dock.changed): a dock moved without changing size
    // fires no resize, so this is what tells the view to point the arrow again.
    layouts: 0,
    undoMs: input.undoMs ?? 3000,
    throttleMs: input.throttleMs ?? 200,
    // Which chat is open on this device, and its contents, or null when none is open.
    openId: null,
    conversation: null,
    // The chats whose finished turns have waited longer than NOT_SYNCED_MS for the server.
    unsynced: [],
    // The "Vim keys" preference (12): off until settings says otherwise, and off on a
    // page without a settings fact.
    vimKeys: false,
    // The subject on the stage, from subject: read then subject.changed; null until known,
    // whenever nothing on the stage is a subject, and on a page without a subject fact.
    subject: null,
    // The comment being written on the last answer, and the comments in their undo window.
    draft: null,
    discarding: new Map(),
    // The highlight whose bubble is open, and the highlights in their undo window.
    chosen: null,
    unhighlighting: new Map(),
  }),
  initial: "starting",
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "subject",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ subject: ({ event }) => event.output?.subject ?? null }) },
      onError: { actions: [] },
    },
  ],
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    "subject.changed": { actions: assign({ subject: ({ event }) => event.subject ?? null }) },
    // The chapter label's button (4.3, fifth rule): the gesture goes to `conversations`
    // with the chat's new links, and the label turns at once; the echo in
    // conversation.changed brings back what the fact now holds. Pressed again, it reverses.
    _relink: {
      guard: ({ context }) => relinkOf(context) != null,
      actions: enqueueActions(({ context, enqueue }) => {
        const { about } = relinkOf(context);
        enqueue.assign({ conversation: { ...context.conversation, about } });
        enqueue.emit({ type: "conversation.relinked", id: context.openId, about });
      }),
    },
    // The open chat changed on this device (12): load the new one, or clear to the
    // empty page when nothing is open. The stage's chat shows only what `load` names.
    "conversation.opened": [
      {
        guard: ({ context, event }) => !context.staged && event.id == null,
        target: ".empty",
        actions: [settle, assign({ openId: null, conversation: null })],
      },
      { guard: ({ context }) => !context.staged, target: ".loading", actions: [settle, assign({ openId: ({ event }) => event.id })] },
    ],
    // A command addressing this instance (4.4): the stage names the chat of its tab.
    load: {
      guard: ({ context }) => context.staged,
      target: ".loading",
      actions: [settle, assign({ openId: ({ event }) => event.id })],
    },
    "tabs.shown": {
      actions: assign({ stageTabs: ({ context, event }) => ({ ...context.stageTabs, [event.view]: event.tabs.map((t) => t.id) }) }),
    },
    "dock.changed": { actions: assign({ layouts: ({ context }) => context.layouts + 1 }) },
    // Open on stage (4.3, fifth rule): the stage decides what that means. Pressed again
    // while the chat is on the stage, it brings that tab to the front.
    _stage: {
      guard: ({ context }) => canStage(context),
      actions: emit(({ context }) => ({ type: "conversation.staged", id: context.openId })),
    },
    // A link in an opened lookup (7.7): the thing it names opens where the user normally
    // sees it, through the event that opens it there (4.3, fifth rule); the chat itself
    // stays as it is. A second link to a note replaces one still being asked about.
    _open: [
      { guard: ({ event }) => openingOf(event)?.type === "ask", actions: [stopChild("note"), spawnChild("note", { id: "note", input: ({ context, event }) => ({ ask: context.ask, id: event.id }) })] },
      { guard: ({ event }) => openingOf(event) != null, actions: follow((event) => openingOf(event)) },
    ],
    _noteRead: { guard: ({ event }) => noteOpening(event.reply, event.id) != null, actions: follow((event) => noteOpening(event.reply, event.id)) },
    // notes: read is asked only to open a link, once, and the thread keeps nothing of the
    // reply; a note's later news (4.3, fourth rule) has nothing here to bring up to date,
    // and the next link asks again.
    "note.changed": { actions: () => {} },
    "note.deleted": { actions: () => {} },
    // The fact's news about the open chat (4.3, fourth rule): adopt it whole. A change
    // for another chat is left to the bus to record as ignored. Held until the read
    // reply lands (4.2), so it never overtakes the starting picture.
    "conversation.changed": [
      {
        guard: ({ context, event }) => event.id === context.openId,
        actions: [syncOfChange, assign({ conversation: ({ event }) => asConversation(event) })],
      },
      { actions: syncOfChange },
    ],
    _unsynced: {
      guard: ({ context, event }) => !context.unsynced.includes(event.id),
      actions: assign({ unsynced: ({ context, event }) => [...context.unsynced, event.id] }),
    },
    // The open chat was deleted (4.3): fall back to the empty page.
    "conversation.deleted": {
      guard: ({ context, event }) => event.id === context.openId,
      target: ".empty",
      actions: assign({ openId: null, conversation: null, draft: null, discarding: new Map(), chosen: null, unhighlighting: new Map() }),
    },
  },
  states: {
    starting: {
      // The stage's chat opens nothing by itself.
      always: { guard: ({ context }) => context.staged, target: "empty" },
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
            actions: [syncOfRead, assign({ conversation: ({ event }) => event.output.conversation })],
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
            actions: [syncOfChange, assign({ conversation: ({ event }) => asConversation(event), draft: null })],
          },
          {
            guard: ({ context, event }) => event.id === context.openId,
            actions: [syncOfChange, assign({ conversation: ({ event }) => asConversation(event) })],
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
        // A selection in an earlier answer: a highlight at once. The last answer's
        // selections are taken by the comment states below before they reach here.
        _selected: { guard: canHighlight, actions: highlight },
        // A click on a highlight opens its bubble; on a dimmed one, it is the undo.
        _highlightOpened: [
          { guard: canRehighlight, actions: rehighlight },
          { guard: isHighlight, actions: assign({ chosen: ({ event }) => event.id }) },
        ],
        _highlightClosed: { actions: assign({ chosen: null }) },
        // Remove: the highlight leaves the list at once and stays dimmed, its bubble
        // offering Undo, until the undo window ends.
        _unhighlight: {
          guard: isHighlight,
          actions: enqueueActions(({ context, event, enqueue }) => {
            const list = context.conversation.highlights;
            const gone = list.find((h) => h.id === event.id);
            enqueue.assign({ chosen: event.id, unhighlighting: new Map(context.unhighlighting).set(event.id, gone) });
            storeHighlights(enqueue, context, list.filter((h) => h.id !== event.id));
            enqueue.raise({ type: "_highlightElapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `unhl:${event.id}` });
          }),
        },
        _rehighlight: { guard: canRehighlight, actions: rehighlight },
        _highlightElapsed: {
          guard: isUnhighlighting,
          actions: assign({
            unhighlighting: ({ context, event }) => without(context.unhighlighting, event.id),
            chosen: ({ context, event }) => (context.chosen === event.id ? null : context.chosen),
          }),
        },
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
