import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine, snapToWords, quoteOf, overlaps, segments, highlightsOf, hasComment, union, joined, locate, chapterText, pointAt, indexOf, step, charStep, nearest, isMotion, passage, linkLabel, sourceLink, highlightAt } from "../machine.js";

// The actor is where the reader's decisions live (3.2): which chapter it shows, the
// place it owes the view, and when it announces a turn. It is driven here with a fake
// `ask` — the shape fact.js builds for real — and a SimulatedClock for the throttle,
// so the logic is checked without a browser. Pagination and rendering are the view's,
// tested in the browser (page.test.mjs); everything here is a decision.

const PROGRESS_MS = 600; // book-reader/view sends _settled; the machine throttles it
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await tick();
};

const bookReply = (over = {}) => ({
  book: {
    id: ID,
    title: "T",
    author: "A",
    cover: null,
    chapters: [{ title: "One" }, { title: "Two" }, { title: "Three" }],
    toc: [],
    position: { chapter: 0, block: 0 },
    version: 1,
    contentVersion: 1,
    pending: false,
    addedAt: 10,
    updatedAt: 10,
    ...over,
  },
});

// A book.changed carries the whole book (7.1); build one for the open id.
const changedEvent = (over = {}) => ({ type: "book.changed", ...bookReply(over).book, ...over });

