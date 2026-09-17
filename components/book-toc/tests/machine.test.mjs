import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor } from "xstate";
import { machine } from "../machine.js";

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
