import { setup, assign, fromPromise, emit, enqueueActions, raise, cancel, and, not, stateIn } from "xstate";

// The view component that reads one book (8, kind 4): it owns only UI state — which
// book and chapter it is showing, that chapter's fragment, a place it still owes the
// view to open, and the place it last announced — and points at `books`, which owns
// the fact. It asks books: read for the book (and its saved position) when a book is
// selected, and books: chapter for each chapter's fragment, then follows book.changed
// and book.deleted after (4.3, fourth rule). It never holds a copy of a book it would
// be sad to lose; the position is the one thing it produces, announced as
// book.progressed at a short throttle after a page turn settles (Decision 4).
//
// Rendering, pagination and the page a block sits on are the view's job (view.js);
// the machine only knows a chapter is a fragment and a place is { chapter, block }.
// Everything with a side effect — the queries — arrives through input, so this stays
// a pure definition importable in Node.

// The pause after a page turn the announcement waits for (Decision 4): a further turn
// records the new place but does not restart the window, so a run of turns announces
// once, the note-editor throttle rather than a debounce (4.3, third rule).
const PROGRESS_MS = 600;

// Only the fields the reader needs are kept from a read reply or a book.changed (both
// carry the whole book, 4.3, third rule): the chapter titles and count for the footer,
// the versions to tell a newer change from an echo, the saved position to open at.
const pickBook = (b) => ({
  id: b.id,
  title: b.title,
  author: b.author,
  chapters: b.chapters,
  position: b.position,
  version: b.version,
  contentVersion: b.contentVersion,
});

const samePos = (a, b) => Boolean(a && b && a.chapter === b.chapter && a.block === b.block);

// The book.changed news for the open book is either the echo of a place this reader
// announced (same position as what it last sent), a re-import (a new contentVersion,
// so the fragments changed and the chapter must be re-fetched), or another device's
// move (a newer version at a different place). Each is decided by a guard below.
// While a turn is still unannounced (ready.dirty) no news moves the reader: `books`
// has not heard that turn yet, so the ack of an earlier place would read as a move.
const isOurs = ({ context, event }) => Boolean(context.book) && event.id === context.book.id;
const reimported = (args) => isOurs(args) && args.event.contentVersion !== args.context.book.contentVersion;
const movedElsewhere = (args) =>
  isOurs(args) &&
  args.event.version > args.context.book.version &&
  !samePos(args.event.position, args.context.sent);

// --- Highlights (Decision 1-4, session 2) ----------------------------------------
//
// A highlight is one ordinary note whose link to the book carries a place and a quote
// (12). The mouse and the reader's Vim highlight (below) both produce the _highlight
// message, so the geometry stays out of here — the machine works on
// text positions (block, offset) alone, never pixels or pages. `texts` is one string
// per block of the chapter (the concatenation of a block's descendant text nodes, what
// the view's #textNodes computes); a range is { start, end }, each a { block, offset },
// end exclusive; offsets count UTF-16 code units.