function start({ read, chapter, open } = {}) {
  const clock = new SimulatedClock();
  const ask = (target, name, payload) => {
    if (name === "open") return Promise.resolve(open ?? { id: null });
    if (name === "read") return Promise.resolve(read ?? bookReply());
    if (name === "chapter") return Promise.resolve(chapter ? chapter(payload) : { title: "t", html: "<p>x</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask }, clock });
  const progressed = [];
  actor.on("book.progressed", (e) => progressed.push(e));
  actor.start();
  return { actor, progressed, clock };
}

// Open a book and settle in reading.ready. The fact announces the open book with
// book.opened, whether the user opened it here or another device did (4.3, fourth rule).
async function open(opts) {
  const h = start(opts);
  await flush(); // let the starting `books: open` ask settle (empty by default)
  h.actor.send({ type: "book.opened", id: ID });
  await flush();
  return h;
}

const state = (actor) => actor.getSnapshot().value;
const ctx = (actor) => actor.getSnapshot().context;

test("book.opened reads the book and opens it at its saved place", async () => {
  const { actor } = await open({ read: bookReply({ position: { chapter: 1, block: 4 } }) });
  assert.ok(actor.getSnapshot().matches({ reading: "ready" }), `expected reading.ready, got ${JSON.stringify(state(actor))}`);
  assert.equal(ctx(actor).chapter, 1, "opens the saved chapter");
  assert.deepEqual(ctx(actor).pending, { chapter: 1, block: 4 }, "owes the view the saved block");
  assert.equal(ctx(actor).html, "<p>x</p>");
});

test("a read that finds nothing falls back to the empty page", async () => {
  const { actor } = await open({ read: { error: "not-found" } });
  assert.equal(state(actor), "empty");
});

test("a settled turn is announced once, after the throttle window", async () => {
  const { actor, progressed, clock } = await open();
  actor.send({ type: "_settled", chapter: 0, block: 3 });
  clock.increment(PROGRESS_MS - 1);
  await flush();
  assert.equal(progressed.length, 0, "nothing before the window closes");
  clock.increment(1);
  await flush();
  assert.deepEqual(progressed, [{ type: "book.progressed", id: ID, chapter: 0, block: 3 }]);
});

test("turns within the window coalesce to the last place, one announcement", async () => {
  const { actor, progressed, clock } = await open();
  actor.send({ type: "_settled", chapter: 0, block: 2 });
  clock.increment(300);
  actor.send({ type: "_settled", chapter: 0, block: 5 });
  clock.increment(PROGRESS_MS);
  await flush();
  assert.deepEqual(progressed, [{ type: "book.progressed", id: ID, chapter: 0, block: 5 }], "one, at the latest place");
});

test("landing at the saved place is not announced as a turn", async () => {
  // The reader opens at the fact's saved position (5). The view settles there, but the
  // user did not turn, so nothing is announced: announcing would send this device's
  // place over a newer one a pull is about to bring, the sync bug this guards.
  const { actor, progressed, clock } = await open({ read: bookReply({ position: { chapter: 0, block: 7 } }) });
  actor.send({ type: "_settled", chapter: 0, block: 7 });
  clock.increment(PROGRESS_MS);
  await flush();
  assert.deepEqual(progressed, [], "the landing is not progress");
});

test("adopting another device's move is not echoed back as a turn", async () => {
  // A pull brings a newer place (book.changed); the reader opens it, the view lands
  // there, and that landing must not be announced back (5: last write wins, no echo).
  const { actor, progressed, clock } = await open();
  actor.send(changedEvent({ version: 2, position: { chapter: 0, block: 9 } }));
  await flush();
  assert.deepEqual(ctx(actor).pending, { chapter: 0, block: 9 }, "the move is adopted");
  actor.send({ type: "_settled", chapter: 0, block: 9 });
  clock.increment(PROGRESS_MS);
  await flush();
  assert.deepEqual(progressed, [], "the adopted place is not announced back");
});

test("a page turn past the chapter loads the next, at its first block", async () => {
  const { actor } = await open();
  actor.send({ type: "_next" });
  await flush();
  assert.equal(ctx(actor).chapter, 1, "moved to the next chapter");
  assert.deepEqual(ctx(actor).pending, { chapter: 1, block: 0 }, "opens its first block");
  assert.ok(actor.getSnapshot().matches({ reading: "ready" }));
});

test("a turn back past the first page loads the previous chapter at its last page", async () => {
  const { actor } = await open({ read: bookReply({ position: { chapter: 2, block: 0 } }) });
  actor.send({ type: "_prev" });
  await flush();
  assert.equal(ctx(actor).chapter, 1);
  assert.equal(ctx(actor).pending.block, Infinity, "opens the previous chapter's last page");
});

test("_next on the last chapter and _prev on the first do nothing", async () => {
  const last = await open({ read: bookReply({ position: { chapter: 2, block: 0 } }) });
  last.actor.send({ type: "_next" });
  await flush();
  assert.equal(ctx(last.actor).chapter, 2, "stays on the last chapter");

  const first = await open();
  first.actor.send({ type: "_prev" });
  await flush();
  assert.equal(ctx(first.actor).chapter, 0, "stays on the first chapter");
});

test("the contents' jump opens a chapter's first page", async () => {
  const { actor } = await open();
  actor.send({ type: "chapter.selected", id: ID, chapter: 2 });
  await flush();
  assert.equal(ctx(actor).chapter, 2);
  assert.deepEqual(ctx(actor).pending, { chapter: 2, block: 0 });
});

test("a link jumps to a chapter and a block within it", async () => {
  const { actor } = await open();
  actor.send({ type: "_link", chapter: 1, block: 7 });
  await flush();
  assert.equal(ctx(actor).chapter, 1);
  assert.deepEqual(ctx(actor).pending, { chapter: 1, block: 7 });
});

test("another device's move is adopted; the reader's own echo is not", async () => {
  const { actor, clock } = await open();
  // Record where this reader last settled.
  actor.send({ type: "_settled", chapter: 0, block: 0 });
  await flush();

  // The echo of that place (same position, newer version) only refreshes metadata.
  actor.send(changedEvent({ version: 2, position: { chapter: 0, block: 0 } }));
  await flush();
  assert.equal(ctx(actor).chapter, 0, "the echo does not move the reader");
  assert.equal(ctx(actor).book.version, 2, "but the metadata is adopted");

  // A newer version at a different place in another chapter moves and re-fetches. The
  // window must be closed first, so the move arrives in ready.clean, not while a turn
  // is still unannounced (dirty), where the fact's news never moves the reader.
  clock.increment(PROGRESS_MS);
  await flush();
  actor.send(changedEvent({ version: 3, position: { chapter: 2, block: 1 } }));
  await flush();
  assert.equal(ctx(actor).chapter, 2, "adopts the other device's chapter");
  assert.deepEqual(ctx(actor).pending, { chapter: 2, block: 1 });
});

test("an ack that lands during an unannounced turn does not move the reader", async () => {
  const { actor, progressed, clock } = await open();
  // Land at the saved place (block 0); the landing is not the user's turn and is not
  // announced. A real turn to block 2 is, so `books` hears block 2.
  actor.send({ type: "_settled", chapter: 0, block: 0 });
  actor.send({ type: "_settled", chapter: 0, block: 2 });
  clock.increment(PROGRESS_MS);
  await flush();

  // The user turns again (dirty); before the window closes, the ack of the earlier
  // place lands as a newer version at block 2 (5: the ack carries the last place books
  // heard). It refreshes the metadata but must not pull the reader back.
  actor.send({ type: "_settled", chapter: 0, block: 4 });
  actor.send(changedEvent({ version: 2, position: { chapter: 0, block: 2 } }));
  await flush();
  assert.equal(ctx(actor).pending, null, "the reader is not moved");
  assert.equal(ctx(actor).chapter, 0);
  assert.equal(ctx(actor).book.version, 2, "but the metadata is adopted");

  // The window closes: the newest place, block 4, is what is announced.
  clock.increment(PROGRESS_MS);
  await flush();
  assert.deepEqual(progressed, [
    { type: "book.progressed", id: ID, chapter: 0, block: 2 },
    { type: "book.progressed", id: ID, chapter: 0, block: 4 },
  ]);
});

test("a re-import while a turn is unannounced still re-fetches the chapter", async () => {
  const { actor } = await open();
  actor.send({ type: "_settled", chapter: 0, block: 4 }); // dirty
  // A new contentVersion means the fragments changed; this must reach the parent
  // handler and re-open, even while dirty.
  actor.send(changedEvent({ version: 2, contentVersion: 2, position: { chapter: 0, block: 0 } }));
  await flush();
  assert.deepEqual(ctx(actor).pending, { chapter: 0, block: 0 }, "the re-import re-opens");
});

test("the open book being deleted returns to the empty page", async () => {
  const { actor } = await open();
  actor.send({ type: "book.deleted", id: ID2 });
  await flush();
  assert.ok(actor.getSnapshot().matches("reading"), "a different book's deletion is ignored");
  actor.send({ type: "book.deleted", id: ID });
  await flush();
  assert.equal(state(actor), "empty");
});

test("opening another book switches to it", async () => {
  const { actor } = await open();
  actor.send({ type: "book.opened", id: ID2 });
  await flush();
  assert.ok(actor.getSnapshot().matches({ reading: "ready" }));
});

test("on load it asks which book is open and reopens it", async () => {
  const h = start({ open: { id: ID }, read: bookReply({ position: { chapter: 2, block: 1 } }) });
  await flush();
  assert.ok(h.actor.getSnapshot().matches({ reading: "ready" }), `expected reading.ready, got ${JSON.stringify(state(h.actor))}`);
  assert.equal(ctx(h.actor).chapter, 2, "reopens at the saved chapter");
});

test("book.opened with a null id empties the reader", async () => {
  const { actor } = await open();
  assert.ok(actor.getSnapshot().matches("reading"));
  actor.send({ type: "book.opened", id: null });
  await flush();
  assert.equal(state(actor), "empty");
});

test("an unreachable server shows offline, and retry reloads the chapter", async () => {
  let fail = true;
  const { actor } = await open({ chapter: () => (fail ? { error: "unavailable" } : { title: "t", html: "<p>y</p>" }) });
  assert.ok(actor.getSnapshot().matches({ reading: "offline" }), `expected offline, got ${JSON.stringify(state(actor))}`);
  fail = false;
  actor.send({ type: "_retry" });
  await flush();
  assert.ok(actor.getSnapshot().matches({ reading: "ready" }));
  assert.equal(ctx(actor).html, "<p>y</p>");
});

// --- Highlights (Decision 1-4, session 2) ----------------------------------------
//
// The pure text functions first: everything the mouse gesture and the painting rest on
// works on text positions alone (block, offset), so it is checked here without a browser.

test("snapToWords grows a mid-word range to whole words and trims white space", () => {
  const texts = ["Hello there world"];
  assert.deepEqual(snapToWords(texts, { start: { block: 0, offset: 7 }, end: { block: 0, offset: 9 } }), {
    start: { block: 0, offset: 6 },
    end: { block: 0, offset: 11 },
  });
  // A range that grabbed the trailing space is trimmed back to the word.
  assert.deepEqual(snapToWords(texts, { start: { block: 0, offset: 6 }, end: { block: 0, offset: 12 } }), {
    start: { block: 0, offset: 6 },
    end: { block: 0, offset: 11 },
  });
});

test("snapToWords keeps the apostrophe inside a word and crosses blocks by trimming", () => {
  assert.deepEqual(snapToWords(["don't stop"], { start: { block: 0, offset: 2 }, end: { block: 0, offset: 3 } }), {
    start: { block: 0, offset: 0 },
    end: { block: 0, offset: 5 },
  });
  // A selection dragged from one block into the white space at the top of the next trims
  // back into the first block.
  assert.deepEqual(snapToWords(["one two", "three"], { start: { block: 0, offset: 4 }, end: { block: 1, offset: 0 } }), {
    start: { block: 0, offset: 4 },
    end: { block: 0, offset: 7 },
  });
});

test("snapToWords returns null when nothing but white space is left", () => {
  assert.equal(snapToWords(["   "], { start: { block: 0, offset: 0 }, end: { block: 0, offset: 3 } }), null);
});

test("quoteOf takes the exact text, joins blocks with a newline, and keeps context", () => {
  const texts = ["one two", "three four"];
  assert.deepEqual(quoteOf(texts, { start: { block: 0, offset: 4 }, end: { block: 1, offset: 5 } }), {
    exact: "two\nthree",
    prefix: "one ",
    suffix: " four",
  });
  // Context is capped at 32 characters, each in its own block.
  const long = ["x".repeat(50) + "WORD" + "y".repeat(50)];
  const q = quoteOf(long, { start: { block: 0, offset: 50 }, end: { block: 0, offset: 54 } });
  assert.equal(q.exact, "WORD");
  assert.equal(q.prefix, "x".repeat(32));
  assert.equal(q.suffix, "y".repeat(32));
});

test("overlaps is true for a nested, an abutting, and a cross-block range, false when apart", () => {
  const a = { start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } };
  assert.equal(overlaps(a, { start: { block: 0, offset: 2 }, end: { block: 0, offset: 4 } }), true, "nested");
  assert.equal(overlaps(a, { start: { block: 0, offset: 5 }, end: { block: 0, offset: 8 } }), true, "touching counts");
  assert.equal(overlaps(a, { start: { block: 0, offset: 6 }, end: { block: 0, offset: 8 } }), false, "a gap apart");
  const across = { start: { block: 0, offset: 2 }, end: { block: 1, offset: 3 } };
  assert.equal(overlaps(across, { start: { block: 1, offset: 0 }, end: { block: 1, offset: 2 } }), true, "cross-block");
});

test("segments splits a range per block and drops the empty ones", () => {
  const texts = ["abcdef", "ghij", "klmno"];
  assert.deepEqual(segments({ start: { block: 0, offset: 4 }, end: { block: 2, offset: 3 } }, texts), [
    { block: 0, from: 4, to: 6 },
    { block: 1, from: 0, to: 4 },
    { block: 2, from: 0, to: 3 },
  ]);
  // A range ending exactly at the top of a block paints nothing in that block.
  assert.deepEqual(segments({ start: { block: 0, offset: 4 }, end: { block: 1, offset: 0 } }, ["abcdef", "ghi"]), [
    { block: 0, from: 4, to: 6 },
  ]);
});

test("highlightsOf keeps only the book's placed links, with the comment flag", () => {
  const notes = [
    { id: "n1", title: "", about: [{ kind: "book", id: "bk1", place: { chapter: 0 }, quote: { exact: "a" } }] },
    { id: "n2", title: "Note", about: [{ kind: "book", id: "bk1", place: { chapter: 1 }, quote: { exact: "b" } }] },
    { id: "n3", title: "", about: [{ kind: "book", id: "bk1" }] }, // about the book but not a highlight
    { id: "n4", title: "", about: [{ kind: "book", id: "bk2", place: { chapter: 0 }, quote: { exact: "c" } }] },
    { id: "n5", title: "", about: [] },
  ];
  assert.deepEqual(highlightsOf(notes, "bk1"), [
    { id: "n1", place: { chapter: 0 }, quote: { exact: "a" }, commented: false },
    { id: "n2", place: { chapter: 1 }, quote: { exact: "b" }, commented: true },
  ]);
});

test("hasComment reads the title, which the Highlights page fills from the comment", () => {
  assert.equal(hasComment({ title: "" }), false);
  assert.equal(hasComment({ title: "A remark" }), true);
});

// --- The _highlight message: snap, guard overlaps, emit note.saved -----------------

const HL_TEXTS = ["Hello there world"];
const HL_ID = "01ARZ3NDEKTSV4RRFFQ69G5H01";

// A highlight note about the open book (ID), used to seed the reader's known highlights.
const highlightNote = (id, place, over = {}) => ({
  id,
  title: over.title ?? "",
  about: [{ kind: "book", id: ID, place, quote: { exact: "x", prefix: "", suffix: "" } }],
});

const PLACE_HELLO = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } };

