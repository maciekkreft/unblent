import { setup, assign, fromPromise, emit, enqueueActions } from "xstate";

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
export const snapToWords = (texts, range) => {
  let start = { ...range.start };
  let end = { ...range.end };
  // Grow an end that sits inside a word out to the word's edge; an end already at a
  // boundary (against space or punctuation) is left for the trim below, so a selection
  // that stops at a space does not swallow the next word.
  while (start.offset > 0 && isWord(texts[start.block][start.offset]) && isWord(texts[start.block][start.offset - 1])) {
    start.offset -= 1;
  }
  while (end.offset < texts[end.block].length && isWord(texts[end.block][end.offset]) && isWord(texts[end.block][end.offset - 1])) {
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

// A highlight's title is its comment's first line that says anything (12), the same rule the
// highlights editor uses (highlight-notes titleOf), so a merged note's title reads from its
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
  l: [1, shown],
  h: [-1, shown],
  w: [1, wordStart],
  b: [-1, wordStart],
  ")": [1, sentenceStart],
  "(": [-1, sentenceStart],
  "}": [1, blockEnd],
  "{": [-1, blockStart],
};

export const isMotion = (key) => Object.hasOwn(MOTIONS, key);

// The cursor after one motion. Past the last word, sentence or block it goes to the
// chapter's last character, and before the first to its first, as Vim does.
export const step = ({ flat }, i, key) => {
  const [dir, ok] = MOTIONS[key];
  return seek(flat, i, dir, ok) ?? (dir > 0 ? seek(flat, flat.length, -1, shown) : seek(flat, -1, 1, shown)) ?? i;
};

// The passage a highlight begun at `start` covers with the cursor at `cursor`, as
// [from, to) flat indexes. The cursor is the character the next keypress acts on, so when
// it has moved forward onto the start of a word, sentence or paragraph (w, ), l onto a
// new word) that start is where the passage stops, not part of it: v w w covers two
// whole words. Moving back, the cursor's character is the passage's first. White space
// at either end is dropped.
export const passage = ({ flat }, start, cursor) => {
  let lo = Math.min(start, cursor);
  let hi = Math.max(start, cursor);
  if (cursor > start && wordStart(flat, cursor)) hi = cursor - 1;
  while (hi > lo && blank(flat[hi])) hi -= 1;
  while (lo < hi && blank(flat[lo])) lo += 1;
  return [lo, hi + 1];
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

// A Set with one id removed, as a new Set so assign sees a fresh value (the note-list
// idiom): XState keeps context immutable, and the view re-renders on every snapshot.
const without = (set, id) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

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
      "new passage. After a re-import it finds each highlight's quote again and saves its " +
      "corrected place; a highlight whose quote is no longer in the book stays a note with its " +
      "quote and its comment. With the \"Vim keys\" preference on and the reader focused, a " +
      "one-character cursor shows, starting at the top of the page and kept while the reader " +
      "is left and returned to; w, b, ), (, }, {, 0, $, j, k, l and h move it, a click on the " +
      "text puts it there, and a cursor that leaves the page turns the page. v starts a " +
      "highlight at the cursor, the same keys grow it, Enter makes it and Escape drops it. " +
      "Space, the arrows, Page Up and Page Down, and Ctrl+f and Ctrl+b turn pages, taking the " +
      "cursor to the new page's top; gg and G go to the chapter's first and last page.",
    kind: "view",
    emits: ["book.progressed", "note.saved", "note.discarded"],
    attributes: ["height", "highlights"],
    asks: ["books: open", "books: read", "books: chapter", "notes: list", "notes: read", "settings: read"],
  },
  context: ({ input }) => ({
    ask: input.ask,
    // The "Vim keys" device preference (12): off until settings says otherwise, and off
    // on a page without it (the ask replies no-answerer).
    vimKeys: false,
    // A ULID for a new highlight note (Decision 1); arrives through input so the machine
    // stays importable in Node.
    mint: input.mint,
    // The window a removed highlight can be brought back within (the --duration-undo
    // token, read in the view and passed in so the machine stays importable in Node):
    // the same delayed delete note-list uses (session 3). A removal is not a fact until
    // the window ends, so an undone removal never touched the note.
    undoMs: input.undoMs,
    // The `highlights` attribute (Decision 3): off is exactly today's reader — no notes
    // asked, no painting, no highlight gesture. Arrives through input.
    highlighting: Boolean(input.highlighting),
    // The highlight notes of the open book, reduced to what the view paints (id, place,
    // quote, commented). Reset when the book changes; kept current from note.changed and
    // note.deleted after the starting list (4.3).
    highlights: [],
    // The highlight ids counting down to a removal, each with its own cancelable timer
    // (session 3): the bubble shows Undo and the mark stays dimmed until the window ends,
    // when note.discarded makes the removal a fact. Not reset on a book change, so a
    // removal the user did not undo still completes if they navigate away.
    discarding: new Set(),
    // A one-shot for the view: a drag wholly inside an existing highlight makes no new
    // note; instead the reader opens that highlight's bubble (Decision 6, session 3). The
    // bus cannot route an internal message to a view, so the id rides in context with a
    // nonce the view acts on once. Null until the first such drag.
    reveal: null,
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
  // Beside the states, so the preference arrives whatever the view is doing.
  invoke: {
    src: "settings",
    input: ({ context }) => ({ ask: context.ask }),
    onDone: { actions: assign({ vimKeys: ({ event }) => event.output?.vimKeys === true }) },
    onError: { actions: [] },
  },
  initial: "starting",
  on: {
    "settings.changed": { actions: assign({ vimKeys: ({ event }) => event.vimKeys === true }) },
    // The open book changed (4.3, fourth rule): the fact says which book is open now,
    // whether the user opened it here, or on another device and this tab pulled it.
    // A book id reads it at its saved position; null empties the reader.
    "book.opened": [
      {
        guard: ({ event }) => event.id != null,
        target: ".opening",
        actions: assign({ id: ({ event }) => event.id, book: null, html: "", pending: null, sent: null, quiet: false, at: null, chapter: 0, highlights: [] }),
      },
      {
        target: ".empty",
        actions: assign({ id: null, book: null, html: "", pending: null, sent: null, quiet: false, at: null, chapter: 0, highlights: [] }),
      },
    ],
    // The fact's news that the open book is gone (4.3, fourth rule): back to the empty
    // page. A deletion of another book is left to the bus to record as ignored.
    "book.deleted": {
      guard: ({ context, event }) => Boolean(context.book) && event.id === context.book.id,
      target: ".empty",
      actions: assign({ id: null, book: null, html: "", pending: null, sent: null, quiet: false, at: null, chapter: 0, highlights: [] }),
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
          actions: assign({ highlights: ({ context, event }) => highlightsOf(event.output.notes ?? [], context.book.id) }),
        },
        onError: {},
      },
      on: {
        // The user made a highlight (Decision 3): one actor message, the mouse only one
        // producer of it. Snap to words; then, against the known highlights of this chapter:
        // a range wholly inside one changes nothing (session 3 opens that highlight's
        // bubble); a range clear of them all is a new note, its body the empty comment; a
        // range that overlaps or touches one or more merges them into one (Decision 6). The
        // merge needs the involved comments and versions, so it is planned here and read in
        // `merging`; the plain cases emit at once.
        _highlight: {
          guard: ({ context }) => context.highlighting && Boolean(context.book),
          actions: enqueueActions(({ context, event, enqueue }) => {
            const range = snapToWords(event.texts, { start: event.start, end: event.end });
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
          actions: assign({ highlights: ({ context, event }) => foldHighlight(context.highlights, event, context.book.id) }),
        },
        "note.deleted": {
          guard: ({ context }) => context.highlighting,
          actions: enqueueActions(({ context, event, enqueue }) => {
            enqueue.assign({
              highlights: ({ context }) => context.highlights.filter((h) => h.id !== event.id),
              discarding: ({ context }) => without(context.discarding, event.id),
            });
            // The fact confirms the removal (this device's own elapse, or another's):
            // clear any countdown still standing for it (session 3).
            if (context.discarding.has(event.id)) enqueue.cancel(`remove:${event.id}`);
          }),
        },
        // Remove a highlight (session 3): the same delayed delete as note-list. _remove
        // begins the undo window (the bubble reads Removed · Undo, the mark stays dimmed),
        // _undo cancels it, and only _elapsed makes the removal a fact — note.discarded,
        // which notes tombstones and echoes back as note.deleted, dropping the mark.
        // Nothing is emitted until the window ends, so an undone removal never touched
        // the note. The mouse is only one producer of _remove; a later Vim keymap sends
        // the same message.
        _remove: {
          guard: ({ context, event }) =>
            context.highlights.some((h) => h.id === event.id) && !context.discarding.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.assign({ discarding: ({ context }) => new Set(context.discarding).add(event.id) });
            enqueue.raise({ type: "_elapsed", id: event.id }, { delay: ({ context }) => context.undoMs, id: `remove:${event.id}` });
          }),
        },
        _undo: {
          guard: ({ context, event }) => context.discarding.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.cancel(`remove:${event.id}`);
            enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
          }),
        },
        _elapsed: {
          guard: ({ context, event }) => context.discarding.has(event.id),
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.assign({ discarding: ({ context }) => without(context.discarding, event.id) });
            enqueue.emit({ type: "note.discarded", id: event.id });
          }),
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
          {
            guard: "movedToOtherChapter",
            target: ".fetching",
            actions: assign({
              book: ({ event }) => pickBook(event),
              chapter: ({ event }) => event.position.chapter,
              pending: ({ event }) => ({ ...event.position }),
              quiet: true,
            }),
          },
          {
            guard: "movedInChapter",
            actions: assign({ book: ({ event }) => pickBook(event), pending: ({ event }) => ({ ...event.position }), quiet: true }),
          },
          { guard: "ours", actions: assign({ book: ({ event }) => pickBook(event) }) },
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
        ready: {
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
                  enqueue.emit({ type: "note.saved", id: survivorId, title: titleOf(body), body, baseVersion: survivor.version, about });
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
                  enqueue.emit({ type: "note.saved", id: note.id, title: note.title ?? "", body: note.body ?? "", baseVersion: note.version, about });
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