// A letter, number, mark, or the apostrophes a word can carry: what a highlight grows
// out to, so a drag that stops mid-word takes the whole word (Decision 3).
const WORD = /[\p{L}\p{N}\p{M}'’]/u;
const isWord = (ch) => ch != null && WORD.test(ch);
const isSpace = (ch) => ch != null && /\s/u.test(ch);

// start before end, comparing block then offset. Equal is not before.
const before = (a, b) => a.block < b.block || (a.block === b.block && a.offset < b.offset);

// One step forward from a position across the chapter's blocks, and one step back, so
// trimming can cross a block boundary. Null at the very ends.
const forward = (texts, p) => {
  if (p.offset < texts[p.block].length) return { block: p.block, offset: p.offset + 1 };
  if (p.block + 1 < texts.length) return { block: p.block + 1, offset: 0 };
  return null;
};
const charAfter = (texts, p) => (p.offset < texts[p.block].length ? texts[p.block][p.offset] : null);
const charBefore = (texts, p) => (p.offset > 0 ? texts[p.block][p.offset - 1] : null);

// Grow both ends to word boundaries, then trim surrounding white space; null when
// nothing but space is left (Decision 3). Growing stays inside a block (a word does not
// span the importer's blocks); trimming may cross a boundary a selection dragged over.
// A keyboard highlight is not grown (`grow` false): the passage painted while it was
// made, letter by letter if h and l made it, is exactly what is marked.
export const snapToWords = (texts, range, { grow = true } = {}) => {
  let start = { ...range.start };
  let end = { ...range.end };
  // Grow an end that sits inside a word out to the word's edge; an end already at a
  // boundary (against space or punctuation) is left for the trim below, so a selection
  // that stops at a space does not swallow the next word.
  while (grow && start.offset > 0 && isWord(texts[start.block][start.offset]) && isWord(texts[start.block][start.offset - 1])) {
    start.offset -= 1;
  }
  while (grow && end.offset < texts[end.block].length && isWord(texts[end.block][end.offset]) && isWord(texts[end.block][end.offset - 1])) {
    end.offset += 1;
  }
  // Trim leading white space forward, trailing white space back.
  while (before(start, end) && isSpace(charAfter(texts, start))) start = forward(texts, start);
  while (before(start, end) && isSpace(charBefore(texts, end))) end = { block: end.block, offset: end.offset - 1 };
  // A trim that emptied a block steps back to the previous block's end.
  while (before(start, end) && end.offset === 0 && end.block > start.block) {
    end = { block: end.block - 1, offset: texts[end.block - 1].length };
    while (before(start, end) && isSpace(charBefore(texts, end))) end = { block: end.block, offset: end.offset - 1 };
  }
  return before(start, end) ? { start, end } : null;
};

// The quoted text and a little of its surroundings, so the passage can be found again
// after a re-import (12): exact is the range's text, blocks joined with "\n"; prefix and
// suffix are up to 32 characters before the start and after the end, each in its block.
const CONTEXT = 32;
export const quoteOf = (texts, range) => {
  const { start, end } = range;
  const parts = [];
  if (start.block === end.block) parts.push(texts[start.block].slice(start.offset, end.offset));
  else {
    parts.push(texts[start.block].slice(start.offset));
    for (let b = start.block + 1; b < end.block; b += 1) parts.push(texts[b]);
    parts.push(texts[end.block].slice(0, end.offset));
  }
  return {
    exact: parts.join("\n"),
    prefix: texts[start.block].slice(Math.max(0, start.offset - CONTEXT), start.offset),
    suffix: texts[end.block].slice(end.offset, end.offset + CONTEXT),
  };
};

// Two ranges overlap, counting a touch (one's end at the other's start) as overlap, so
// a new highlight that merely abuts an old one is treated as the same passage (Decision 6).
export const overlaps = (a, b) => !(before(a.end, b.start) || before(b.end, a.start));

// One range wholly inside another: a drag that lands inside an existing highlight changes
// nothing (Decision 6; session 3 opens that highlight's bubble). Touching an edge counts
// as inside, so a drag on exactly the highlight's own text is a no-op, not a merge.
const contains = (outer, inner) => !before(inner.start, outer.start) && !before(outer.end, inner.end);

// The smallest range covering a set of overlapping ranges (Decision 6): the earliest start
// and the latest end. The set is never empty (the new drag is always one of them).
export const union = (ranges) =>
  ranges.reduce((u, r) => ({
    start: before(r.start, u.start) ? r.start : u.start,
    end: before(u.end, r.end) ? r.end : u.end,
  }));

// The comments of the merged highlights, in book order, kept and stacked with a blank line
// between (Decision 6). A bare highlight has no comment and adds no gap, so a merge with
// one commented and one blank highlight keeps just the comment.
export const joined = (bodies) => bodies.filter((b) => b.trim() !== "").join("\n\n");

// A highlight's title is its comment's first line that says anything (12), so a merged note's title reads from its
// joined comment and a list row can still tell a commented highlight from a bare one.
const titleOf = (body) => {
  const line = body.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : "";
};

// A range split per block into the [from, to) the view paints, empty blocks dropped.
export const segments = (range, texts) => {
  const { start, end } = range;
  const out = [];
  for (let b = start.block; b <= end.block; b += 1) {
    const from = b === start.block ? start.offset : 0;
    const to = b === end.block ? end.offset : texts[b].length;
    if (from < to) out.push({ block: b, from, to });
  }
  return out;
};

// --- Highlighting from the keyboard (12, "Vim keys"; 14) ------------------------------
//
// Where the text motions of the reader's Vim cursor land: w and b by word, ) and ( by
// sentence, } to the end of a block and { to its start, l and h by character. Decided
// here, on the block texts, so they are tested in Node; only the line motions (0, $, j, k) need the page's geometry
// and stay in the view. The chapter is one flat string, its blocks joined by a separator
// that is never text, and a cursor is an index into it that sits on a character the page
// shows: a non-space, or the one space a run of white space between two words collapses
// to. Motions stop at the chapter's edges, since a highlight's place is in one chapter.
const SEP = "\u0000";
const blank = (c) => c === SEP || /\s/u.test(c);

export const chapterText = (texts) => {
  const starts = [];
  let at = 0;
  for (const t of texts) {
    starts.push(at);
    at += t.length + 1;
  }
  return { flat: texts.join(SEP), starts };
};

// A flat index as a place; an index on a separator (or past the end) is the end of the
// block before it, which is where an exclusive range end after a block's last character
// belongs.
export const pointAt = ({ starts }, i) => {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return { block: lo, offset: i - starts[lo] };
};

export const indexOf = ({ starts }, p) => starts[p.block] + p.offset;

const shown = (flat, i) => {
  if (i < 0 || i >= flat.length || flat[i] === SEP) return false;
  if (!blank(flat[i])) return true;
  if (i === 0 || blank(flat[i - 1])) return false;
  let j = i + 1;
  while (j < flat.length && blank(flat[j]) && flat[j] !== SEP) j += 1;
  return j < flat.length && flat[j] !== SEP;
};
const wordStart = (flat, i) => !blank(flat[i]) && (i === 0 || blank(flat[i - 1]));
// The first non-space of a block: only white space back to the separator.
const blockStart = (flat, i) => {
  if (blank(flat[i])) return false;
  let j = i - 1;
  while (j >= 0 && blank(flat[j]) && flat[j] !== SEP) j -= 1;
  return j < 0 || flat[j] === SEP;
};
// A sentence starts a block, or follows white space after a full stop, question or
// exclamation mark, with any closing quote or bracket between.
const sentenceStart = (flat, i) => {
  if (blockStart(flat, i)) return true;
  if (blank(flat[i]) || !blank(flat[i - 1])) return false;
  let j = i - 1;
  while (j >= 0 && blank(flat[j])) j -= 1;
  while (j >= 0 && /["'”’)\]]/u.test(flat[j])) j -= 1;
  return j >= 0 && /[.!?]/u.test(flat[j]);
};

// The last non-space of a block: only white space on to the separator. Where } stops, so
// a highlight begun there with v ends inside the paragraph, not on the next one's first
// letter (Vim's } lands on the blank line between paragraphs, which a page does not have).
const blockEnd = (flat, i) => {
  if (blank(flat[i])) return false;
  let j = i + 1;
  while (j < flat.length && blank(flat[j]) && flat[j] !== SEP) j += 1;
  return j >= flat.length || flat[j] === SEP;
};

const seek = (flat, i, dir, ok) => {
  for (let k = i + dir; k >= 0 && k < flat.length; k += dir) if (ok(flat, k)) return k;
  return null;
};

const MOTIONS = {
  w: [1, wordStart],
  b: [-1, wordStart],
  ")": [1, sentenceStart],
  "(": [-1, sentenceStart],
  "}": [1, blockEnd],
  "{": [-1, blockStart],
};

export const isMotion = (key) => Object.hasOwn(MOTIONS, key);

// One shown character on (+1) or back (-1): what l and h move the cursor by, and what
// the line motions walk a line by (12, "Vim keys"). A run of white space is the one
// space it collapses to.
export const charStep = ({ flat }, i, dir) => seek(flat, i, dir, shown) ?? i;

// The cursor after one motion. Past the last word, sentence or block it goes to the
// chapter's last character, and before the first to its first, as Vim does.
export const step = ({ flat }, i, key) => {
  const [dir, ok] = MOTIONS[key];
  return seek(flat, i, dir, ok) ?? (dir > 0 ? seek(flat, flat.length, -1, shown) : seek(flat, -1, 1, shown)) ?? i;
};

// The passage a highlight begun at `start` covers with the cursor at `cursor`, as
// [from, to) flat indexes. The cursor is the character the next keypress acts on, so when
// it has moved forward onto the start of a word, sentence or paragraph (w, ), j onto a
// new word) that start is where the passage stops, not part of it: v w w covers two
// whole words. Moving back, the cursor's character is the passage's first. A cursor
// moved by a letter (h, l: `letter` true) keeps its character in the passage either
// way, as Vim's visual mode does, so each l shows one more letter. White space at
// either end is dropped.
export const passage = ({ flat }, start, cursor, letter = false) => {
  let lo = Math.min(start, cursor);
  let hi = Math.max(start, cursor);
  if (!letter && cursor > start && wordStart(flat, cursor)) hi = cursor - 1;
  while (hi > lo && blank(flat[hi])) hi -= 1;
  while (lo < hi && blank(flat[lo])) lo += 1;
  return [lo, hi + 1];
};

// The sentence or the paragraph holding the cursor (Vim's is and ip, after y), as
// [from, to) flat indexes: from the start of the sentence or block at or before the
// cursor to the last shown character before the next one, white space at the end left
// out. A sentence never runs past its block.
export const textObject = ({ flat }, i, kind) => {
  const starts = kind === "s" ? sentenceStart : blockStart;
  let from = i;
  while (from > 0 && flat[from] !== SEP && !starts(flat, from)) from -= 1;
  if (flat[from] === SEP) from += 1;
  let to = i + 1;
  while (to < flat.length && flat[to] !== SEP && !(kind === "s" && sentenceStart(flat, to))) to += 1;
  while (to > from && blank(flat[to - 1])) to -= 1;
  while (from < to && blank(flat[from])) from += 1;
  return [from, to];
};

// The text copied for a passage of the chapter, as the page shows it: each run of white
// space one space, and blocks a blank line apart, the way an editor stores paragraphs,
// so a paste into a note keeps them.
export const passageText = ({ flat }, from, to) =>
  flat
    .slice(from, to)
    .split(SEP)
    .map((t) => t.replace(/\s+/gu, " ").trim())
    .filter((t) => t !== "")
    .join("\n\n");

// A finger's passage, decided here on flat text and measured boxes, so it is tested
// in Node. The word holding an index, as [from, to): a word is what lies between blanks, so
// a full stop comes with its sentence's last word. On a blank, the word before it; with
// none in the chapter before it, the one after.
export const wordAround = ({ flat }, i) => {
  let at = i;
  while (at > 0 && blank(flat[at])) at -= 1;
  while (at < flat.length - 1 && blank(flat[at])) at += 1;
  let from = at;
  let to = at + 1;
  while (from > 0 && !blank(flat[from - 1])) from -= 1;
  while (to < flat.length && !blank(flat[to])) to += 1;
  return [from, to];
};

// The passage with the finger over index `i`, from the fixed `word` the hold started on.
// Which way it runs depends only on `i` against that word, so nothing else can flip it. It
// grows by whole words as the finger reaches them; the finger on a blank has reached the
// word behind it, and not yet the one ahead.
export const fingerPassage = (chapter, [from, to], i) => {
  const { flat } = chapter;
  let at = i;
  if (at >= from) {
    while (at > from && blank(flat[at])) at -= 1;
    return passage(chapter, from, Math.max(wordAround(chapter, at)[1], to) - 1, true);
  }
  while (at < from && blank(flat[at])) at += 1;
  return passage(chapter, to - 1, wordAround(chapter, at)[0], true);
};

// Measured characters, in reading order, gathered into the lines they sit on: a character
// joins the line before it when their boxes share more than half their height.
export const linesOf = (chars) => {
  const lines = [];
  for (const c of chars) {
    const line = lines.at(-1);
    if (line && Math.abs(c.top - line.top) < Math.min(c.bottom - c.top, line.bottom - line.top) / 2) {
      line.left = Math.min(line.left, c.left);
      line.right = Math.max(line.right, c.right);
      line.chars.push(c);
    } else {
      lines.push({ top: c.top, bottom: c.bottom, left: c.left, right: c.right, chars: [c] });
    }
  }
  return lines;
};

// The box of each line a passage [from, to) has characters on, top to bottom.
export const lineBoxes = (lines, from, to) =>
  lines.flatMap((line) => {
    const on = line.chars.filter((c) => c.i >= from && c.i < to);
    if (on.length === 0) return [];
    return [{ left: Math.min(...on.map((c) => c.left)), right: Math.max(...on.map((c) => c.right)), top: line.top, bottom: line.bottom }];
  });

const away = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);

// The index of the character nearest a point: on the nearest line, then the nearest along
// it, so a point in a gap, a margin or past the end still names text, and moving it down a
// page never moves the answer up. Null when there are no lines.
export const charNear = (lines, x, y) => {
  let line = null;
  for (const l of lines) {
    if (!line || away(y, l.top, l.bottom) < away(y, line.top, line.bottom) || (away(y, l.top, l.bottom) === away(y, line.top, line.bottom) && away(x, l.left, l.right) < away(x, line.left, line.right))) line = l;
  }
  if (!line) return null;
  let best = line.chars[0];
  for (const c of line.chars) if (away(x, c.left, c.right) < away(x, best.left, best.right)) best = c;
  return best.i;
};

// The first shown character at or after an index, where the cursor starts on a page: the page's
// anchor may sit on white space or on a block with no text (a figure).
export const nearest = ({ flat }, i) => seek(flat, i - 1, 1, shown) ?? seek(flat, flat.length, -1, shown);

// A note's links (12), always an array; an old cached note reads as none.
const links = (note) => (Array.isArray(note.about) ? note.about : []);

// The book link that makes a note a highlight of this book: kind book, this id, and a
// place (Decision 1). A note without one is not a highlight here.
const bookPlace = (note, bookId) => links(note).find((l) => l.kind === "book" && l.id === bookId && l.place);

// A highlight has a comment when its title is not empty: the highlights editor sets the
// title to the first non-empty line of the comment, so a list row, which carries no
// body, can still tell (12).
export const hasComment = (note) => Boolean(note.title);

// The highlights of one book, reduced to what the view paints: id, place, quote, and
// whether it carries a comment. A note that is not a highlight of this book is dropped.
export const highlightsOf = (notes, bookId) =>
  notes
    .map((note) => {
      const link = bookPlace(note, bookId);
      return link ? { id: note.id, place: link.place, quote: link.quote, commented: hasComment(note) } : null;
    })
    .filter(Boolean);

// Fold one changed note into the kept highlights: drop any earlier entry for its id,
// then add it back if it is (still) a highlight of this book. A note that lost its place
// simply drops out.
const foldHighlight = (highlights, note, bookId) => {
  const rest = highlights.filter((h) => h.id !== note.id);
  const [h] = highlightsOf([note], bookId);
  return h ? [...rest, h] : rest;
};

const rangeOf = (place) => ({ start: place.start, end: place.end });

// Whether the Slip-Box feature shows (3.1): not until `flags` answers, and not on a page
// without it, so with no answer the bubble is exactly as before.
export const slipBoxShown = (hidden) => Array.isArray(hidden) && !hidden.includes("slip-box");

// The passages a note holds: its links of kind highlight, by the highlight's id.
const heldBy = (note) => links(note).filter((l) => l.kind === "highlight").map((l) => l.id);

// Which notes hold which passages, for every note that holds any, so the bubble can say
// a passage is already in the open note without asking.
export const holdingOf = (notes) =>
  Object.fromEntries(notes.map((n) => [n.id, heldBy(n)]).filter(([, ids]) => ids.length > 0));

const foldHolding = (holding, note) => {
  const { [note.id]: _, ...rest } = holding;
  const ids = heldBy(note);
  return ids.length ? { ...rest, [note.id]: ids } : rest;
};

// The bubble's Add to note for one highlight: null while Slip-Box is hidden, so the
// button is not drawn; otherwise whether it can be pressed and, when not, why, said in
// its tooltip. The note is the one open in the Notes panel (note.opened); a highlight is
// never added to itself.
export const addToNote = (context, id) => {
  if (!slipBoxShown(context.hidden)) return null;
  if (context.opened == null) return { enabled: false, why: "Open a note first" };
  if (context.opened === id || (context.holding[context.opened] ?? []).includes(id)) return { enabled: false, why: "Already in this note" };
  return { enabled: true, why: null };
};

// The highlight of this chapter holding a point (the Vim cursor), by the same range a
// highlight covers: start inclusive, end exclusive. Undefined when none holds it.
export const highlightAt = (highlights, chapter, p) =>
  highlights.find((h) => h.place.chapter === chapter && !before(p, h.place.start) && before(p, h.place.end));

// A source link to a highlight, as a note stores it: `[label](note:<id>)`. The label is
// the quote's first words, at most LABEL_MAX characters and cut at a word, with "…" when
// the quote was cut; a first word longer than that is cut inside it. `[`, `]` and `\` are
// escaped so the label cannot end the link early.
const LABEL_MAX = 40;
export const linkLabel = (exact) => {
  const words = String(exact ?? "").trim().split(/\s+/u).filter(Boolean);
  let label = "";
  for (const w of words) {
    const next = label ? `${label} ${w}` : w;
    if (next.length > LABEL_MAX) break;
    label = next;
  }
  if (!label && words.length) label = words[0].slice(0, LABEL_MAX);
  const cut = label.length < words.join(" ").length;
  return (cut ? `${label}…` : label).replace(/[\\[\]]/g, "\\$&");
};
export const sourceLink = (id, quote) => `[${linkLabel(quote?.exact)}](note:${id})`;

// --- Re-anchoring after a re-import (session 7) -----------------------------------
//
// A book's text is re-extracted at import under a new content version, so a highlight
// counted in an older version points at coordinates that may have shifted (5, 12). The
// reader finds the passage again from the quote it kept and saves the corrected place;
// a highlight whose quote is no longer in the book stays a note with its quote and its
// comment. locate is pure — the mouse and the DOM are the view's — so it works on the
// chapter's block texts alone (12) and is checked in Node.

// A place's start and end both inside the given texts, start before end: only then can
// the text at those coordinates be read (an old place may point past a shorter chapter).
const placed = (texts, place) =>
  place.start.block >= 0 &&
  place.end.block < texts.length &&
  place.start.offset <= texts[place.start.block].length &&
  place.end.offset <= texts[place.end.block].length &&
  !before(place.end, place.start);

// The chapter's blocks as one string, blocks joined by "\n" exactly as quoteOf joins a
// quote (so a match of quote.exact aligns with block boundaries), with each block's
// global start, to map a found offset back to a { block, offset }.
const flatten = (texts) => {
  const starts = [];
  let doc = "";
  texts.forEach((t, b) => {
    if (b > 0) doc += "\n";
    starts.push(doc.length);
    doc += t;
  });
  return { doc, starts };
};

// A global offset into the flattened chapter as a { block, offset }: the last block that
// starts at or before it, its offset clamped to the block (an offset on a "\n" separator
// lands at the preceding block's end).
const posOf = (starts, texts, g) => {
  let b = starts.length - 1;
  while (b > 0 && starts[b] > g) b -= 1;
  return { block: b, offset: Math.min(g - starts[b], texts[b].length) };
};

// The up-to-32 characters before a start and after an end, each in its own block, exactly
// as quoteOf keeps them, so a candidate's surroundings can be compared to the kept context.
const prefixAt = (texts, p) => texts[p.block].slice(Math.max(0, p.offset - CONTEXT), p.offset);
const suffixAt = (texts, p) => texts[p.block].slice(p.offset, p.offset + CONTEXT);

// Find the passage a highlight quoted again in a chapter's texts (session 7). sameChapter
// is whether these texts are the highlight's own stored chapter: within it the old
// coordinates are tried first and, failing that, the exact quote is searched for, preferring
// a match whose surroundings equal the kept prefix and suffix and then the one nearest the
// old start; in any other chapter only a single match with both prefix and suffix equal is
// accepted, so a highlight is never moved across chapters on a coincidence. Returns the
// found { start, end }, or null when nothing fits — then the note stays unpainted with its
// quote and comment.
export const locate = (texts, link, sameChapter) => {
  const { place, quote } = link;
  if (!quote || !quote.exact) return null;
  if (sameChapter && placed(texts, place) && quoteOf(texts, { start: place.start, end: place.end }).exact === quote.exact) {
    return { start: place.start, end: place.end };
  }
  const { doc, starts } = flatten(texts);
  const found = [];
  for (let g = doc.indexOf(quote.exact); g !== -1; g = doc.indexOf(quote.exact, g + 1)) {
    found.push({ start: posOf(starts, texts, g), end: posOf(starts, texts, g + quote.exact.length) });
  }
  if (found.length === 0) return null;
  const context = (m) => prefixAt(texts, m.start) === quote.prefix && suffixAt(texts, m.end) === quote.suffix;
  if (!sameChapter) {
    const strict = found.filter(context);
    return strict.length === 1 ? strict[0] : null;
  }
  const oldStart = (starts[Math.min(place.start.block, starts.length - 1)] ?? 0) + place.start.offset;
  const distance = (m) => Math.abs((starts[m.start.block] ?? 0) + m.start.offset - oldStart);
  found.sort((a, b) => (context(b) ? 1 : 0) - (context(a) ? 1 : 0) || distance(a) - distance(b));
  return found[0];
};

// The chapter a followed source link opens, kept inside the book.
const passageChapter = (passage, book) => Math.min(passage.place.chapter, Math.max(0, (book.chapters?.length ?? 1) - 1));

// The glow one-shot for a followed link: the highlight's id and a fresh nonce.
const glowFor = (context, passage = context.passage) => ({ id: passage.id, n: (context.glow?.n ?? 0) + 1 });

// The command line (Vim keys on): ":" opens it, typed letters build it, Backspace on an
// empty line or Escape cancels it, and Enter runs it. The only command is q (or quit,
// or tabc and tabclose, since the book is a tab on the stage), which closes the open book; any other text is named back for NOT_A_COMMAND_MS, then
// the line is gone.
export const NOT_A_COMMAND_MS = 2000;
export const QUIT = ["q", "quit", "tabc", "tabclose"];

const commandKey = enqueueActions(({ context, event, enqueue }) => {
  const { key } = event;
  const line = context.command;
  if (line == null) {
    if (key !== ":" || !context.vimKeys || !context.book) return;
    enqueue(cancel("notACommand"));
    enqueue.assign({ command: "", notACommand: null });
    return;
  }
  if (key === "Escape" || (key === "Backspace" && line === "")) enqueue.assign({ command: null });
  else if (key === "Backspace") enqueue.assign({ command: line.slice(0, -1) });
  else if (key === "Enter") {
    const text = line.trim();
    enqueue.assign({ command: null });
    if (text === "") return;
    if (QUIT.includes(text)) {
      if (context.book) enqueue.emit({ type: "book.closed", id: context.book.id });
      return;
    }
    enqueue.assign({ notACommand: text });
    enqueue(raise({ type: "_notACommandEnd" }, { delay: NOT_A_COMMAND_MS, id: "notACommand" }));
  } else if (key.length === 1) enqueue.assign({ command: line + key });
});

// --- Reading aloud (3.1: the reading-aloud feature) ---------------------------------
//
// The reader reads a paragraph, or the page, aloud through `voice: speak`. The view
// hands the blocks to read, each with its text exactly as #blockTexts gives it (and,
// for a block running in from the page before, where on the page it starts), so the
// character offsets the voice answers for each word line up with the page's text.

// Whether Reading aloud shows (3.1): not until `flags` answers, and not on a page
// without it, as slipBoxShown.
export const readingShown = (hidden) => Array.isArray(hidden) && !hidden.includes("reading-aloud");

// Whether the reader offers reading aloud: the feature shown and `voice` on the page,
// having answered with a picture.
export const canRead = (context) => readingShown(context.hidden) && context.voice != null;

const isVoicePicture = (v) => (v?.here === "mac" || v?.here === "web") && typeof v.voice === "string" && Array.isArray(v.voices);
const isClip = (r) => typeof r?.mime === "string" && typeof r.audio === "string" && Array.isArray(r.words);

// What the footer says when the voice cannot read: what to do about it, where there is
// something to do.
export const speakMessage = (error) =>
  error === "not-downloaded"
    ? "Download the voice in Settings"
    : error === "no-key"
      ? "Add your Inworld key in Settings"
      : "The voice is not available now";

// The word being said at a time in the clip: the last one started by then, or -1 before
// the first. Words come in order, so a gap between two keeps the one before lit.
export const wordAt = (words, t) => {
  let at = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].start <= t) at = i;
    else break;
  }
  return at;
};