// Open a book with highlighting on, a mint, and a notes: list the fake `ask` answers.
async function openHL({ notes = [], mint } = {}) {
  const clock = new SimulatedClock();
  const ask = (target, name) => {
    if (target === "notes" && name === "list") return Promise.resolve({ notes });
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "read") return Promise.resolve(bookReply());
    if (name === "chapter") return Promise.resolve({ title: "t", html: "<p>x</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask, mint: mint ?? (() => HL_ID), highlighting: true }, clock });
  const saved = [];
  actor.on("note.saved", (e) => saved.push(e));
  actor.start();
  await flush();
  actor.send({ type: "book.opened", id: ID });
  await flush();
  return { actor, saved, clock };
}

test("opening a book with highlighting loads its highlights from notes: list", async () => {
  const { actor } = await openHL({ notes: [highlightNote("n1", PLACE_HELLO, { title: "A note" })] });
  assert.deepEqual(ctx(actor).highlights, [
    { id: "n1", place: PLACE_HELLO, quote: { exact: "x", prefix: "", suffix: "" }, commented: true },
  ]);
});

test("with highlighting off the reader asks notes nothing and keeps no highlights", async () => {
  const asked = [];
  const ask = (target, name) => {
    asked.push([target, name]);
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "read") return Promise.resolve(bookReply());
    if (name === "chapter") return Promise.resolve({ title: "t", html: "<p>x</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask, mint: () => HL_ID, highlighting: false } });
  actor.start();
  await flush();
  actor.send({ type: "book.opened", id: ID });
  await flush();
  assert.deepEqual(ctx(actor).highlights, []);
  assert.ok(!asked.some(([t, n]) => t === "notes" && n === "list"), "notes: list is never asked");
});

test("_highlight snaps the range and emits a new note with the place and quote", async () => {
  const { actor, saved } = await openHL();
  // A drag inside "there" (offsets 7-9) snaps to the whole word.
  actor.send({ type: "_highlight", start: { block: 0, offset: 7 }, end: { block: 0, offset: 9 }, texts: HL_TEXTS });
  await flush();
  assert.equal(saved.length, 1);
  const note = saved[0];
  assert.equal(note.id, HL_ID);
  assert.equal(note.title, "");
  assert.equal(note.body, "");
  assert.equal(note.baseVersion, null);
  assert.deepEqual(note.about, [
    {
      kind: "book",
      id: ID,
      place: { chapter: 0, contentVersion: 1, start: { block: 0, offset: 6 }, end: { block: 0, offset: 11 } },
      quote: { exact: "there", prefix: "Hello ", suffix: " world" },
    },
  ]);
});

test("_highlight over a known highlight of the chapter makes nothing", async () => {
  const { actor, saved } = await openHL({ notes: [highlightNote("n1", PLACE_HELLO)] });
  // A drag inside "Hello" (already highlighted) snaps back onto it and emits nothing.
  actor.send({ type: "_highlight", start: { block: 0, offset: 2 }, end: { block: 0, offset: 4 }, texts: HL_TEXTS });
  await flush();
  assert.deepEqual(saved, []);
});

test("a highlight in another chapter does not block a new one here", async () => {
  const other = { chapter: 2, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } };
  const { actor, saved } = await openHL({ notes: [highlightNote("n1", other)] });
  actor.send({ type: "_highlight", start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 }, texts: HL_TEXTS });
  await flush();
  assert.equal(saved.length, 1, "the other chapter's highlight does not overlap this one");
});

test("_highlight that snaps to nothing (white space) emits nothing", async () => {
  const { actor, saved } = await openHL();
  actor.send({ type: "_highlight", start: { block: 0, offset: 5 }, end: { block: 0, offset: 6 }, texts: HL_TEXTS });
  await flush();
  assert.deepEqual(saved, []);
});

test("note.changed adds a highlight, updates its comment, and drops one that lost its place", async () => {
  const { actor } = await openHL();
  const placed = highlightNote("n1", PLACE_HELLO);
  actor.send({ type: "note.changed", ...placed, body: "", version: 1, updatedAt: 10 });
  assert.equal(ctx(actor).highlights.length, 1);
  assert.equal(ctx(actor).highlights[0].commented, false);
  // A comment arrives: the flag flips, no second row.
  actor.send({ type: "note.changed", ...highlightNote("n1", PLACE_HELLO, { title: "Remark" }), body: "Remark", version: 2, updatedAt: 20 });
  assert.equal(ctx(actor).highlights.length, 1);
  assert.equal(ctx(actor).highlights[0].commented, true);
  // The link loses its place (unhighlighted): it drops out of the painted set.
  actor.send({ type: "note.changed", id: "n1", title: "Remark", body: "Remark", version: 3, updatedAt: 30, about: [{ kind: "book", id: ID }] });
  assert.deepEqual(ctx(actor).highlights, []);
});

test("note.deleted removes a highlight", async () => {
  const { actor } = await openHL({ notes: [highlightNote("n1", PLACE_HELLO)] });
  assert.equal(ctx(actor).highlights.length, 1);
  actor.send({ type: "note.deleted", id: "n1" });
  assert.deepEqual(ctx(actor).highlights, []);
});

// --- Merging overlapping highlights (Decision 6, session 6) -------------------------
//
// The pure geometry and text first, then the whole exchange with a fake `ask`: a drag that
// overlaps or touches known highlights combines them into the earliest, grown to the union,
// its comments joined; the rest are discarded (note.discarded).

test("union covers the earliest start and the latest end of a set of ranges", () => {
  assert.deepEqual(
    union([
      { start: { block: 0, offset: 3 }, end: { block: 0, offset: 8 } },
      { start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } },
      { start: { block: 1, offset: 0 }, end: { block: 1, offset: 4 } },
    ]),
    { start: { block: 0, offset: 0 }, end: { block: 1, offset: 4 } },
  );
  // A single range is its own union.
  const one = { start: { block: 0, offset: 2 }, end: { block: 0, offset: 6 } };
  assert.deepEqual(union([one]), one);
});

test("joined stacks the non-empty comments with a blank line, dropping the bare ones", () => {
  assert.equal(joined(["First", "", "Second"]), "First\n\nSecond");
  assert.equal(joined(["  ", "Only"]), "Only");
  assert.equal(joined(["", "  "]), "");
});

// A full highlight note (list row plus body/version/about) the fake `ask` answers reads of.
const fullNote = (id, place, { body = "", title = "", version = 1, extra = [] } = {}) => ({
  id,
  title,
  body,
  version,
  updatedAt: 10,
  about: [{ kind: "book", id: ID, place, quote: { exact: "x", prefix: "", suffix: "" } }, ...extra],
});

// "Hello there world": Hello 0-5, world 12-17. Open a book highlighting, with a notes: list
// of the given full notes and a notes: read that answers each by id.
async function openMerge(notes) {
  const clock = new SimulatedClock();
  const byId = Object.fromEntries(notes.map((n) => [n.id, n]));
  const ask = (target, name, payload) => {
    if (target === "notes" && name === "list")
      return Promise.resolve({ notes: notes.map(({ id, title, about }) => ({ id, title, about })) });
    if (target === "notes" && name === "read")
      return Promise.resolve(byId[payload.id] ? { note: byId[payload.id] } : { error: "not-found" });
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "read") return Promise.resolve(bookReply());
    if (name === "chapter") return Promise.resolve({ title: "t", html: "<p>x</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask, mint: () => HL_ID, highlighting: true }, clock });
  const saved = [];
  const discarded = [];
  actor.on("note.saved", (e) => saved.push(e));
  actor.on("note.discarded", (e) => discarded.push(e));
  actor.start();
  await flush();
  actor.send({ type: "book.opened", id: ID });
  await flush();
  return { actor, saved, discarded };
}

const P_HELLO = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } };
const P_WORLD = { chapter: 0, contentVersion: 1, start: { block: 0, offset: 12 }, end: { block: 0, offset: 17 } };

test("a drag over two highlights merges them into the earliest, comments joined in book order", async () => {
  const { actor, saved, discarded } = await openMerge([
    fullNote("n1", P_HELLO, { title: "First", body: "First comment", version: 3 }),
    fullNote("n2", P_WORLD, { title: "Second", body: "Second comment", version: 5 }),
  ]);
  // Drag from inside "Hello" to inside "world": snaps to the whole span, overlapping both.
  actor.send({ type: "_highlight", start: { block: 0, offset: 2 }, end: { block: 0, offset: 14 }, texts: HL_TEXTS });
  await flush();
  assert.equal(saved.length, 1, "one survivor is saved");
  const s = saved[0];
  assert.equal(s.id, "n1", "the earliest highlight survives");
  assert.equal(s.baseVersion, 3, "saved on the survivor's version");
  assert.equal(s.body, "First comment\n\nSecond comment", "both comments, book order, a blank line between");
  assert.equal(s.title, "First comment", "title is the joined comment's first non-empty line");
  assert.deepEqual(s.about, [
    {
      kind: "book",
      id: ID,
      place: { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 17 } },
      quote: { exact: "Hello there world", prefix: "", suffix: "" },
    },
  ]);
  assert.deepEqual(discarded, [{ type: "note.discarded", id: "n2" }], "the other is discarded");
  assert.equal(ctx(actor).merge, null, "the merge plan is cleared");
});

