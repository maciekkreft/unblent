import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine, markedChapter } from "../machine.js";

// The actor is where the contents' decisions live (3.2): which book it shows, and the
// chapter it marks. The mark is the chapter the user just chose (a jump the fact has
// not confirmed) or, once the fact moves, the saved position. It is driven here with a
// fake `ask` so the logic is checked without a browser; the paint is the view's, tested
// in page.test.mjs.

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ID2 = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await tick();
};

// A book the read reply and book.changed both carry whole (7.1, 4.3 third rule).
const book = (over = {}) => ({
  id: ID,
  title: "T",
  author: "A",
  toc: [{ title: "One", chapter: 0 }, { title: "Two", chapter: 1 }, { title: "Three", chapter: 2 }],
  position: { chapter: 0, block: 0 },
  version: 1,
  ...over,
});

const changed = (over = {}) => ({ type: "book.changed", ...book(over) });

function start({ read, open } = {}) {
  const ask = (target, name) => {
    if (name === "open") return Promise.resolve(open ?? { id: null });
    if (name === "read") return Promise.resolve(read ?? { book: book() });
    return Promise.resolve({});
  };
  const actor = createActor(machine, { input: { ask } });
  const selected = [];
  actor.on("chapter.selected", (e) => selected.push(e));
  actor.start();
  return { actor, selected };
}

// Open a book and settle in showing, as book-shelf's selection does (4.3, fourth rule).
async function open(opts) {
  const h = start(opts);
  await flush();
  h.actor.send({ type: "book.opened", id: ID });
  await flush();
  return h;
}

const ctx = (actor) => actor.getSnapshot().context;

test("choosing a chapter marks it at once and announces it", async () => {
  const { actor, selected } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  assert.equal(ctx(actor).jump, 2, "the chosen chapter is marked before the fact confirms");
  assert.deepEqual(selected, [{ type: "chapter.selected", id: ID, chapter: 2 }]);
});

test("choosing the current chapter holds no jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 0 });
  await flush();
  assert.equal(ctx(actor).jump, null, "the already-current chapter has nothing to confirm");
});

test("an ack that does not move the chapter keeps the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  // An echo of an earlier turn: the position's chapter is still 0, so the mark must not
  // flick back off the chosen chapter.
  actor.send(changed({ position: { chapter: 0, block: 7 } }));
  await flush();
  assert.equal(ctx(actor).jump, 2, "the jump survives an unrelated book.changed");
});

test("the fact confirming the jump clears it", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  actor.send(changed({ position: { chapter: 2, block: 0 } }));
  await flush();
  assert.equal(ctx(actor).jump, null, "the fact reached the chosen chapter");
  assert.equal(ctx(actor).book.chapter, 2, "the mark now rides the saved position");
});

test("a move to another chapter clears the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  // Another device turned elsewhere before the jump landed: the newer move wins.
  actor.send(changed({ position: { chapter: 1, block: 0 } }));
  await flush();
  assert.equal(ctx(actor).jump, null);
  assert.equal(ctx(actor).book.chapter, 1);
});

test("switching books clears the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  actor.send({ type: "book.opened", id: null });
  await flush();
  assert.equal(ctx(actor).jump, null, "a switch drops the pending jump");
});

test("deletion clears the jump", async () => {
  const { actor } = await open();
  actor.send({ type: "_select", id: ID, chapter: 2 });
  await flush();
  actor.send({ type: "book.deleted", id: ID });
  await flush();
  assert.equal(ctx(actor).jump, null);
});

// A publisher's contents rarely lists every piece, so the entry to mark is the one at
// or before the chapter being read, not only its exact match (A).
test("markedChapter marks the entry the chapter belongs to", () => {
  const toc = [
    { title: "Cover", chapter: 0 },
    { title: "Part", chapter: 3, children: [{ title: "One", chapter: 4 }, { title: "Two", chapter: 6 }] },
    { title: "End", chapter: 9 },
  ];
  assert.equal(markedChapter(toc, 4), 4, "an exact listed chapter marks itself");
  assert.equal(markedChapter(toc, 2), 0, "an unlisted piece marks the entry before it");
  assert.equal(markedChapter(toc, 5), 4, "a nested child wins over its parent");
  assert.equal(markedChapter(toc, 12), 9, "past the last entry the last entry stays lit");
  assert.equal(markedChapter(toc, 0), 0, "the first entry marks itself");
});

test("markedChapter marks nothing before the first entry", () => {
  assert.equal(markedChapter([{ title: "Intro", chapter: 2 }], 1), null);
  assert.equal(markedChapter([], 0), null, "an empty tree marks nothing");
});

// The "Vim keys" preference (12): asked of settings at start, followed after.
const VIM_INPUT = {};
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
