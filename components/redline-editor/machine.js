import { setup, assign, fromPromise, enqueueActions } from "xstate";

// The view component where a pasted markdown text is read and commented (8, the Review
// app): it owns only UI state — the comment being written, the undo windows — and
// points at `redline`, which owns the text and the comments. It asks redline: read for
// the starting picture and follows redline.changed after (4.3); every gesture that
// changes the redline is emitted as the whole redline in redline.saved (4.3, fifth rule).
// The ask and mint arrive through input, so this stays a pure definition importable in
// Node.

// --- Markdown with source offsets -------------------------------------------------------
// Render the text as blocks and inline runs, as chat-thread's renderer does (10), with
// two additions: tables, and the offset in the source where every text run starts, so a
// selection over the rendered page maps back to the exact characters of the pasted file
// (a comment is a range of the source, never of the page). Ours, small and pure; a copy,
// not an import, because components never touch each other (11.2). Every text run is an
// exact substring of the source: source.slice(s, s + value.length) === value.
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
  for (const text of source.split("\n")) {
    lines.push({ text, at });
    at += text.length + 1;
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

// The source is the redline's text, whose line breaks are already "\n" (normaliseText at
// paste), so offsets into it are offsets into what is stored and copied.
export const parseMarkdown = (source) => parseBlocks(toLines(String(source)));

// --- Comments over the source -------------------------------------------------------------

export const normaliseText = (text) => String(text).replace(/\r\n?/g, "\n");

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

// The text as pasted with every comment in CriticMarkup: the fragment between {== and
// ==}, the comment between {>> and <<}. Spliced from the last comment to the first, so
// the offsets of the earlier ones still hold.
export const toCriticMarkup = (text, comments) =>
  [...comments]
    .filter((c) => c.text.trim() !== "")
    .sort((a, b) => b.start - a.start)
    .reduce(
      (out, c) => `${out.slice(0, c.start)}{==${out.slice(c.start, c.end)}==}{>>${c.text.trim()}<<}${out.slice(c.end)}`,
      text,
    );

// The comments to paint: the saved ones, with the one being written in its place (it
// may not be saved yet, or be newer than what was saved), in reading order.
export const marks = ({ redline, draft }) => {
  const saved = redline?.comments ?? [];
  const all = draft ? [...saved.filter((c) => c.id !== draft.id), draft] : saved;
  return [...all].sort((a, b) => a.start - b.start);
};

// --- Decisions ------------------------------------------------------------------------------

const comment = (draft) => ({ id: draft.id, start: draft.start, end: draft.end, quote: draft.quote, text: draft.text });
const withComment = (redline, draft) => ({
  text: redline.text,
  comments: [...redline.comments.filter((c) => c.id !== draft.id), comment(draft)].sort((a, b) => a.start - b.start),
});
const withoutComment = (redline, id) => ({ text: redline.text, comments: redline.comments.filter((c) => c.id !== id) });

// What closing the open comment saves, or null when nothing changes: an empty comment is
// no comment, so one that was saved is removed and a new one is dropped.
const closing = ({ redline, draft }) => {
  if (!redline || !draft) return null;
  const saved = redline.comments.find((c) => c.id === draft.id);
  if (draft.text.trim() === "") return saved ? withoutComment(redline, draft.id) : null;
  if (saved && saved.text === draft.text) return null;
  return withComment(redline, draft);
};

// The ranges a new comment may not overlap: every saved comment but the open one, and the
// open one while it holds any text.
const occupied = ({ redline, draft }) => [
  ...(redline?.comments ?? []).filter((c) => c.id !== draft?.id),
  ...(draft && draft.text.trim() !== "" ? [draft] : []),
];

const saved = (redline) => ({ type: "redline.saved", text: redline.text, comments: redline.comments });

// Close the open comment (saving what it holds) and, for a selection, open a new one.
const closeDraft = enqueueActions(({ context, enqueue }) => {
  const next = closing(context);
  if (next) {
    enqueue.assign({ redline: next });
    enqueue.emit(saved(next));
  }
  enqueue.assign({ draft: null });
});
const openSelection = assign({
  draft: ({ context, event }) => {
    const range = trimRange(context.redline.text, event.start, event.end);
    return { id: context.mint(), ...range, quote: context.redline.text.slice(range.start, range.end), text: event.text ?? "" };
  },
});
const openComment = assign({
  draft: ({ context, event }) => ({ ...context.redline.comments.find((c) => c.id === event.id) }),
});
const canSelect = ({ context, event }) => {
  if (!context.redline) return false;
  const range = trimRange(context.redline.text, event.start, event.end);
  return range != null && !overlaps(occupied(context), range.start, range.end);
};
const isComment = ({ context, event }) =>
  Boolean(context.redline?.comments.some((c) => c.id === event.id)) && !context.discarding.has(event.id);
const isDiscarding = ({ context, event }) => context.discarding.has(event.id);
const typed = assign({ draft: ({ context, event }) => ({ ...context.draft, text: event.text }) });
const save = enqueueActions(({ context, enqueue }) => {
  const next = closing(context);
  if (next) {
    enqueue.assign({ redline: next });
    enqueue.emit(saved(next));
  }
});

const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};
const undo = enqueueActions(({ event, enqueue }) => {
  enqueue.cancel(`undo:${event.id}`);
  enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
});