test("a drag that extends one highlight grows it, discarding nothing", async () => {
  const { actor, saved, discarded } = await openMerge([
    fullNote("n1", P_HELLO, { title: "A note", body: "A note", version: 2 }),
  ]);
  // From inside "Hello" out into "there": the snapped range extends past the highlight.
  actor.send({ type: "_highlight", start: { block: 0, offset: 2 }, end: { block: 0, offset: 8 }, texts: HL_TEXTS });
  await flush();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, "n1");
  assert.equal(saved[0].body, "A note", "its own comment is kept");
  assert.deepEqual(saved[0].about[0].place, { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 11 } });
  assert.deepEqual(discarded, [], "nothing discarded when one highlight simply grows");
});

test("a merge keeps the survivor's other links and only re-places its book link", async () => {
  const other = { kind: "note", id: "01ARZ3NDEKTSV4RRFFQ69G5X99" };
  const { actor, saved } = await openMerge([
    fullNote("n1", P_HELLO, { title: "First", body: "First", version: 1, extra: [other] }),
    fullNote("n2", P_WORLD, { title: "", body: "", version: 1 }),
  ]);
  actor.send({ type: "_highlight", start: { block: 0, offset: 2 }, end: { block: 0, offset: 14 }, texts: HL_TEXTS });
  await flush();
  assert.equal(saved.length, 1);
  assert.ok(saved[0].about.some((l) => l.kind === "note" && l.id === other.id), "the note link survives the merge");
  assert.equal(saved[0].body, "First", "a bare highlight adds no comment");
});