// The blocks to read, cleaned: a block with no word to say (an empty block, white space)
// is dropped, so the queue never asks the voice for nothing.
const sayable = (blocks) =>
  (Array.isArray(blocks) ? blocks : []).filter((b) => Number.isInteger(b?.block) && typeof b.text === "string" && b.text.trim() !== "");

// The clip the view plays, with a nonce counted over every reading, so each clip is
// played once; returned with the count, for one assign.
const withClip = (context, reply, speech) => ({
  said: context.said + 1,
  speech: { ...speech, clip: { mime: reply.mime, audio: reply.audio, words: reply.words, n: context.said + 1 } },
});

// A message that sends the user to Settings has to stay long enough to read and to
// remember what it asks; the view's usual moment is too short for that.
const TO_ACT_MS = 6000;

// The voice's refusal, said over the footer once (a nonce, like reveal). ms is how long it
// stays: null where there is nothing to do about it, which leaves the view's usual moment.
const noticeOf = (context, error) => ({
  text: speakMessage(error),
  n: (context.notice?.n ?? 0) + 1,
  ms: error === "not-downloaded" || error === "no-key" ? TO_ACT_MS : null,
});

// Reading aloud, the second region of a page that shows (ready): idle; loading, while
// the voice is asked for the block's audio; speaking, while it plays or is paused, with
// the next block's audio asked for ahead. _say starts afresh from any of them; _hush,
// sent on a page turn, a new fragment or Stop, ends it, and so does leaving the page.
const SPEECH = {
  initial: "idle",
  on: {
    _say: {
      guard: ({ context, event }) => canRead(context) && sayable(event.blocks).length > 0,
      target: ".loading",
      reenter: true,
      actions: assign({ speech: ({ event }) => ({ queue: sayable(event.blocks), at: 0, clip: null, ahead: null, held: false }) }),
    },
    _hush: { target: ".idle" },
  },
  states: {
    idle: { entry: assign({ speech: null }) },
    loading: {
      invoke: {
        src: "speak",
        input: ({ context }) => ({ ask: context.ask, text: context.speech.queue[context.speech.at].text }),
        onDone: [
          {
            guard: ({ event }) => isClip(event.output),
            target: "speaking",
            actions: assign(({ context, event }) => withClip(context, event.output, context.speech)),
          },
          { target: "idle", actions: assign({ notice: ({ context, event }) => noticeOf(context, event.output?.error) }) },
        ],
        onError: { target: "idle", actions: assign({ notice: ({ context }) => noticeOf(context, "unavailable") }) },
      },
      on: {
        // Pause before the audio arrived: it waits, paused, once it comes.
        _pause: { actions: assign({ speech: ({ context }) => ({ ...context.speech, held: true }) }) },
        _resume: { actions: assign({ speech: ({ context }) => ({ ...context.speech, held: false }) }) },
      },
    },
    speaking: {
      initial: "playing",
      invoke: {
        src: "ahead",
        input: ({ context }) => ({ ask: context.ask, text: context.speech.queue[context.speech.at + 1]?.text }),
        onDone: {
          guard: ({ event }) => isClip(event.output),
          actions: assign({ speech: ({ context, event }) => ({ ...context.speech, ahead: { at: context.speech.at + 1, reply: event.output } }) }),
        },
        onError: { actions: [] },
      },
      on: {
        // The view's clip ended: the next block, from the audio fetched ahead when it has
        // come, else asked for now; after the last block, the reading is over.
        _spoken: [
          { guard: ({ context, event }) => event.n !== context.speech.clip?.n },
          {
            guard: ({ context }) => context.speech.at + 1 < context.speech.queue.length && context.speech.ahead?.at === context.speech.at + 1,
            target: "speaking",
            reenter: true,
            actions: assign(({ context }) =>
              withClip(context, context.speech.ahead.reply, { ...context.speech, at: context.speech.at + 1, ahead: null, held: false }),
            ),
          },
          {
            guard: ({ context }) => context.speech.at + 1 < context.speech.queue.length,
            target: "loading",
            actions: assign({ speech: ({ context }) => ({ ...context.speech, at: context.speech.at + 1, clip: null, ahead: null, held: false }) }),
          },
          { target: "idle" },
        ],
      },
      states: {
        playing: {
          always: { guard: ({ context }) => context.speech.held, target: "paused" },
          on: { _pause: "paused" },
        },
        paused: {
          entry: assign({ speech: ({ context }) => ({ ...context.speech, held: false }) }),
          on: { _resume: "playing" },
        },
      },
    },
  },
};