export const machine = setup({
  actors: {
    read: fromPromise(({ input }) => input.ask("redline", "read", {})),
  },
  delays: {
    throttle: ({ context }) => context.throttleMs,
    undo: ({ context }) => context.undoMs,
  },
}).createMachine({
  id: "redline-editor",
  meta: { kind: "view", emits: ["redline.saved"], attributes: [], asks: ["redline: read"] },
  context: ({ input }) => ({
    ask: input.ask,
    mint: input.mint,
    undoMs: input.undoMs,
    throttleMs: input.throttleMs ?? 200,
    redline: null,
    draft: null,
    discarding: new Set(),
  }),
  initial: "loading",
  on: {
    // The fact's news (4.3): another tab's change, or the echo of our own save. The
    // comment being written stays as typed; it is painted over what was saved.
    "redline.changed": { actions: assign({ redline: ({ event }) => event.redline }) },
  },
  states: {
    // The starting picture (4.3); redline.changed is held for us until it lands (4.2).
    loading: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          { guard: ({ event }) => event.output?.redline != null, target: "marking", actions: assign({ redline: ({ event }) => event.output.redline }) },
          { target: "empty" },
        ],
        onError: "empty",
      },
    },
    // No text under review: the page waits for a paste.
    empty: {
      initial: "idle",
      on: {
        "redline.changed": [
          { guard: ({ event }) => event.redline != null, target: "marking", actions: assign({ redline: ({ event }) => event.redline }) },
          { actions: assign({ redline: null }) },
        ],
        _pasted: {
          guard: ({ event }) => normaliseText(event.text).trim() !== "",
          target: "marking",
          actions: enqueueActions(({ event, enqueue }) => {
            const redline = { text: normaliseText(event.text), comments: [] };
            enqueue.assign({ redline });
            enqueue.emit(saved(redline));
          }),
        },
      },
      states: {
        idle: { on: { _pasteRefused: "refused" } },
        // The browser would not hand over the clipboard: say so for a moment, and how
        // to paste instead.
        refused: { after: { undo: "idle" }, on: { _pasteRefused: { target: "refused", reenter: true } } },
      },
    },
    marking: {
      initial: "idle",
      on: {
        // Another tab cleared the text.
        "redline.changed": [
          { guard: ({ event }) => event.redline == null, target: "empty", actions: assign({ redline: null, draft: null }) },
          { actions: assign({ redline: ({ event }) => event.redline }) },
        ],
        // A comment's ×: the popover closes and the mark dims for the undo window; only
        // its end removes the comment. A comment never saved is simply dropped.
        _remove: [
          {
            guard: ({ context, event }) => context.redline.comments.some((c) => c.id === event.id) && !context.discarding.has(event.id),
            target: ".idle",
            actions: enqueueActions(({ event, enqueue }) => {
              enqueue.assign({ draft: null });
              enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(event.id) });
              enqueue.raise({ type: "_elapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `undo:${event.id}` });
            }),
          },
          { guard: ({ context, event }) => context.draft?.id === event.id, target: ".idle", actions: assign({ draft: null }) },
        ],
        _undo: { guard: isDiscarding, actions: undo },
        _elapsed: {
          guard: isDiscarding,
          actions: enqueueActions(({ context, event, enqueue }) => {
            enqueue.assign({ discarding: without(context.discarding, event.id) });
            if (!context.redline.comments.some((c) => c.id === event.id)) return;
            const next = withoutComment(context.redline, event.id);
            enqueue.assign({ redline: next });
            enqueue.emit(saved(next));
          }),
        },
        // New text: the page empties at once, and the text is only cleared when the
        // undo window ends.
        _clear: { target: "clearing", actions: closeDraft },
      },
      states: {
        idle: {
          on: {
            _selected: [
              { guard: ({ context, event }) => canSelect({ context, event }) && Boolean(event.text), target: "commenting.dirty", actions: openSelection },
              { guard: canSelect, target: "commenting", actions: openSelection },
            ],
            // A click on a comment's mark opens it; on a dimmed one, it is the undo.
            _opened: [
              { guard: isDiscarding, actions: undo },
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
              { guard: isDiscarding, actions: undo },
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
    // The page shows empty with an undo; a paste in the meantime replaces the text.
    clearing: {
      on: {
        _undoClear: "marking",
        _pasted: {
          guard: ({ event }) => normaliseText(event.text).trim() !== "",
          target: "marking",
          actions: enqueueActions(({ event, enqueue }) => {
            const redline = { text: normaliseText(event.text), comments: [] };
            enqueue.assign({ redline });
            enqueue.emit(saved(redline));
          }),
        },
        "redline.changed": [
          { guard: ({ event }) => event.redline == null, target: "empty", actions: assign({ redline: null }) },
          { actions: assign({ redline: ({ event }) => event.redline }) },
        ],
      },
      after: {
        undo: {
          target: "empty",
          actions: enqueueActions(({ enqueue }) => {
            enqueue.assign({ redline: null });
            enqueue.emit({ type: "redline.saved", text: "", comments: [] });
          }),
        },
      },
    },
  },
});