test("a drag entirely inside one highlight makes nothing (no merge, no save)", async () => {
  const { actor, saved, discarded } = await openMerge([fullNote("n1", P_HELLO, { title: "A", body: "A", version: 1 })]);
  // Inside "Hello", within [0,5]: snaps back onto it, wholly contained.
  actor.send({ type: "_highlight", start: { block: 0, offset: 1 }, end: { block: 0, offset: 3 }, texts: HL_TEXTS });
  await flush();
  assert.deepEqual(saved, []);
  assert.deepEqual(discarded, []);
  assert.equal(ctx(actor).merge, null);
});

// --- The bubble: reveal a contained highlight, remove with undo (session 3) ---------
//
// A drag inside an existing highlight opens its bubble instead of making a note; the
// bubble's Remove is the same delayed delete as note-list, driven here with a
// SimulatedClock. All decisions are the actor's; the bubble's placement is the view's
// (page.test.mjs).

const UNDO_MS = 3000;

// Open a book highlighting, with an undo window and a note.discarded collector.
async function openRemove({ notes = [] } = {}) {
  const clock = new SimulatedClock();
  const ask = (target, name) => {
    if (target === "notes" && name === "list") return Promise.resolve({ notes });
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "read") return Promise.resolve(bookReply());
    if (name === "chapter") return Promise.resolve({ title: "t", html: "<p>x</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask, mint: () => HL_ID, highlighting: true, undoMs: UNDO_MS }, clock });
  const discarded = [];
  actor.on("note.discarded", (e) => discarded.push(e));
  actor.start();
  await flush();
  actor.send({ type: "book.opened", id: ID });
  await flush();
  return { actor, discarded, clock };
}

test("a drag wholly inside a highlight reveals its bubble instead of making a note", async () => {
  const { actor, saved } = await openHL({ notes: [highlightNote("n1", PLACE_HELLO)] });
  assert.equal(ctx(actor).reveal, null, "no reveal before any drag");
  // Inside "Hello" ([0,5]): snaps back onto it, wholly contained.
  actor.send({ type: "_highlight", start: { block: 0, offset: 1 }, end: { block: 0, offset: 3 }, texts: HL_TEXTS });
  await flush();
  assert.deepEqual(saved, [], "no new note is made");
  assert.equal(ctx(actor).reveal?.id, "n1", "the contained highlight is revealed to the view");
  const first = ctx(actor).reveal.n;
  // A second such drag bumps the nonce, so the view acts on it again.
  actor.send({ type: "_highlight", start: { block: 0, offset: 2 }, end: { block: 0, offset: 4 }, texts: HL_TEXTS });
  await flush();
  assert.equal(ctx(actor).reveal.n, first + 1, "the nonce advances so the view re-opens the bubble");
});

test("_remove starts the undo window and only its elapse discards the highlight", async () => {
  const { actor, discarded, clock } = await openRemove({ notes: [highlightNote("n1", PLACE_HELLO)] });
  actor.send({ type: "_remove", id: "n1" });
  await flush();
  assert.ok(ctx(actor).discarding.has("n1"), "the highlight is counting down");
  clock.increment(UNDO_MS - 1);
  await flush();
  assert.deepEqual(discarded, [], "nothing is discarded before the window closes");
  clock.increment(1);
  await flush();
  assert.deepEqual(discarded, [{ type: "note.discarded", id: "n1" }], "the removal is a fact once the window ends");
  assert.ok(!ctx(actor).discarding.has("n1"), "the countdown is cleared");
});

test("_undo cancels the window; an undone removal never becomes a fact", async () => {
  const { actor, discarded, clock } = await openRemove({ notes: [highlightNote("n1", PLACE_HELLO)] });
  actor.send({ type: "_remove", id: "n1" });
  await flush();
  actor.send({ type: "_undo", id: "n1" });
  await flush();
  assert.ok(!ctx(actor).discarding.has("n1"), "the countdown is cancelled");
  clock.increment(UNDO_MS * 2);
  await flush();
  assert.deepEqual(discarded, [], "nothing is discarded after an undo");
});

test("a second _remove while counting down is a no-op (one discard, not two)", async () => {
  const { actor, discarded, clock } = await openRemove({ notes: [highlightNote("n1", PLACE_HELLO)] });
  actor.send({ type: "_remove", id: "n1" });
  await flush();
  actor.send({ type: "_remove", id: "n1" });
  await flush();
  clock.increment(UNDO_MS);
  await flush();
  assert.deepEqual(discarded, [{ type: "note.discarded", id: "n1" }], "the second remove did not schedule a second discard");
});

test("note.deleted clears a standing countdown and its timer for that id", async () => {
  const { actor, discarded, clock } = await openRemove({ notes: [highlightNote("n1", PLACE_HELLO)] });
  actor.send({ type: "_remove", id: "n1" });
  await flush();
  // The fact confirms the delete (another device, or this one's own elapse): the
  // countdown is cleared and its timer cancelled, so no second discard fires.
  actor.send({ type: "note.deleted", id: "n1" });
  await flush();
  assert.ok(!ctx(actor).discarding.has("n1"), "the countdown is cleared");
  assert.deepEqual(ctx(actor).highlights, [], "the highlight is gone");
  clock.increment(UNDO_MS * 2);
  await flush();
  assert.deepEqual(discarded, [], "no discard fires after the fact already removed it");
});

test("a chapter turn during the undo window does not cancel the removal", async () => {
  const { actor, discarded, clock } = await openRemove({ notes: [highlightNote("n1", PLACE_HELLO)] });
  actor.send({ type: "_remove", id: "n1" });
  await flush();
  // Turn into the next chapter mid-window (reading.ready → fetching → ready): the delayed
  // removal must survive the substate change.
  actor.send({ type: "_next" });
  await flush();
  assert.ok(actor.getSnapshot().matches({ reading: "ready" }), `expected reading.ready, got ${JSON.stringify(state(actor))}`);
  clock.increment(UNDO_MS);
  await flush();
  assert.deepEqual(discarded, [{ type: "note.discarded", id: "n1" }], "the removal fired despite the chapter turn");
});

// --- Re-anchoring after a re-import (session 7) -------------------------------------
//
// locate is pure text-finding, checked first: from the quote a highlight kept, it finds the
// passage again in a chapter whose blocks may have shifted under a new content version. Then
// the whole exchange with a fake `ask`: the view hands the corrected places (_reanchor), the
// reader adopts them at once and reads, then re-saves each note with its book link re-placed.

test("locate keeps the old coordinates when the text there still matches", () => {
  const link = { place: { chapter: 0, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } }, quote: { exact: "Hello", prefix: "", suffix: " there world" } };
  assert.deepEqual(locate(["Hello there world"], link, true), { start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } });
});