export const machine = setup({
  actors: {
    // The "Vim keys" device preference (12), owned by `settings`. settings.changed that
    // races it is held for us until the reply lands (settings: read supersededBy).
    settings: fromPromise(({ input }) => input.ask("settings", "read", {})),
    // Which book is open (4.3): the starting picture on load, so a reload reopens what
    // was being read. book.opened is held for this ask until the reply lands
    // (supersededBy), so an open that races the query is applied after it, in order.
    open: fromPromise(({ input }) => input.ask("books", "open", {})),
    read: fromPromise(({ input }) => input.ask("books", "read", { id: input.id })),
    chapter: fromPromise(({ input }) => input.ask("books", "chapter", { id: input.id, chapter: input.chapter })),
    // The book's highlight notes (Decision 1): all notes, filtered to this book, whenever
    // the reader is highlighting; with the attribute off it asks nothing. note.changed and
    // note.deleted are held for this ask until the reply lands (supersededBy), then
    // followed after (4.3). A reply the page's notes cannot answer means no highlights.
    highlights: fromPromise(({ input }) =>
      input.highlighting ? input.ask("notes", "list", {}) : Promise.resolve({ notes: [] }),
    ),
    // The bodies, versions and links of the highlights a merge combines (Decision 6): the
    // reader keeps only what it paints (id, place, quote), so a merge reads the involved
    // notes for their comments and versions before it saves the survivor. A note the read
    // cannot find drops out; the survivor missing aborts the merge.
    // Which features are hidden (3.1); flags.changed is held until the reply lands.
    flags: fromPromise(({ input }) => input.ask("flags", "read", {})),
    // Whether `voice` is on the page and how it reads (3.1); voice.changed is held until
    // the reply lands.
    voice: fromPromise(({ input }) => input.ask("voice", "read", {})),
    // One block's audio, and the next block's while one plays, so the reading runs on
    // without a pause to fetch it.
    speak: fromPromise(({ input }) => input.ask("voice", "speak", { text: input.text })),
    ahead: fromPromise(({ input }) => (input.text ? input.ask("voice", "speak", { text: input.text }) : Promise.resolve(null))),
    // The note open in the Notes panel when the reader starts, since the editor may have
    // announced it (note.opened) before this reader was mounted.
    openNote: fromPromise(({ input }) => input.ask("notes", "open", {})),
    readNotes: fromPromise(async ({ input }) => {
      const replies = await Promise.all(input.ids.map((id) => input.ask("notes", "read", { id })));
      return replies.filter((r) => r && "note" in r).map((r) => r.note);
    }),
  },
  guards: {
    // A read that found the book, versus one that says there is none by that id.
    found: ({ event }) => "book" in event.output,
    hasHtml: ({ event }) => "html" in event.output,
    unavailable: ({ event }) => event.output.error === "unavailable",
    reimported,
    // Another device's move that lands in a different chapter needs the fragment
    // re-fetched; one within the open chapter only re-opens a block.
    movedToOtherChapter: (args) => movedElsewhere(args) && args.event.position.chapter !== args.context.chapter,
    movedInChapter: (args) => movedElsewhere(args) && args.event.position.chapter === args.context.chapter,
    oursSameContent: (args) => isOurs(args) && !reimported(args),
    ours: isOurs,
    dirty: stateIn({ reading: { ready: { place: "dirty" } } }),
    // The view landing where the fact put it, or landing again where it already was (a
    // re-measure): neither is the user's turn, so neither is progress to announce.
    landed: ({ context, event }) => context.quiet && samePos(event, context.pending),
    unmoved: ({ context, event }) => samePos(event, context.at),
  },
  actions: {
    // Announce where the user turned to (Decision 4). The place last recorded by a
    // settle is what is sent; `books` ignores it when it has not moved.
    announce: emit(({ context }) => ({
      type: "book.progressed",
      id: context.book.id,
      chapter: context.sent.chapter,
      block: context.sent.block,
    })),
  },
}).createMachine({
  id: "book-reader",
  meta: {
    description:
      "Shows one book a chapter at a time, split into pages that fit this device's screen and " +
      "type size, and turns the pages. It saves the reading place as a chapter and a block, " +
      "never a page number, because page numbers differ between devices; each device opens the " +
      "page that holds the saved place. The place is saved a short time after page turns stop, " +
      "so a run of turns saves once. It paints the book's highlights and lets the user mark a " +
      "new passage. On a touch screen a finger never uses the browser's selection: pressing and " +
      "holding for about 0.4 seconds paints the word under it, and without lifting, a drag grows " +
      "the passage by whole words from that word, forward or back only by where the finger is " +
      "against it, as far as the last character on the page. Lifting shows a Highlight button " +
      "under the passage's last line, which marks exactly what is painted; a tap elsewhere, a " +
      "page turn, a new chapter or Escape drops it, a tap there doing nothing else, and holding " +
      "again starts over. A pause in the drag changes nothing. A quick swipe still turns the page, " +
      "a tap still turns from the outer thirds, a tap on a link only follows it, a hold on a link " +
      "follows nothing, and a hold on a picture does nothing. After a re-import it finds each highlight's quote " +
      "again and saves its corrected place; a highlight whose quote is no longer in the book " +
      "stays a note with its quote and its comment. With the \"Vim keys\" preference on and the reader focused, a " +
      "one-character cursor shows, starting at the top of the page and kept while the reader " +
      "is left and returned to; w, b, ), (, }, {, 0, $, j, k, l and h move it (l and h one " +
      "letter, as in Vim), a click on the text puts it there, and a cursor that leaves the " +
      "page turns the page. The cursor is a box drawn on its letter at once, not a painted " +
      "range, so Safari never shows it late. v or Ctrl+v starts a highlight at the cursor, the " +
      "same keys grow it, Enter makes it and Escape drops it. Space, the arrows, Page Up and " +
      "Page Down, and Ctrl+f, Ctrl+d, Ctrl+b and Ctrl+u turn pages, taking the cursor to the " +
      "new page's top, and a highlight in progress goes on to that page; gg and G go to the " +
      "chapter's first and last page. A highlight made with the keys marks exactly the passage " +
      "painted while it was made, letter by letter if l and h made it, not grown to whole " +
      "words as a drag with the mouse is. A highlight's bubble offers Copy, Copy link and " +
      "Remove, and while Slip-Box is shown also Add to note, which adds the passage to the note " +
      "open in the Notes panel, one step, and reads \"Added\" for a moment; it is greyed, with a " +
      "tooltip saying why, while no note is open there (\"Open a note first\") or that note already " +
      "holds the passage (\"Already in this note\"), and a press on it then shows that reason over " +
      "the reader's foot for a moment, so a finger, which sees no tooltip, learns it too; with Vim " +
      "keys on, a with the cursor inside a highlight opens its bubble and does Add to note. Copy link puts a link to the highlight, its quote's first words as the label, " +
      "on the clipboard and in the Vim register of any editor, and with Vim keys on, y with " +
      "the cursor inside a highlight opens its bubble and does the same, and y y does Copy, " +
      "its quote's text; d d there does Remove. Remove deletes the highlight at once and shows " +
      "the short notice with Undo; Undo and Redo take back making, joining and removing a " +
      "highlight, each one step (section 12), and u is the global Undo. With Vim keys on, y copies instead of highlighting: on a passage " +
      "marked with v or Ctrl+v it copies the passage and makes no highlight, and y i s and " +
      "y i p copy the sentence or the paragraph holding the cursor; the text goes on the " +
      "clipboard and into the Vim register of any editor, blocks a blank line apart, and " +
      "\"Copied\" shows over the reader's foot for a moment. The second and third key of y y " +
      "and y i s count within a second of the one before. A highlight split across pages " +
      "shows its bubble beside its part on the page shown. Following a source " +
      "link in a note opens the page that holds the passage, in the book already open or " +
      "after `books` opens its book, and the highlight glows for about a second. With Vim keys " +
      "on and the reader focused, : opens a one-line command line at the reader's foot, as in " +
      "Vim, and the reader's other keys wait while it is open; q, quit, tabc or tabclose and Enter close the " +
      "book, any other text shows \"Not a command\" with that text for a moment, and Escape, " +
      "Backspace on an empty line or leaving the reader cancels it. A tap or click on a picture, " +
      "even at the page's edge, opens it alone over the reader, never a page turn: Turn turns it a " +
      "quarter clockwise each time, on past a full turn, fitted to the reader's box so a sideways " +
      "picture gets the long side; a double tap, the wheel or a pinch zooms it, a drag moves it, " +
      "and Close, Escape or a tap beside it goes back to the same page. Nothing of it is saved. " +
      "While Reading aloud is shown and `voice` is on the page, the page reads aloud: with a " +
      "mouse, a speaker shows in the left margin beside the paragraph under the pointer, and a " +
      "click reads that paragraph and stops at its end; while it is read the speaker shows Stop. " +
      "The footer offers Read page, which reads the page's paragraphs and headings in order, " +
      "and while anything is read Pause, or Resume once paused, and Stop; a phone has only the " +
      "footer. The paragraph being read is tinted and the word being said lights up, and the " +
      "next paragraph's audio is fetched while one plays. A footnote reference the book marks " +
      "as one is never said or lit: the page still shows it and it can still be followed, a " +
      "paragraph holding nothing else is skipped and offers no speaker, and a number in a " +
      "sentence is read, as is a footnote's own text where the book places it. A page turn, another chapter or " +
      "another book stops it. With Vim keys on, r reads the cursor's paragraph and R the page " +
      "from it; while anything is read, Space pauses and resumes and Escape stops. A voice that " +
      "cannot read says why over the footer: Download the voice in Settings or Add your Inworld " +
      "key in Settings stays about six seconds, so there is time to read what to do, and that it " +
      "is not available now stays for a moment. A new message replaces the one showing and " +
      "gets its own full time. Listening changes no data, " +
      "so it is not a step.",
    kind: "view",
    emits: ["book.progressed", "note.saved", "note.discarded", "link.copied", "text.copied", "book.closed", "passage.added"],
    attributes: ["height", "highlights"],
    asks: ["books: open", "books: read", "books: chapter", "notes: list", "notes: read", "notes: open", "settings: read", "flags: read", "voice: read", "voice: speak"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // The command line's text after its ":" while it is open, else null; and the text
    // last refused, shown in its place for a moment (commandKey).
    command: null,
    notACommand: null,
    // A ULID for a new highlight note (Decision 1); arrives through input so the machine
    // stays importable in Node.
    mint: input.mint,
    // The `highlights` attribute (Decision 3): off is exactly today's reader — no notes
    // asked, no painting, no highlight gesture. Arrives through input.
    highlighting: Boolean(input.highlighting),
    // The highlight notes of the open book, reduced to what the view paints (id, place,
    // quote, commented). Reset when the book changes; kept current from note.changed and
    // note.deleted after the starting list (4.3).
    highlights: [],
    // Which notes hold which passages (holdingOf), from the same list and news as the
    // highlights, and the note open in the Notes panel, or null (note.opened). `openSeen`
    // is whether a note.opened arrived before the starting ask replied, which then is stale.
    holding: {},
    opened: null,
    openSeen: false,
    // The features `flags` reports hidden (3.1); null until it answers.
    hidden: null,
    // The picture `voice` last gave (voice: read, voice.changed), or null on a page
    // without it: only with it does the reader offer reading aloud.
    voice: null,
    // What is being read aloud, or null: the blocks in order (queue), the one being read
    // (at), its clip once the voice answered, the next block's clip fetched ahead, and
    // whether Pause was pressed while a clip was still being fetched (held).
    speech: null,
    // How many clips have been handed to the view, the nonce of the next.
    said: 0,
    // A one-shot for the view, like reveal: why the voice could not read, said over the
    // footer for a moment.
    notice: null,
    // A one-shot for the view: a drag wholly inside an existing highlight makes no new
    // note; instead the reader opens that highlight's bubble (Decision 6, session 3). The
    // bus cannot route an internal message to a view, so the id rides in context with a
    // nonce the view acts on once. Null until the first such drag.
    reveal: null,
    // A one-shot for the view, like reveal: the highlight a followed source link points
    // at, which the view glows for about a second once the page holding it shows.
    glow: null,
    // A followed source link whose book is still being opened (passage.selected arrives
    // before or after the book.opened it causes, 12): the read opens at its place.
    passage: null,
    // A chapter picked while its book is still being opened, kept the same way.
    jump: null,
    // A merge in flight (Decision 6): the involved notes' ids in book order (the survivor
    // first), and the union place and quote the survivor is saved with once their comments
    // are read. Set when a new highlight overlaps others, consumed by the read that follows.
    merge: null,
    // A re-anchoring in flight (session 7): the highlights the view found again in the
    // chapter now shown, each with the corrected place, whose notes are read and re-saved
    // so the passage need not be searched for again. Set from _reanchor, cleared once saved.
    reanchor: null,
    // The book being read, or null before one is selected. `id` is the book asked for
    // while it loads, which may differ from `book` mid-switch.
    id: null,
    book: null,
    // The chapter now shown, its fragment, a place still owed to the view to open
    // (cleared once the view settles), and the place last announced (to tell an echo
    // of book.changed from a real move).
    chapter: 0,
    html: "",
    pending: null,
    sent: null,
    // Whether the owed place came from the fact (its saved position, another device's
    // move) rather than the user, and the place the view last reported. Announcing a
    // landing would send this device's cached place over a newer one the pull is
    // about to bring (5: last write wins), so only a place the user moved to is sent.
    quiet: false,
    at: null,
  }),
  // Beside the states, so the preferences arrive whatever the view is doing.
  invoke: [
    {
      src: "settings",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
      onError: { actions: [] },
    },
    {
      src: "flags",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ hidden: ({ event }) => (Array.isArray(event.output?.hidden) ? event.output.hidden : null) }) },
      onError: { actions: [] },
    },
    {
      src: "voice",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: { actions: assign({ voice: ({ event }) => (isVoicePicture(event.output) ? event.output : null) }) },
      onError: { actions: [] },
    },
    {
      src: "openNote",
      input: ({ context }) => ({ ask: context.ask }),
      onDone: {
        guard: ({ context }) => !context.openSeen,
        actions: assign({ opened: ({ event }) => event.output?.note?.id ?? null }),
      },
      onError: { actions: [] },
    },
  ],
  initial: "starting",
  on: {
    "settings.changed": {
      actions: assign(({ context, event }) => ({
        vimKeys: event.vimKeys === true,
        command: event.vimKeys === true ? context.command : null,
      })),
    },
    "flags.changed": { actions: assign({ hidden: ({ event }) => event.hidden }) },
    "voice.changed": { actions: assign({ voice: ({ event: { type, ...picture } }) => (isVoicePicture(picture) ? picture : null) }) },
    // The note the Notes panel shows (the stage's editor never announces one), which Add
    // to note adds a passage to.
    "note.opened": { actions: assign({ opened: ({ event }) => event.id, openSeen: true }) },
    _commandKey: { actions: commandKey },
    _notACommandEnd: { actions: assign({ notACommand: null }) },
    // The open book changed (4.3, fourth rule): the fact says which book is open now,
    // whether the user opened it here, or on another device and this tab pulled it.
    // A book id reads it at its saved position; null empties the reader.
    "book.opened": [
      {
        guard: ({ event }) => event.id != null,
        target: ".opening",
        actions: assign({
          id: ({ event }) => event.id,
          book: null, html: "", pending: null, sent: null, quiet: false, at: null, chapter: 0, highlights: [], command: null,
          passage: ({ context, event }) => (context.passage?.book === event.id ? context.passage : null),
          jump: ({ context, event }) => (context.jump?.id === event.id ? context.jump : null),
        }),
      },
      {
        target: ".empty",
        actions: assign({ id: null, book: null, html: "", pending: null, sent: null, quiet: false, at: null, chapter: 0, highlights: [], command: null }),
      },
    ],
    // The fact's news that the open book is gone (4.3, fourth rule): back to the empty
    // page. A deletion of another book is left to the bus to record as ignored.
    // The user followed a source link (note-editor emits passage.selected) to a book not
    // open here: keep the place for the read that `books` opening it brings. The open book
    // itself is handled in reading.
    "passage.selected": { actions: assign({ passage: ({ event }) => ({ book: event.book, id: event.id, place: event.place }) }) },
    // A chapter picked in a book not open here (a lookup's link in the chat): keep it for
    // the read that `books` opening it brings, as a passage is kept. The open book's own
    // chapter is handled in reading.
    "chapter.selected": { actions: assign({ jump: ({ event }) => ({ id: event.id, chapter: event.chapter }) }) },
    "book.deleted": {
      guard: ({ context, event }) => Boolean(context.book) && event.id === context.book.id,
      target: ".empty",
      actions: assign({ id: null, book: null, html: "", pending: null, sent: null, quiet: false, at: null, chapter: 0, highlights: [], command: null }),
    },
  },
  states: {
    // On load, ask which book is open and reopen it; none, or a stale one, is the empty
    // page. book.opened while this is open is held until the reply (supersededBy).
    starting: {
      invoke: {
        src: "open",
        input: ({ context }) => ({ ask: context.ask }),
        onDone: [
          {
            guard: ({ event }) => event.output.id != null,
            target: "opening",
            actions: assign({ id: ({ event }) => event.output.id }),
          },
          { target: "empty" },
        ],
        onError: "empty",
      },
    },
    // No book yet: the shelf's selection brings one.
    empty: {},
    // The read for the selected book. Its reply carries the saved position, which the
    // reader opens at; not-found (a stale selection) falls back to empty.
    opening: {
      invoke: {
        src: "read",
        input: ({ context }) => ({ ask: context.ask, id: context.id }),
        onDone: [
          {
            guard: ({ context, event }) => "book" in event.output && context.passage?.book === event.output.book.id,
            target: "reading",
            actions: assign({
              book: ({ event }) => pickBook(event.output.book),
              chapter: ({ context, event }) => passageChapter(context.passage, event.output.book),
              pending: ({ context, event }) => ({ chapter: passageChapter(context.passage, event.output.book), block: context.passage.place.start.block }),
              quiet: false,
              glow: ({ context }) => glowFor(context),
              passage: null,
            }),
          },
          {
            guard: ({ context, event }) => "book" in event.output && context.jump?.id === event.output.book.id,
            target: "reading",
            actions: assign({
              book: ({ event }) => pickBook(event.output.book),
              chapter: ({ context, event }) => passageChapter({ place: context.jump }, event.output.book),
              pending: ({ context, event }) => ({ chapter: passageChapter({ place: context.jump }, event.output.book), block: 0 }),
              quiet: false,
              jump: null,
            }),
          },
          {
            guard: "found",
            target: "reading",
            actions: assign({
              book: ({ event }) => pickBook(event.output.book),
              chapter: ({ event }) => event.output.book.position.chapter,
              pending: ({ event }) => ({ ...event.output.book.position }),
              quiet: true,
            }),
          },
          { target: "empty" },
        ],
        onError: "empty",
      },
    },
    reading: {
      initial: "fetching",
      // The book's highlights, loaded once per open book (re-entering reading on a book
      // switch re-runs it; an in-book turn or jump does not). With highlighting off the
      // actor asks nothing and resolves empty.
      invoke: {
        src: "highlights",
        input: ({ context }) => ({ ask: context.ask, highlighting: context.highlighting, id: context.book.id }),
        onDone: {
          actions: assign({
            highlights: ({ context, event }) => highlightsOf(event.output.notes ?? [], context.book.id),
            holding: ({ event }) => holdingOf(event.output.notes ?? []),
          }),
        },
        onError: {},
      },
      on: {
        // The user made a highlight (Decision 3): one actor message, the mouse only one
        // producer of it. Snap to words (a keyboard highlight, `exact`, is not grown);
        // then, against the known highlights of this chapter: a range wholly inside one
        // changes nothing (session 3 opens that highlight's bubble); a range clear of
        // them all is a new note, its body the empty comment; a range that overlaps or touches one or more merges them into one (Decision 6). The
        // merge needs the involved comments and versions, so it is planned here and read in
        // `merging`; the plain cases emit at once.
        _highlight: {
          guard: ({ context }) => context.highlighting && Boolean(context.book),
          actions: enqueueActions(({ context, event, enqueue }) => {
            const range = snapToWords(event.texts, { start: event.start, end: event.end }, { grow: !event.exact });
            if (!range) return;
            const here = context.highlights.filter((h) => h.place.chapter === context.chapter);
            const hit = here.filter((h) => overlaps(rangeOf(h.place), range));
            // A drag wholly inside one highlight makes nothing; the view opens that
            // highlight's bubble instead (Decision 6, session 3), told through the reveal
            // one-shot with a nonce the view acts on once.
            if (hit.length === 1 && contains(rangeOf(hit[0].place), range)) {
              enqueue.assign({ reveal: ({ context }) => ({ id: hit[0].id, n: (context.reveal?.n ?? 0) + 1 }) });
              return;
            }
            if (hit.length === 0) {
              const place = {
                chapter: context.chapter,
                contentVersion: context.book.contentVersion,
                start: range.start,
                end: range.end,
              };
              enqueue.emit({
                type: "note.saved",
                id: context.mint(),
                title: "",
                body: "",
                baseVersion: null,
                about: [{ kind: "book", id: context.book.id, place, quote: quoteOf(event.texts, range) }],
                // One finished gesture, so one step of its own (12, Undo).
                left: true,
              });
              return;
            }
            // The earliest overlapping note survives, grown to the union; the rest are
            // discarded. Book order is by start, so the joined comments read top to bottom.
            const involved = [...hit].sort((a, b) => (before(a.place.start, b.place.start) ? -1 : 1));
            const u = union([range, ...involved.map((h) => rangeOf(h.place))]);
            enqueue.assign({
              merge: {
                ids: involved.map((h) => h.id),
                place: { chapter: context.chapter, contentVersion: context.book.contentVersion, start: u.start, end: u.end },
                quote: quoteOf(event.texts, u),
              },
            });
            enqueue.raise({ type: "_merge" });
          }),
        },
        // The planned merge (Decision 6): read the involved notes before saving the survivor.
        // Raised by _highlight so it runs after the assign that stored the plan.
        _merge: { guard: ({ context }) => Boolean(context.merge), target: ".merging" },
        // Re-anchor stale highlights after a re-import (session 7): the view found their
        // passages again (locate) in the chapter now shown and hands the corrected places.
        // Adopt them at once so the marks paint without waiting for the save, then read and
        // re-save each note in `reanchoring`. The mouse plays no part; this is the reader's
        // own upkeep, one attempt per highlight per chapter load, driven from the view.
        _reanchor: {
          guard: ({ context, event }) => context.highlighting && Boolean(context.book) && event.items?.length > 0,
          target: ".reanchoring",
          actions: assign({
            reanchor: ({ event }) => ({ items: event.items }),
            highlights: ({ context, event }) =>
              context.highlights.map((h) => {
                const item = event.items.find((i) => i.id === h.id);
                return item ? { ...h, place: item.place } : h;
              }),
          }),
        },
        // The fact's news for a highlight note (4.3, fourth rule): fold it in, drop it if
        // it lost its place or its book, add a newly saved one. Ignored with highlighting
        // off, where nothing is painted.
        "note.changed": {
          guard: ({ context }) => context.highlighting && Boolean(context.book),
          actions: assign({
            highlights: ({ context, event }) => foldHighlight(context.highlights, event, context.book.id),
            holding: ({ context, event }) => foldHolding(context.holding, event),
          }),
        },
        "note.deleted": {
          guard: ({ context }) => context.highlighting,
          actions: assign({
            highlights: ({ context, event }) => context.highlights.filter((h) => h.id !== event.id),
            holding: ({ context, event }) => foldHolding(context.holding, { id: event.id }),
          }),
        },
        // Add to note on a highlight's bubble: the user's gesture, which notes takes in and
        // records as one step (4.3, fifth rule; 12). Its note.changed greys the button.
        _addToNote: {
          guard: ({ context, event }) => context.highlights.some((h) => h.id === event.id) && addToNote(context, event.id)?.enabled === true,
          actions: emit(({ context, event }) => ({ type: "passage.added", note: context.opened, highlight: event.id })),
        },
        // Remove a highlight: the bubble's Remove and, with Vim keys, d d. A highlight is a
        // note (13), so it is deleted at once, one step `notes` records with the short
        // notice and its Undo (12, Undo); notes echoes note.deleted, dropping the mark.
        _remove: {
          guard: ({ context, event }) => context.highlights.some((h) => h.id === event.id),
          actions: emit(({ event }) => ({ type: "note.discarded", id: event.id })),
        },
        // Text copied with Vim keys (y on a passage marked with v, yis, yip, or yy on a
        // highlight): announced whether or not the clipboard took it, so an editor's Vim
        // register still gets it, as a copied link is.
        _copyText: {
          guard: ({ context, event }) => context.vimKeys && typeof event.text === "string" && event.text.trim() !== "",
          actions: emit(({ event }) => ({ type: "text.copied", text: event.text })),
        },
        // Copy link (Copy link in the bubble, or y with Vim keys): announced whether or not
        // the clipboard took it, so an editor's Vim register still gets the link.
        _copyLink: {
          guard: ({ context, event }) => context.highlights.some((h) => h.id === event.id),
          actions: emit(({ context, event }) => ({
            type: "link.copied",
            id: event.id,
            text: sourceLink(event.id, context.highlights.find((h) => h.id === event.id).quote),
          })),
        },
        // A page turn that ran past the chapter's edge (the view decides; an intra-
        // chapter turn never reaches here): load the neighbour and open its first page,
        // or, going back, its last (block Infinity clamps to the last block in the view).
        _next: {
          guard: ({ context }) => context.chapter + 1 < context.book.chapters.length,
          target: ".fetching",
          actions: assign({
            chapter: ({ context }) => context.chapter + 1,
            pending: ({ context }) => ({ chapter: context.chapter + 1, block: 0 }),
            quiet: false,
          }),
        },
        _prev: {
          guard: ({ context }) => context.chapter > 0,
          target: ".fetching",
          actions: assign({
            chapter: ({ context }) => context.chapter - 1,
            pending: ({ context }) => ({ chapter: context.chapter - 1, block: Infinity }),
            quiet: false,
          }),
        },
        // The contents' jump (4.3, fifth rule): open a chapter's first page. Within the
        // open chapter it only re-opens the block; another chapter is re-fetched.
        "chapter.selected": [
          {
            guard: ({ context, event }) => event.id === context.book.id && event.chapter !== context.chapter,
            target: ".fetching",
            actions: assign({ chapter: ({ event }) => event.chapter, pending: ({ event }) => ({ chapter: event.chapter, block: 0 }), quiet: false }),
          },
          {
            guard: ({ context, event }) => event.id === context.book.id,
            actions: assign({ pending: ({ context }) => ({ chapter: context.chapter, block: 0 }), quiet: false }),
          },
        ],
        // A link inside the text to another spine item (the importer rewrote it to a
        // chapter and, when it named a fragment, a block): jump there.
        _link: [
          {
            guard: ({ context, event }) => event.chapter !== context.chapter,
            target: ".fetching",
            actions: assign({ chapter: ({ event }) => event.chapter, pending: ({ event }) => ({ chapter: event.chapter, block: event.block }), quiet: false }),
          },
          { actions: assign({ pending: ({ event }) => ({ chapter: event.chapter, block: event.block }), quiet: false }) },
        ],
        // A followed source link into the open book: go to the page holding the passage
        // and glow it. Another book falls through to the root, which keeps the place for
        // the open `books` announces.
        "passage.selected": [
          {
            guard: ({ context, event }) => event.book === context.book.id && passageChapter(event, context.book) !== context.chapter,
            target: ".fetching",
            actions: assign({
              chapter: ({ context, event }) => passageChapter(event, context.book),
              pending: ({ context, event }) => ({ chapter: passageChapter(event, context.book), block: event.place.start.block }),
              quiet: false,
              glow: ({ context, event }) => glowFor(context, event),
              passage: null,
            }),
          },
          {
            guard: ({ context, event }) => event.book === context.book.id,
            actions: assign({
              pending: ({ context, event }) => ({ chapter: context.chapter, block: event.place.start.block }),
              quiet: false,
              glow: ({ context, event }) => glowFor(context, event),
              passage: null,
            }),
          },
        ],
        // The fact's news for the open book (4.3, fourth rule): a re-import re-fetches
        // the chapter, another device's move opens the new place, and an echo of this
        // reader's own turn only refreshes the metadata.
        "book.changed": [
          {
            guard: "reimported",
            target: ".fetching",
            actions: assign({
              book: ({ event }) => pickBook(event),
              chapter: ({ context, event }) => Math.min(context.chapter, event.chapters.length - 1),
              pending: ({ context, event }) => ({ chapter: Math.min(context.chapter, event.chapters.length - 1), block: 0 }),
              quiet: false,
            }),
          },
          // While a turn is unannounced (ready.place.dirty) only a re-import moves the
          // reader; dirty itself takes the rest, and reading aloud, the other region of a
          // page that shows, must not let them through to here as well.
          {
            guard: and(["movedToOtherChapter", not("dirty")]),
            target: ".fetching",
            actions: assign({
              book: ({ event }) => pickBook(event),
              chapter: ({ event }) => event.position.chapter,
              pending: ({ event }) => ({ ...event.position }),
              quiet: true,
            }),
          },
          {
            guard: and(["movedInChapter", not("dirty")]),
            actions: assign({ book: ({ event }) => pickBook(event), pending: ({ event }) => ({ ...event.position }), quiet: true }),
          },
          { guard: and(["ours", not("dirty")]), actions: assign({ book: ({ event }) => pickBook(event) }) },
        ],
      },
      states: {
        // Fetch the current chapter's fragment. not-found (a chapter that is gone)
        // shows nothing rather than an error; the server being unreachable is offline,
        // with a retry.
        fetching: {
          invoke: {
            src: "chapter",
            input: ({ context }) => ({ ask: context.ask, id: context.book.id, chapter: context.chapter }),
            onDone: [
              { guard: "hasHtml", target: "ready", actions: assign({ html: ({ event }) => event.output.html }) },
              { guard: "unavailable", target: "offline" },
              { target: "ready", actions: assign({ html: "" }) },
            ],
            onError: "offline",
          },
        },
        // Two things go on at once on a page that shows: the place, announced after a
        // turn, and reading aloud, which leaving the page (a fetch, a merge) ends.
        ready: {
          type: "parallel",
          states: {
            place: {
              initial: "clean",
              states: {
                clean: {
                  on: {
                    // The view settled on a page and reports its top block. A landing is
                    // only noted; a place the user moved to is recorded and begins the
                    // announcement window.
                    _settled: [
                      {
                        guard: "landed",
                        actions: assign({ at: ({ event }) => ({ chapter: event.chapter, block: event.block }), pending: null, quiet: false }),
                      },
                      { guard: "unmoved", actions: assign({ pending: null }) },
                      {
                        target: "dirty",
                        actions: assign({
                          sent: ({ event }) => ({ chapter: event.chapter, block: event.block }),
                          at: ({ event }) => ({ chapter: event.chapter, block: event.block }),
                          pending: null,
                        }),
                      },
                    ],
                  },
                },
                dirty: {
                  on: {
                    // Targetless so the window is not restarted: turns within it join the
                    // one announcement at its end (4.3, third rule).
                    _settled: {
                      actions: assign({
                        sent: ({ event }) => ({ chapter: event.chapter, block: event.block }),
                        at: ({ event }) => ({ chapter: event.chapter, block: event.block }),
                        pending: null,
                      }),
                    },
                    // An unannounced turn is the newest place (5: last write wins); the
                    // fact's news, the ack of an earlier place, refreshes the metadata and
                    // never moves the reader. A re-import falls through to the parent.
                    "book.changed": { guard: "oursSameContent", actions: assign({ book: ({ event }) => pickBook(event) }) },
                  },
                  after: {
                    [PROGRESS_MS]: { target: "clean", actions: "announce" },
                  },
                },
              },
            },
            speech: SPEECH,
          },
        },
        offline: {
          on: { _retry: "fetching" },
        },
        // A merge in flight (Decision 6): read the involved notes, then save the survivor
        // with the union place and the joined comments and discard the rest, and return to
        // reading. The chapter and its fragment are unchanged, so the page keeps showing;
        // the merged marks appear when notes echoes note.changed / note.deleted (4.3). A
        // read that lost the survivor makes nothing rather than a save with no base.
        merging: {
          invoke: {
            src: "readNotes",
            input: ({ context }) => ({ ask: context.ask, ids: context.merge.ids }),
            onDone: {
              target: "ready",
              actions: enqueueActions(({ context, event, enqueue }) => {
                const notes = new Map(event.output.map((n) => [n.id, n]));
                const [survivorId, ...otherIds] = context.merge.ids;
                const survivor = notes.get(survivorId);
                if (survivor) {
                  const body = joined(context.merge.ids.map((id) => notes.get(id)?.body ?? ""));
                  const about = (Array.isArray(survivor.about) ? survivor.about : []).map((l) =>
                    l.kind === "book" && l.id === context.book.id && l.place
                      ? { ...l, place: context.merge.place, quote: context.merge.quote }
                      : l,
                  );
                  enqueue.emit({ type: "note.saved", id: survivorId, title: titleOf(body), body, baseVersion: survivor.version, about, left: true });
                  for (const id of otherIds) enqueue.emit({ type: "note.discarded", id });
                }
                enqueue.assign({ merge: null });
              }),
            },
            onError: { target: "ready", actions: assign({ merge: null }) },
          },
        },
        // A re-anchoring in flight (session 7): read the notes whose places the view
        // corrected, then re-save each with the same title and body and its book link's
        // place replaced — the new chapter, blocks, offsets and current content version —
        // so the passage is found without searching again. The chapter and its fragment are
        // unchanged, so the page keeps showing; the corrected marks were already painted
        // from the adopted place. A note the read cannot find is left as it was.
        reanchoring: {
          invoke: {
            src: "readNotes",
            input: ({ context }) => ({ ask: context.ask, ids: context.reanchor.items.map((i) => i.id) }),
            onDone: {
              target: "ready",
              actions: enqueueActions(({ context, event, enqueue }) => {
                const notes = new Map(event.output.map((n) => [n.id, n]));
                for (const item of context.reanchor.items) {
                  const note = notes.get(item.id);
                  if (!note) continue;
                  const about = (Array.isArray(note.about) ? note.about : []).map((l) =>
                    l.kind === "book" && l.id === context.book.id && l.place ? { ...l, place: item.place } : l,
                  );
                  enqueue.emit({ type: "note.saved", id: note.id, title: note.title ?? "", body: note.body ?? "", baseVersion: note.version, about, left: true });
                }
                enqueue.assign({ reanchor: null });
              }),
            },
            onError: { target: "ready", actions: assign({ reanchor: null }) },
          },
        },
      },
    },
  },
});
