import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, SimulatedClock } from "xstate";
import { machine } from "../machine.js";

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
  const { actor } = await open();
  // Record where this reader last settled.
  actor.send({ type: "_settled", chapter: 0, block: 0 });
  await flush();

  // The echo of that place (same position, newer version) only refreshes metadata.
  actor.send(changedEvent({ version: 2, position: { chapter: 0, block: 0 } }));
  await flush();
  assert.equal(ctx(actor).chapter, 0, "the echo does not move the reader");
  assert.equal(ctx(actor).book.version, 2, "but the metadata is adopted");

  // A newer version at a different place in another chapter moves and re-fetches.
  actor.send(changedEvent({ version: 3, position: { chapter: 2, block: 1 } }));
  await flush();
  assert.equal(ctx(actor).chapter, 2, "adopts the other device's chapter");
  assert.deepEqual(ctx(actor).pending, { chapter: 2, block: 1 });
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