test("locate finds the quote again when a re-import shifted the blocks", () => {
  // A block was prepended, so the old coordinates point past nothing; the quote is found
  // in its new block, its surroundings confirming the match.
  const link = {
    place: { chapter: 0, start: { block: 0, offset: 6 }, end: { block: 0, offset: 11 } },
    quote: { exact: "there", prefix: "Hello ", suffix: " world" },
  };
  assert.deepEqual(locate(["Intro", "Hello there world"], link, true), {
    start: { block: 1, offset: 6 },
    end: { block: 1, offset: 11 },
  });
});

test("locate follows a cross-block quote through the shift", () => {
  const link = {
    place: { chapter: 0, start: { block: 0, offset: 4 }, end: { block: 1, offset: 5 } },
    quote: { exact: "two\nthree", prefix: "one ", suffix: " four" },
  };
  assert.deepEqual(locate(["intro", "one two", "three four"], link, true), {
    start: { block: 1, offset: 4 },
    end: { block: 2, offset: 5 },
  });
});

test("locate prefers a match whose surroundings match over the nearest one", () => {
  // The old coordinates no longer hold the quote (they point at "here"), so the exact text
  // is searched for: the first "word" is nearer the old start, but the second's surroundings
  // match the kept prefix and suffix, so it wins.
  const link = {
    place: { chapter: 0, start: { block: 0, offset: 5 }, end: { block: 0, offset: 9 } },
    quote: { exact: "word", prefix: "the ", suffix: " gone" },
  };
  assert.deepEqual(locate(["word here", "the word gone"], link, true), {
    start: { block: 1, offset: 4 },
    end: { block: 1, offset: 8 },
  });
});

test("locate falls back to the nearest match when none has matching surroundings", () => {
  const link = {
    // The old coordinates run past the shortened chapter, so the exact text is searched
    // for; neither "cat" has the kept surroundings, so the one nearest the old start wins.
    place: { chapter: 0, start: { block: 0, offset: 8 }, end: { block: 0, offset: 30 } },
    quote: { exact: "cat", prefix: "ZZZ", suffix: "!!!" },
  };
  assert.deepEqual(locate(["cat dog cat"], link, true), {
    start: { block: 0, offset: 8 },
    end: { block: 0, offset: 11 },
  });
});

test("locate in another chapter takes only a single full-context match", () => {
  const link = {
    place: { chapter: 9, start: { block: 5, offset: 0 }, end: { block: 5, offset: 5 } },
    quote: { exact: "there", prefix: "Hello ", suffix: " world" },
  };
  // A single match whose surroundings match is accepted across chapters.
  assert.deepEqual(locate(["Hello there world"], link, false), {
    start: { block: 0, offset: 6 },
    end: { block: 0, offset: 11 },
  });
  // A match whose surroundings do not match is refused across chapters.
  assert.equal(locate(["there is a thing"], link, false), null);
  // Two full-context matches are ambiguous across chapters, so neither is taken.
  assert.equal(locate(["Hello there world", "Hello there world"], link, false), null);
});

test("locate returns null when the quote is gone", () => {
  const link = {
    place: { chapter: 0, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } },
    quote: { exact: "there", prefix: "", suffix: "" },
  };
  assert.equal(locate(["nothing here"], link, true), null);
});

// A stale highlight (its place counted in content version 1) while the book is at 2, plus a
// notes: read that answers with the whole note, so the re-anchor can read and re-save it.
const NEW_PLACE = { chapter: 2, contentVersion: 2, start: { block: 1, offset: 3 }, end: { block: 1, offset: 8 } };

async function openReanchor(notes) {
  const clock = new SimulatedClock();
  const byId = Object.fromEntries(notes.map((n) => [n.id, n]));
  const ask = (target, name, payload) => {
    if (target === "notes" && name === "list")
      return Promise.resolve({ notes: notes.map(({ id, title, about }) => ({ id, title, about })) });
    if (target === "notes" && name === "read")
      return Promise.resolve(byId[payload.id] ? { note: byId[payload.id] } : { error: "not-found" });
    if (name === "open") return Promise.resolve({ id: null });
    if (name === "read") return Promise.resolve(bookReply({ contentVersion: 2 }));
    if (name === "chapter") return Promise.resolve({ title: "t", html: "<p>x</p>" });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask, mint: () => HL_ID, highlighting: true }, clock });
  const saved = [];
  actor.on("note.saved", (e) => saved.push(e));
  actor.start();
  await flush();
  actor.send({ type: "book.opened", id: ID });
  await flush();
  return { actor, saved };
}

test("_reanchor adopts the corrected place at once and re-saves the note", async () => {
  const { actor, saved } = await openReanchor([
    fullNote("n1", { chapter: 0, contentVersion: 1, start: { block: 0, offset: 0 }, end: { block: 0, offset: 5 } }, { title: "A note", body: "A comment", version: 4 }),
  ]);
  actor.send({ type: "_reanchor", items: [{ id: "n1", place: NEW_PLACE }] });
  // The place is adopted before the save so the mark paints in the current version at once.
  assert.deepEqual(ctx(actor).highlights[0].place, NEW_PLACE, "the corrected place is adopted immediately");
  await flush();
  assert.equal(saved.length, 1, "the note is re-saved once");
  const s = saved[0];
  assert.equal(s.id, "n1");
  assert.equal(s.title, "A note", "the same title");
  assert.equal(s.body, "A comment", "the same body");
  assert.equal(s.baseVersion, 4, "saved on the note's version");
  assert.deepEqual(s.about[0].place, NEW_PLACE, "only the book link's place is replaced");
  assert.deepEqual(s.about[0].quote, { exact: "x", prefix: "", suffix: "" }, "the kept quote is unchanged");
  assert.equal(ctx(actor).reanchor, null, "the plan is cleared");
  assert.ok(actor.getSnapshot().matches({ reading: "ready" }));
});

test("_reanchor keeps a note the read cannot find from being re-saved", async () => {
  const { actor, saved } = await openReanchor([]); // notes: read answers not-found
  actor.send({ type: "_reanchor", items: [{ id: "gone", place: NEW_PLACE }] });
  await flush();
  assert.deepEqual(saved, [], "a note that cannot be read is not re-saved");
  assert.equal(ctx(actor).reanchor, null);
  assert.ok(actor.getSnapshot().matches({ reading: "ready" }));
});

// The "Vim keys" preference (12): asked of settings at start, followed after.
const VIM_INPUT = { mint: () => "01ARZ3NDEKTSV4RRFFQ69G5FZZ", undoMs: 100, highlighting: false };
const vimAsk = (reply) => (target, name) =>
  Promise.resolve(target === "settings" && name === "read" ? reply : {});
const vimActor = (reply) => createActor(machine, { input: { ...VIM_INPUT, ask: vimAsk(reply) } }).start();
const vimSettle = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
};

test("Vim keys start from settings: read, and are off until it answers", async () => {
  const actor = vimActor({ vimKeys: true, profile: "workshop" });
  assert.equal(actor.getSnapshot().context.vimKeys, false, "off before the reply");
  await vimSettle();
  assert.equal(actor.getSnapshot().context.vimKeys, true);
});

test("Vim keys follow settings.changed, in any state, and never move the view", async () => {
  const actor = vimActor({ vimKeys: false });
  await vimSettle();
  const before = actor.getSnapshot().value;
  actor.send({ type: "settings.changed", vimKeys: true });
  assert.equal(actor.getSnapshot().context.vimKeys, true);
  actor.send({ type: "settings.changed", vimKeys: false });
  assert.equal(actor.getSnapshot().context.vimKeys, false);
  assert.deepEqual(actor.getSnapshot().value, before);
});

test("an error reply, or a reply without the field, leaves Vim keys off", async () => {
  for (const reply of [{ error: "no-answerer" }, { profile: "product" }]) {
    const actor = vimActor(reply);
    await vimSettle();
    assert.equal(actor.getSnapshot().context.vimKeys, false, JSON.stringify(reply));
  }
});

// The reader's Vim cursor motions (12, "Vim keys"): where w, b, ), (, } and {
// land is decided on the block texts, so it is checked here; the line motions need the
// page and are the browser's. A figure is a block with no text; a book's raw white space
// (a newline and indent between inline elements) shows as one space.
test("the Vim cursor's motions land on shown characters across blocks", () => {
  const texts = ["Chapter One", "", "A short opening.  It ends\n   here! Then more.", "Last block"];
  const ch = chapterText(texts);
  const at = (block, offset) => indexOf(ch, { block, offset });
  const go = (i, ...keys) => keys.reduce((k, key) => step(ch, k, key), i);
  const where = (i) => pointAt(ch, i);
  // w and b by word, across the empty block.
  assert.deepEqual(where(go(at(0, 0), "w")), { block: 0, offset: 8 });
  assert.deepEqual(where(go(at(0, 0), "w", "w")), { block: 2, offset: 0 });
  assert.deepEqual(where(go(at(2, 4), "b")), { block: 2, offset: 2 });
  assert.deepEqual(where(go(at(2, 2), "b")), { block: 2, offset: 0 });
  assert.deepEqual(where(go(at(2, 0), "b")), { block: 0, offset: 8 });
  // ) and ( by sentence: after a stop and white space, or at a block's start.
  assert.deepEqual(where(go(at(2, 0), ")")), { block: 2, offset: 18 });
  assert.deepEqual(where(go(at(2, 18), ")")), { block: 2, offset: 35 });
  assert.deepEqual(where(go(at(2, 35), ")")), { block: 3, offset: 0 });
  assert.deepEqual(where(go(at(2, 20), "(")), { block: 2, offset: 18 });
  assert.deepEqual(where(go(at(2, 18), "(")), { block: 2, offset: 0 });
  // } to a block's last character and { to its first, skipping the figure; from an end
  // or a start, on to the next one. } never lands on the next block's first letter, so a
  // highlight begun there stays in its paragraph.
  assert.deepEqual(where(go(at(0, 3), "}")), { block: 0, offset: 10 });
  assert.deepEqual(where(go(at(0, 10), "}")), { block: 2, offset: 44 });
  assert.deepEqual(where(go(at(2, 5), "{")), { block: 2, offset: 0 });
  assert.deepEqual(where(go(at(2, 0), "{")), { block: 0, offset: 0 });
  // One character at a time, as the line motions walk: a run of white space is the one
  // space it collapses to, and the walk crosses blocks and stops at the chapter's ends.
  assert.deepEqual(where(charStep(ch, at(2, 15), 1)), { block: 2, offset: 16 });
  assert.deepEqual(where(charStep(ch, at(2, 16), 1)), { block: 2, offset: 18 });
  assert.deepEqual(where(charStep(ch, at(2, 18), -1)), { block: 2, offset: 16 });
  assert.deepEqual(where(charStep(ch, at(0, 10), 1)), { block: 2, offset: 0 });
  assert.deepEqual(where(charStep(ch, at(3, 9), 1)), { block: 3, offset: 9 });
  assert.deepEqual(where(charStep(ch, at(0, 0), -1)), { block: 0, offset: 0 });
  // The chapter's edges hold: past the last block is its last character, before the first
  // is the first.
  assert.deepEqual(where(go(at(3, 5), "}")), { block: 3, offset: 9 });
  assert.deepEqual(where(go(at(3, 9), "w", "}", ")")), { block: 3, offset: 9 });
  assert.deepEqual(where(go(at(0, 0), "b", "{", "(")), { block: 0, offset: 0 });
  // The cursor starts on the first shown character at or after the page's anchor, past a
  // figure.
  assert.deepEqual(where(nearest(ch, at(1, 0))), { block: 2, offset: 0 });
  // An exclusive end just after a block's last character is that block's end.
  assert.deepEqual(where(at(0, 10) + 1), { block: 0, offset: 11 });
  // h and l are no motion of their own: the view moves the cursor by charStep, checked
  // above (12, "Vim keys").
  assert.ok(isMotion("w") && isMotion("}") && !isMotion("j") && !isMotion("Enter") && !isMotion("h") && !isMotion("l"));
});

// A keyboard highlight is the same _highlight message the mouse sends. The cursor is
// where the next key acts, so a forward motion that lands on the start of the next word
// or sentence stops the passage before it: v w w covers two whole words, v ) one
// sentence. Moving back, the cursor's own character opens the passage.
test("the passage v covers ends before the word the cursor moved onto", () => {
  const texts = ["Chapter One", "A short opening chapter, one page long. It links."];
  const ch = chapterText(texts);
  const at = (block, offset) => indexOf(ch, { block, offset });
  const text = ([from, to]) => ch.flat.slice(from, to).replaceAll("\u0000", "|");
  const at2 = (block, offset) => ({ block, offset });
  const start = at(1, 2);
  assert.equal(text(passage(ch, start, start)), "s");
  assert.equal(text(passage(ch, start, step(ch, step(ch, start, "w"), "w"))), "short opening");
  assert.equal(text(passage(ch, at(1, 0), step(ch, at(1, 0), ")"))), "A short opening chapter, one page long.");
  // Across blocks, the separator and the next block's first word stay out.
  assert.equal(text(passage(ch, at(0, 8), step(ch, at(0, 8), "w"))), "One");
  // Backwards: from the cursor's character to where v was pressed.
  assert.equal(text(passage(ch, at(1, 4), step(ch, at(1, 4), "b"))), "sho");
  // } ends on the paragraph's last character, which is kept.
  assert.equal(text(passage(ch, at(1, 40), step(ch, at(1, 40), "}"))), "It links.");
  // A cursor moved by a letter (h, l) keeps its own character, onto a word's start too.
  assert.equal(text(passage(ch, start, start + 3, true)), "shor");
  assert.equal(text(passage(ch, at(1, 2), at(1, 8), true)), "short o");
  assert.equal(text(passage(ch, at(1, 2), at(1, 8))), "short");
  assert.equal(text(passage(ch, at(1, 4), at(1, 2), true)), "sho");
  // A keyboard highlight is marked as painted, not grown to whole words as a drag is.
  assert.deepEqual(snapToWords(texts, { start: at2(1, 2), end: at2(1, 6) }, { grow: false }), { start: at2(1, 2), end: at2(1, 6) });
  assert.deepEqual(snapToWords(texts, { start: at2(1, 2), end: at2(1, 6) }), { start: at2(1, 2), end: at2(1, 7) });
  const range = snapToWords(texts, { start: pointAt(ch, start), end: pointAt(ch, passage(ch, start, start + 3)[1]) });
  assert.equal(quoteOf(texts, range).exact, "short");
});

// --- Copy link: the stored form of a source link, and when it is announced -----------

test("linkLabel keeps a short quote whole, on one line", () => {
  assert.equal(linkLabel("Hello there"), "Hello there");
  assert.equal(linkLabel("  Hello\nthere  "), "Hello there");
});

test("linkLabel cuts a long quote at a word, at most 40 characters, with an ellipsis", () => {
  const label = linkLabel("The quick brown fox jumps over the lazy dog and keeps running far away");
  assert.equal(label, "The quick brown fox jumps over the lazy…");
  assert.ok(label.length - 1 <= 40);
});

test("linkLabel cuts a single word longer than the limit inside it", () => {
  assert.equal(linkLabel("x".repeat(50)), "x".repeat(40) + "…");
});

test("linkLabel escapes brackets and backslashes so the label cannot end the link", () => {
  assert.equal(linkLabel("a [b] c\\d"), "a \\[b\\] c\\\\d");
});

test("sourceLink is the label and the highlight's id in the stored form", () => {
  assert.equal(sourceLink(HL_ID, { exact: "Hello there" }), "[Hello there](note:" + HL_ID + ")");
});

test("highlightAt finds the highlight of the chapter holding a point, end exclusive", () => {
  const hs = [{ id: "n1", place: PLACE_HELLO }, { id: "n2", place: { ...PLACE_HELLO, chapter: 1 } }];
  assert.equal(highlightAt(hs, 0, { block: 0, offset: 0 })?.id, "n1");
  assert.equal(highlightAt(hs, 0, { block: 0, offset: 4 })?.id, "n1");
  assert.equal(highlightAt(hs, 0, { block: 0, offset: 5 }), undefined);
  assert.equal(highlightAt(hs, 1, { block: 0, offset: 2 })?.id, "n2");
  assert.equal(highlightAt(hs, 2, { block: 0, offset: 2 }), undefined);
});

test("_copyLink announces link.copied with the stored link; an unknown id announces nothing", async () => {
  const note = { id: HL_ID, title: "", about: [{ kind: "book", id: ID, place: PLACE_HELLO, quote: { exact: "Hello", prefix: "", suffix: "" } }] };
  const { actor } = await openHL({ notes: [note] });
  const copied = [];
  actor.on("link.copied", (e) => copied.push(e));
  actor.send({ type: "_copyLink", id: "01ARZ3NDEKTSV4RRFFQ69G5H99" });
  actor.send({ type: "_copyLink", id: HL_ID });
  await flush();
  assert.deepEqual(copied, [{ type: "link.copied", id: HL_ID, text: "[Hello](note:" + HL_ID + ")" }]);
});
